import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { PassThrough, Readable } from "node:stream";
import { createWorkspaceTransferDownloadHandler } from "../../../packages/mcp-server/src/workspace-transfer-route.js";
import type { WorkspaceTransferRecord, WorkspaceTransferService } from "@mcp-moira/shared";

const record = {
  id: "transfer-1",
  userId: "user-1",
  purpose: "workspace_download",
  state: "claimed",
  fileName: "résultat.bin",
  mimeType: "application/octet-stream",
  declaredSize: 4,
  observedSize: 4,
  sha256: "a".repeat(64),
  objectKey: "b".repeat(48),
  ownerPid: process.pid,
  ownerStartTime: null,
  claimId: "claim-1",
  claimExpiresAt: Date.now() + 60_000,
  expiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
} satisfies WorkspaceTransferRecord;

function app(service: Pick<WorkspaceTransferService, "claimDownload" | "consume">) {
  const value = express();
  value.get("/files/:token", createWorkspaceTransferDownloadHandler(service));
  return value;
}

describe("workspace transfer download route", () => {
  test("streams one private object with no-store, noindex and attachment protections", async () => {
    const service = {
      claimDownload: jest.fn(async () => ({
        record,
        stream: Readable.from([Buffer.from([0, 255, 1, 2])]),
      })),
      consume: jest.fn(async () => undefined),
    };
    const response = await request(app(service as never)).get(`/files/${"a".repeat(43)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from([0, 255, 1, 2]));
    expect(response.headers).toMatchObject({
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "referrer-policy": "no-referrer",
      "content-type": "application/octet-stream",
    });
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(service.consume).toHaveBeenCalledWith(record);
  });

  test("reveals no transfer metadata for an invalid or consumed capability", async () => {
    const service = {
      claimDownload: jest.fn(async () => {
        throw new Error("not found");
      }),
      consume: jest.fn(async () => undefined),
    };
    const response = await request(app(service as never)).get(`/files/${"x".repeat(43)}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "workspace_transfer_not_found" });
    expect(JSON.stringify(response.body)).not.toContain("user-1");
  });

  test("consumes a claimed capability when the client aborts a partial response", async () => {
    const stream = new PassThrough();
    const service = {
      claimDownload: jest.fn(async () => ({ record, stream })),
      consume: jest.fn(async () => undefined),
    };
    const response = new PassThrough() as PassThrough & {
      status: (code: number) => unknown;
      set: (headers: Record<string, string>) => unknown;
      headersSent: boolean;
    };
    response.status = jest.fn(() => response);
    response.set = jest.fn(() => response);
    response.headersSent = false;
    const handler = createWorkspaceTransferDownloadHandler(service as never);
    await handler(
      { params: { token: "a".repeat(43) } } as never,
      response as never,
      jest.fn() as never,
    );
    stream.write(Buffer.from([0, 1]));
    response.emit("close");
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    expect(service.consume).toHaveBeenCalledTimes(1);
    expect(service.consume).toHaveBeenCalledWith(record);
    stream.destroy();
    response.destroy();
  });
});
