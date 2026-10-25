import { describe, expect, test } from "@jest/globals";
import { once } from "node:events";
import express from "express";
import cors from "cors";
import request from "supertest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readAuthenticatedMcpRequest } from "../../../packages/mcp-server/src/authenticated-request.js";
import { WORKSPACE_TOOL_SCHEMAS } from "../../../packages/mcp-server/src/tools/workspace-tool-contract.js";
import { mcpLimiter } from "../../../packages/mcp-server/src/middleware/rate-limit-middleware.js";

function fixture(revokeAfterAdmission = false, maxArtifactBytes = 5 * 1024 * 1024) {
  const app = express();
  const messages: unknown[] = [];
  let credentialActive = true;
  app.use(cors({ origin: "https://allowed.example" }));
  app.post("/mcp", mcpLimiter, async (req, res) => {
    const principal = await readAuthenticatedMcpRequest(
      req,
      res,
      async (incoming, outgoing) => {
        if (!credentialActive || incoming.get("authorization") !== "Bearer approved") {
          outgoing.status(401).json({ error: "invalid_token" });
          return null;
        }
        if (revokeAfterAdmission) credentialActive = false;
        return { userId: "owner" };
      },
      async () => maxArtifactBytes,
    );
    if (!principal) return;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transport.onmessage = (message) => {
      messages.push(message);
      if ("id" in message && message.id !== undefined)
        void transport.send({ jsonrpc: "2.0", id: message.id, result: { accepted: true } });
    };
    res.once("close", () => void transport.close());
    await transport.handleRequest(req, res, req.body);
  });
  app.use(express.json({ limit: "10mb" }));
  app.post("/ordinary", (req, res) => res.json(req.body));
  return { app, messages };
}
const headers = {
  authorization: "Bearer approved",
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-03-26",
};

describe("authenticated incremental MCP controls", () => {
  test("the preserved control allowance admits an unrelated tool regardless of argument property order", async () => {
    const { app, messages } = fixture(false, 1);
    const input = {
      params: { arguments: { message: "" }, name: "unrelated_control" },
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
    };
    input.params.arguments.message = "x".repeat(
      20 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(input)),
    );
    const response = await request(app).post("/mcp").set(headers).send(input);
    expect(response.status).toBe(200);
    expect(messages).toEqual([input]);
  });

  test("a chunked frame beyond the authenticated budget is 413 and cannot dispatch", async () => {
    const { app, messages } = fixture(false, 1);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const streamed = request(server)
        .post("/mcp")
        .set(headers)
        .set("Transfer-Encoding", "chunked");
      streamed.write('{"params":{"arguments":{"content":"');
      streamed.write("x".repeat(20 * 1024 * 1024));
      streamed.write('"},"name":"artifacts"},"jsonrpc":"2.0","id":1,"method":"tools/call"}');
      const response = await new Promise<request.Response>((resolve, reject) => {
        streamed.end((error, result) => (error ? reject(error) : resolve(result)));
      });
      expect(response.status).toBe(413);
      expect(response.body.error.data.limitBytes).toBe(20 * 1024 * 1024);
      expect(response.headers.connection).toBe("close");
      expect(messages).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("a raised artifact policy admits a frame above the former ingress ceiling", async () => {
    const { app, messages } = fixture(false, 24 * 1024 * 1024);
    const input = {
      params: { arguments: { content: "x".repeat(21 * 1024 * 1024) }, name: "artifacts" },
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
    };
    const response = await request(app).post("/mcp").set(headers).send(input);
    expect(response.status).toBe(200);
    expect(messages).toEqual([input]);
  });

  test("revoked authority after initial body admission cannot dispatch the parsed MCP request", async () => {
    const { app, messages } = fixture(true);
    const refused = await request(app)
      .post("/mcp")
      .set(headers)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(refused.status).toBe(401);
    expect(messages).toEqual([]);
  });

  test("large authenticated text reaches the SDK while ordinary HTTP retains its body policy", async () => {
    const { app, messages } = fixture();
    const text = "x".repeat(10 * 1024 * 1024 + 1);
    const input = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "communication_send", arguments: { message: text } },
    };
    expect(WORKSPACE_TOOL_SCHEMAS.communication_send.parse(input.params.arguments).message).toBe(
      text,
    );
    const response = await request(app)
      .post("/mcp")
      .set(headers)
      .set("Origin", "https://allowed.example")
      .send(input);
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://allowed.example");
    expect(messages).toEqual([input]);
    expect((await request(app).post("/ordinary").send({ text })).status).toBe(413);
  });

  test("authentication precedes invalid JSON and authenticated parse errors stay controlled", async () => {
    const { app, messages } = fixture();
    const denied = await request(app)
      .post("/mcp")
      .set("content-type", "application/json")
      .send('{"unfinished":');
    expect(denied.status).toBe(401);
    const invalid = await request(app).post("/mcp").set(headers).send('{"unfinished":');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe(-32700);
    expect(messages).toEqual([]);
  });

  test("batch forwarding and SDK media/protocol refusals remain intact", async () => {
    const { app, messages } = fixture();
    const batch = [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    ];
    expect((await request(app).post("/mcp").set(headers).send(batch)).status).toBe(202);
    expect(messages).toEqual(batch);
    expect(
      (
        await request(app)
          .post("/mcp")
          .set(headers)
          .set("content-type", "text/plain")
          .send("opaque")
      ).status,
    ).toBe(415);
    expect(
      (await request(app).post("/mcp").set(headers).set("accept", "application/json").send({}))
        .status,
    ).toBe(406);
    expect(
      (
        await request(app)
          .post("/mcp")
          .set(headers)
          .set("mcp-protocol-version", "invalid")
          .send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      ).status,
    ).toBe(400);
  });
});
