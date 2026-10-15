import { describe, expect, test } from "@jest/globals";
import express from "express";
import cors from "cors";
import request from "supertest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readAuthenticatedMcpRequest } from "../../../packages/mcp-server/src/authenticated-request.js";
import { communicationSchema } from "../../../packages/mcp-server/src/tools/tool-schemas.js";

function fixture(revokeAfterAdmission = false) {
  const app = express();
  const messages: unknown[] = [];
  let credentialActive = true;
  app.use(cors({ origin: "https://allowed.example" }));
  app.post("/mcp", async (req, res) => {
    const principal = await readAuthenticatedMcpRequest(req, res, async (incoming, outgoing) => {
      if (!credentialActive || incoming.get("authorization") !== "Bearer approved") {
        outgoing.status(401).json({ error: "invalid_token" });
        return null;
      }
      if (revokeAfterAdmission) credentialActive = false;
      return { userId: "owner" };
    });
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
      params: { name: "communication", arguments: { action: "send", message: text } },
    };
    expect(communicationSchema.parse(input.params.arguments).message).toBe(text);
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
