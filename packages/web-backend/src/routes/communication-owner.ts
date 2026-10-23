import { Router } from "express";
import {
  communicationOwnerScopeSchema,
  communicationOwnerSendSchema,
  type CommunicationOwnerScope,
} from "@mcp-moira/shared";
import type { CommunicationOwnerTransport } from "../services/communication-owner-transport.js";
import {
  OWNER_STREAM_CONTENT_TYPE,
  readOwnerFrame,
  settleOwnerFrame,
} from "@mcp-moira/shared/http/owner-stream-frame";
import { readOwnerJsonBody } from "@mcp-moira/shared/http/request-body";

/** Private actor endpoint: source bytes are opaque and never pass through a JSON body parser. */
export function createCommunicationOwnerRoutes(service: CommunicationOwnerTransport): Router {
  const router = Router();
  const bearer = (authorization?: string) => {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!match) throw new Error("actor_refused");
    return match[1]!;
  };
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  router.post("/send", (req, res) => {
    let frame: Awaited<ReturnType<typeof readOwnerFrame>> | undefined;
    void (async () => {
      const credential = bearer(req.get("authorization"));
      try {
        await service.authenticate(credential);
      } catch {
        settleOwnerFrame(req, res);
        res.status(403).json({ status: "refused", reason: "owner_unauthorized" });
        return;
      }
      if (req.get("content-type") !== OWNER_STREAM_CONTENT_TYPE)
        throw new Error("source_framing_invalid");
      frame = await readOwnerFrame(req);
      const input = communicationOwnerSendSchema.parse(frame.control);
      if (req.get("content-length") !== String(frame.prefixLength + input.file.size))
        throw new Error("source_framing_invalid");
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("aborted", abort);
      res.once("close", abort);
      try {
        const result = await service.send(credential, input, frame.body, controller.signal);
        settleOwnerFrame(req, res, frame);
        if (!res.destroyed) res.json(result);
      } finally {
        req.off("aborted", abort);
        res.off("close", abort);
      }
    })()
      .catch(() => {
        settleOwnerFrame(req, res, frame);
        if (!res.headersSent && !res.destroyed)
          res.status(400).json({ status: "refused", reason: "delivery_not_admitted" });
      })
      .finally(() => settleOwnerFrame(req, res, frame));
  });
  router.post("/prepare", (req, res) => {
    void (async () => {
      const credential = bearer(req.get("authorization"));
      await service.authenticate(credential);
      if (!req.is("application/json"))
        throw Object.assign(new Error("INVALID_JSON"), { publicCode: "INVALID_JSON" });
      return service.prepare(credential, await readOwnerJsonBody(req));
    })()
      .then((result) => res.json(result))
      .catch((error: unknown) => {
        settleOwnerFrame(req, res);
        const invalid =
          error instanceof Error && "publicCode" in error && error.publicCode === "INVALID_JSON";
        res.status(invalid ? 400 : 403).json({
          error: {
            code: invalid ? "COMMUNICATION_REQUEST_INVALID" : "COMMUNICATION_AUTHORITY_REFUSED",
            message: invalid
              ? "Invalid communication preparation JSON."
              : "Channel or owner authority refused before delivery.",
          },
        });
      });
  });
  router.get("/artifacts/:channelId/:digest", (req, res) => {
    void (async () => {
      const scopeHeader = req.get("x-moira-communication-scope");
      if (!scopeHeader) throw new Error("scope_invalid");
      const scope: CommunicationOwnerScope = communicationOwnerScopeSchema.parse(
        JSON.parse(Buffer.from(scopeHeader, "base64url").toString("utf8")),
      );
      if (!/^[a-f0-9]{64}$/.test(req.params.digest)) throw new Error("digest_invalid");
      const bytes = await service.artifact(
        bearer(req.get("authorization")),
        scope,
        req.params.channelId,
        req.params.digest,
      );
      res.type("application/octet-stream").send(bytes);
    })().catch(() => {
      if (!res.headersSent)
        res.status(403).json({
          error: {
            code: "COMMUNICATION_ARTIFACT_REFUSED",
            message: "Installed channel artifact unavailable.",
          },
        });
    });
  });
  return router;
}
