import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { PassThrough, Readable } from "node:stream";
import { createWorkspacePublicationHandler } from "../../../packages/mcp-server/src/workspace-publication-route.js";

const resourceId = "00000000-0000-4000-8000-000000000001";
const token = "a".repeat(43);
const headers = {
  "content-type": "application/octet-stream",
  "content-length": "4",
  "content-disposition": "attachment; filename=owner.bin",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
  "referrer-policy": "no-referrer",
};

function app(dependencies: Parameters<typeof createWorkspacePublicationHandler>[0]) {
  const value = express();
  value.get("/files/:resourceId/:token", createWorkspacePublicationHandler(dependencies));
  return value;
}

describe("owner publication live route", () => {
  test("streams the owner version repeatedly with unchanged owner headers and no consume effect", async () => {
    const dependencies = {
      authorize: () => "user-1",
      workspace: {
        request: async () => ({
          statusCode: 200,
          headers,
          body: Readable.from([Buffer.from([0, 255, 1, 2])]),
        }),
      },
    };
    for (let index = 0; index < 2; index++) {
      const response = await request(app(dependencies)).get(`/files/${resourceId}/${token}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(Buffer.from([0, 255, 1, 2]));
      expect(response.headers).toMatchObject(headers);
    }
  });

  test("revoked or unavailable routing returns no owner bytes or metadata", async () => {
    const dependencies = {
      authorize: () => {
        throw new Error("revoked");
      },
      workspace: {
        request: jest.fn(async () => ({
          statusCode: 200,
          headers,
          body: Readable.from(["secret"]),
        })),
      },
    };
    const response = await request(app(dependencies)).get(`/files/${resourceId}/${token}`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "workspace_publication_unavailable" });
    expect(dependencies.workspace.request).not.toHaveBeenCalled();
  });

  test("reader disconnect closes only the opened owner stream", async () => {
    const stream = new PassThrough();
    const response = new PassThrough() as PassThrough & {
      status: (code: number) => unknown;
      setHeader: (name: string, value: string) => unknown;
      headersSent: boolean;
    };
    response.status = () => response;
    response.setHeader = () => response;
    response.headersSent = true;
    const handler = createWorkspacePublicationHandler({
      authorize: () => "user-1",
      workspace: { request: async () => ({ statusCode: 200, headers, body: stream }) },
    });
    await handler(
      { params: { resourceId, token }, query: {} } as never,
      response as never,
      jest.fn() as never,
    );
    stream.write(Buffer.from([0, 1]));
    response.emit("close");
    expect(stream.destroyed).toBe(true);
    response.destroy();
  });
});
