import { describe, expect, jest, test } from "@jest/globals";
import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { CommunicationChannelOwnerUnavailableError } from "@mcp-moira/workflow-engine";
import { redeemProgressImage } from "../../../packages/web-backend/src/routes/execution-progress-image.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

function response(mode: "finish" | "close" | "throw") {
  const chunks: Buffer[] = [];
  const emitter = new Writable({
    write(chunk, _encoding, done) {
      if (mode === "throw") return done(new Error("write failed"));
      if (mode === "close") {
        this.destroy(new Error("client disconnected"));
        return done();
      }
      chunks.push(Buffer.from(chunk));
      done();
    },
  }) as any;
  emitter.status = jest.fn(() => emitter);
  emitter.json = jest.fn();
  emitter.setHeader = jest.fn();
  return { response: emitter, chunks };
}

describe("progress image HTTP completion lifecycle", () => {
  test.each(["redeem", "open"] as const)(
    "an unavailable owner during %s returns operational 503 without consuming the image grant",
    async (stage) => {
      let consumed = false;
      let released = false;
      const failure = new CommunicationChannelOwnerUnavailableError();
      const service = {
        async redeem() {
          if (stage === "redeem") throw failure;
          return {
            referenceId: "owner-file://controller/device/token",
            claimId: "claim",
            userId: "owner",
          };
        },
        async open() {
          throw failure;
        },
        complete() {
          consumed = true;
          return true;
        },
        release() {
          released = true;
          return true;
        },
      } as unknown as Parameters<typeof redeemProgressImage>[3];
      const app = express();
      app.get("/:token", (req, res, next) => redeemProgressImage(req, res, next, service));
      app.use(setupErrorMiddleware());
      const result = await request(app).get("/opaque-progress-token");
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({
        success: false,
        error: {
          code: "COMMUNICATION_OWNER_UNAVAILABLE",
          message: expect.stringContaining("Connect the paired controller"),
        },
      });
      expect(result.headers["x-error-code"]).toBe("COMMUNICATION_OWNER_UNAVAILABLE");
      expect(consumed).toBe(false);
      expect(released).toBe(stage === "open");
    },
  );

  test.each([
    ["finish", "consumed", 0, Buffer.from("png")],
    ["close", "available", 1, Buffer.alloc(0)],
    ["throw", "available", 1, Buffer.alloc(0)],
  ] as const)(
    "%s commits only a finished response",
    async (mode, expectedState, failures, bytes) => {
      let state = "claimed";
      const service = {
        redeem: async () => ({
          referenceId: "owner-file://controller/device/token",
          claimId: "claim",
          userId: "owner",
        }),
        open: async () => ({
          body: (async function* () {
            yield Buffer.from("png");
          })(),
        }),
        complete: () => {
          if (state === "claimed") state = "consumed";
          return true;
        },
        release: () => {
          if (state === "claimed") state = "available";
          return true;
        },
      } as any;
      const res = response(mode);
      const next = jest.fn();
      await redeemProgressImage({ params: { token: "token" } } as any, res.response, next, service);
      expect(state).toBe(expectedState);
      expect(Buffer.concat(res.chunks)).toEqual(bytes);
      expect(next).toHaveBeenCalledTimes(failures);
    },
  );
});
