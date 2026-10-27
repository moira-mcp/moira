import type { RequestHandler } from "express";
import type { getWorkspaceClient } from "@mcp-moira/web-backend/services";
type WorkspaceClient = ReturnType<typeof getWorkspaceClient>;

const RESOURCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Route an owner-held immutable capability; no cloud object, hash or transfer receipt. */
export function createWorkspacePublicationHandler(dependencies: {
  authorize: (resourceId: string) => string | Promise<string>;
  workspace: Pick<WorkspaceClient, "request">;
  endpointIdentity?: (
    userId: string,
    resourceId: string,
  ) => { deviceGeneration: number; connectionId: string };
}): RequestHandler {
  return async (req, res) => {
    const resourceId = String(req.params.resourceId),
      token = String(req.params.token);
    let source: Awaited<ReturnType<WorkspaceClient["request"]>> | undefined;
    const cancellation = new AbortController();
    const close = () => {
      cancellation.abort();
      source?.body.destroy();
    };
    res.once("close", close);
    try {
      if (!RESOURCE.test(resourceId) || !TOKEN.test(token) || Object.keys(req.query).length)
        throw new Error("Publication route invalid");
      const userId = await dependencies.authorize(resourceId);
      source = await dependencies.workspace.request(
        userId,
        resourceId,
        {
          method: "GET",
          path: `/v1/publications/${token}`,
          headers: (() => {
            const identity = dependencies.endpointIdentity?.(userId, resourceId);
            return identity
              ? {
                  "x-moira-device-id": resourceId,
                  "x-moira-device-generation": String(identity.deviceGeneration),
                  "x-moira-connection-id": identity.connectionId,
                }
              : undefined;
          })(),
        },
        cancellation.signal,
      );
      if (source.statusCode !== 200) throw new Error("Publication owner refused");
      res.status(200);
      for (const name of [
        "content-type",
        "content-length",
        "content-disposition",
        "cache-control",
        "x-content-type-options",
        "x-robots-tag",
        "referrer-policy",
      ]) {
        const value = source.headers[name];
        if (typeof value === "string") res.setHeader(name, value);
      }
      source.body.once("error", () => res.destroy());
      source.body.pipe(res);
    } catch {
      source?.body.destroy();
      if (!res.headersSent) res.status(404).json({ error: "workspace_publication_unavailable" });
      else res.destroy();
    }
  };
}
