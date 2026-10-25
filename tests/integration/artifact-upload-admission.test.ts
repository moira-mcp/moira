import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import express from "express";
import request from "supertest";
import path from "node:path";
import { ArtifactRepository, ArtifactService, AuditRepository } from "@mcp-moira/shared";
import * as schema from "../../packages/shared/src/database/schema.js";
import { createArtifactTokenRoutes } from "../../packages/web-backend/src/routes/artifact-tokens.js";
import { setupErrorMiddleware } from "../../packages/web-backend/src/middleware/error-middleware.js";

describe("artifact token upload admission", () => {
  let sqlite: Database.Database;
  let service: ArtifactService;
  let repository: ArtifactRepository;
  let app: express.Express;
  const exactHtml = `<html>${"x".repeat(1024 - 13)}</html>`;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.resolve("packages/web-backend/drizzle") });
    sqlite
      .prepare("INSERT INTO user(id,email,name,handle,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
      .run("upload-owner", "upload@example.test", "Upload", "upload-owner", "now", "now");
    repository = new ArtifactRepository(db);
    service = new ArtifactService(repository, new AuditRepository(db), { maxSize: 1024 });
    app = express();
    app.use("/api/public/artifacts", createArtifactTokenRoutes(service));
    app.use(express.json({ limit: "10mb" }));
    app.use(setupErrorMiddleware());
  });

  afterEach(() => {
    sqlite.close();
  });

  test("invalid token refuses malformed multipart before parsing and creates no artifact", async () => {
    const response = await request(app)
      .post("/api/public/artifacts/upload/invalid")
      .type("multipart/form-data; boundary=broken")
      .send("malformed");
    expect(response.status).toBe(401);
    expect(response.headers.connection).toBe("close");
    expect(await repository.getCount("upload-owner")).toBe(0);
  });

  test("oversized multipart leaves its token usable and a successful exact-boundary upload consumes it", async () => {
    const token = await service.createUploadToken("upload-owner");
    const url = `/api/public/artifacts/upload/${token}`;
    const refused = await request(app)
      .post(url)
      .attach("file", Buffer.from(exactHtml + "x"), "report.html");
    expect(refused.status).toBe(413);
    expect(refused.body.error.details.limit).toBe(1024);
    expect(await service.validateToken(token)).toEqual({ userId: "upload-owner" });
    expect(await repository.getCount("upload-owner")).toBe(0);
    const accepted = await request(app)
      .post(url)
      .attach("file", Buffer.from(exactHtml), "report.html");
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.size).toBe(1024);
    expect((await repository.getByUuid(accepted.body.data.uuid, "upload-owner"))?.content).toBe(
      exactHtml,
    );
    await expect(service.validateToken(token)).rejects.toMatchObject({
      code: "INVALID_ARTIFACT_TOKEN",
    });
    expect((await request(app).post(url).send({ name: "again", content: exactHtml })).status).toBe(
      401,
    );
    expect(await repository.getCount("upload-owner")).toBe(1);
  });

  test("JSON framing refusal leaves its token valid while final service checks decoded content bytes", async () => {
    const token = await service.createUploadToken("upload-owner");
    const url = `/api/public/artifacts/upload/${token}`;
    const framed = await request(app)
      .post(url)
      .send({ name: "large", content: "x".repeat(80 * 1024) });
    expect(framed.status).toBe(413);
    expect(await service.validateToken(token)).toEqual({ userId: "upload-owner" });
    const decoded = await request(app)
      .post(url)
      .send({ name: "large", content: exactHtml + "x" });
    expect(decoded.status).toBe(400);
    expect(decoded.body.error.details.limit).toBe(1024);
    expect(await service.validateToken(token)).toEqual({ userId: "upload-owner" });
    expect(await repository.getCount("upload-owner")).toBe(0);
    const accepted = await request(app).post(url).send({ name: "report", content: exactHtml });
    expect(accepted.status).toBe(201);
    expect((await repository.getByUuid(accepted.body.data.uuid, "upload-owner"))?.content).toBe(
      exactHtml,
    );
  });
});
