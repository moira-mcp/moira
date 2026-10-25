import type { Request, Response } from "express";
import { isJsonContentType } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import { readJsonBody, RequestBodyLimitError } from "@mcp-moira/shared/http/request-body";
import { settleOwnerFrame } from "@mcp-moira/shared/http/owner-stream-frame";
import { getArtifactJsonBodyLimit } from "@mcp-moira/shared/artifact-size-policy";

/** Authenticate before reading controls; the SDK retains media-type and JSON-RPC validation. */
export async function readAuthenticatedMcpRequest<Principal>(
  req: Request,
  res: Response,
  authenticate: (req: Request, res: Response) => Promise<Principal | null>,
  getMaxArtifactBytes: (principal: Principal) => Promise<number>,
): Promise<Principal | null> {
  const authenticateCurrent = async () => {
    // A refusal must close an unread or partly observed body without retaining the socket.
    const previousConnection = res.getHeader("Connection");
    res.setHeader("Connection", "close");
    const principal = await authenticate(req, res);
    if (!principal) {
      settleOwnerFrame(req, res);
      return null;
    }
    if (previousConnection === undefined) res.removeHeader("Connection");
    else res.setHeader("Connection", previousConnection);
    return principal;
  };
  const principal = await authenticateCurrent();
  if (!principal) return null;
  if (isJsonContentType(req.get("content-type"))) {
    try {
      const maxBytes = Math.max(
        20 * 1024 * 1024,
        getArtifactJsonBodyLimit(await getMaxArtifactBytes(principal)),
      );
      req.body = await readJsonBody(req, { maxBytes });
    } catch (error) {
      settleOwnerFrame(req, res);
      if (
        !(error instanceof RequestBodyLimitError) &&
        !(
          error &&
          typeof error === "object" &&
          "publicCode" in error &&
          error.publicCode === "INVALID_JSON"
        )
      )
        throw error;
      if (!res.destroyed)
        res.status(error instanceof RequestBodyLimitError ? 413 : 400).json({
          jsonrpc: "2.0",
          error:
            error instanceof RequestBodyLimitError
              ? {
                  code: -32000,
                  message: "Request body exceeds the authenticated frame limit",
                  data: { limitBytes: error.limitBytes },
                }
              : { code: -32700, message: "Parse error: Invalid JSON" },
          id: null,
        });
      return null;
    }
    // Reading controls yields to credential/account changes. Initial body admission
    // cannot authorize a later effect after that authority has been revoked.
    return authenticateCurrent();
  }
  return principal;
}
