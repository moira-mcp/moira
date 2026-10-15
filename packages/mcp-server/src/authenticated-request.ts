import type { Request, Response } from "express";
import { isJsonContentType } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import { readJsonBody } from "../../workspace-service/src/request-body.mjs";
import { settleOwnerFrame } from "../../workspace-service/src/stream-frame.mjs";

/** Authenticate before reading controls; the SDK retains media-type and JSON-RPC validation. */
export async function readAuthenticatedMcpRequest<Principal>(
  req: Request,
  res: Response,
  authenticate: (req: Request, res: Response) => Promise<Principal | null>,
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
      req.body = await readJsonBody(req);
    } catch {
      settleOwnerFrame(req, res);
      if (!res.destroyed)
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" },
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
