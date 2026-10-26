import { describe, expect, test } from "@jest/globals";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { gzipSync } from "node:zlib";
import {
  createArtifactSessionAdmission,
  readArtifactBody,
} from "../../../packages/web-backend/src/middleware/artifact-body.js";
import {
  asyncHandler,
  setupErrorMiddleware,
} from "../../../packages/web-backend/src/middleware/error-middleware.js";

function fixture(maxContentBytes = 1024, revokeDuringRead = false) {
  const app = express();
  const accepted: unknown[] = [];
  let admitted = false;
  const authenticate: RequestHandler = (req, res, next) => {
    if (req.get("authorization") !== "Bearer allowed" || (revokeDuringRead && admitted)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    admitted = true;
    Object.assign(req, { userId: "owner" });
    next();
  };
  app.use(
    "/artifacts",
    createArtifactSessionAdmission({ getMaxFileSize: async () => maxContentBytes }, authenticate),
  );
  app.post("/artifacts", (req, res) => {
    accepted.push(req.body);
    res.json(req.body);
  });
  app.post(
    "/upload",
    asyncHandler(async (req, res) => {
      if (!(await readArtifactBody(req, res, maxContentBytes, true))) return;
      accepted.push(req.file?.buffer.toString("utf8") ?? req.body);
      res.json({ size: req.file?.size, metadata: req.body });
    }),
  );
  app.use(express.json({ limit: "10mb" }));
  app.post("/ordinary", (req, res) => res.json(req.body));
  app.use(setupErrorMiddleware());
  return { app, accepted };
}

describe("artifact body admission", () => {
  test("session admission precedes JSON parsing and is repeated before mutation", async () => {
    const denied = fixture();
    expect((await request(denied.app).post("/artifacts").type("json").send('{"bad":')).status).toBe(
      401,
    );
    expect(denied.accepted).toEqual([]);
    const revoked = fixture(1024, true);
    const response = await request(revoked.app)
      .post("/artifacts")
      .set("authorization", "Bearer allowed")
      .send({ name: "a", content: "<html></html>" });
    expect(response.status).toBe(401);
    expect(revoked.accepted).toEqual([]);
  });

  test("escaped JSON uses the content-derived frame while oversized frames return the effective content limit", async () => {
    const { app, accepted } = fixture();
    const input = { name: "escaped", content: "\u0000".repeat(1024) };
    const response = await request(app)
      .post("/artifacts")
      .set("authorization", "Bearer allowed")
      .send(input);
    expect(response.status).toBe(200);
    expect(accepted).toEqual([input]);
    const oversized = await request(app)
      .post("/artifacts")
      .set("authorization", "Bearer allowed")
      .send({ content: "x".repeat(80 * 1024) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.details.limit).toBe(1024);
    expect(accepted).toEqual([input]);
  });

  test("compressed JSON retains the ordinary web parser's inflation and bounds the inflated frame", async () => {
    const { app, accepted } = fixture();
    const input = { name: "compressed", content: "<html>content</html>" };
    const acceptedResponse = await request(app)
      .post("/artifacts")
      .set("authorization", "Bearer allowed")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize((body) => body)
      .send(gzipSync(JSON.stringify(input)));
    expect(acceptedResponse.status).toBe(200);
    expect(accepted).toEqual([input]);
    const refused = await request(app)
      .post("/artifacts")
      .set("authorization", "Bearer allowed")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .serialize((body) => body)
      .send(gzipSync(JSON.stringify({ content: "x".repeat(80 * 1024) })));
    expect(refused.status).toBe(413);
    expect(accepted).toEqual([input]);
  });

  test("multipart admits the exact file boundary and bounds its metadata independently", async () => {
    const { app, accepted } = fixture();
    const exact = await request(app)
      .post("/upload")
      .field("executionId", "fixture-execution")
      .attach("file", Buffer.alloc(1024, "x"), "report.html");
    expect(exact.status).toBe(200);
    expect(exact.body).toMatchObject({
      size: 1024,
      metadata: { executionId: "fixture-execution" },
    });
    const excess = await request(app)
      .post("/upload")
      .attach("file", Buffer.alloc(1025, "x"), "report.html");
    expect(excess.status).toBe(413);
    expect(excess.body.error.details.limit).toBe(1024);
    const metadata = await request(app)
      .post("/upload")
      .field("executionId", "x".repeat(16 * 1024 + 1))
      .attach("file", Buffer.from("ok"), "report.html");
    expect(metadata.status).toBe(400);
    expect(accepted).toEqual(["x".repeat(1024)]);
  });

  test("a multipart part beyond the native header bound is a controlled input refusal", async () => {
    const { app, accepted } = fixture();
    const boundary = "artifact-header-boundary";
    const body = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="report.html"\r\n' +
        `X-Metadata: ${"x".repeat(17 * 1024)}\r\n\r\n` +
        `<p>ok</p>\r\n--${boundary}--\r\n`,
    );
    const response = await request(app)
      .post("/upload")
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(body);
    expect(response.status).toBe(400);
    expect(accepted).toEqual([]);
  });
});
