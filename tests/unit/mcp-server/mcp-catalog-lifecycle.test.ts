import { describe, expect, it, jest } from "@jest/globals";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import {
  getCatalogInitializeRequest,
  requireRevisionStampBeforeInitializeResult,
} from "../../../packages/mcp-server/src/auth/mcp-catalog-lifecycle.js";

const initializeRequest = {
  jsonrpc: "2.0" as const,
  id: 7,
  method: "initialize" as const,
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "catalog-test", version: "1.0.0" },
  },
};

describe("MCP catalog initialization lifecycle", () => {
  it("accepts only an SDK-valid singleton initialize request", () => {
    expect(getCatalogInitializeRequest(initializeRequest)).toEqual(initializeRequest);
    expect(getCatalogInitializeRequest([{ ...initializeRequest }])).toBeNull();
    expect(getCatalogInitializeRequest({ ...initializeRequest, id: undefined })).toBeNull();
    expect(getCatalogInitializeRequest({ ...initializeRequest, method: "tools/list" })).toBeNull();
    expect(
      getCatalogInitializeRequest({
        ...initializeRequest,
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      }),
    ).toBeNull();
  });

  it("persists acceptance before forwarding the successful initialize result", async () => {
    const order: string[] = [];
    const transport = {
      send: jest.fn(
        async (_message: JSONRPCMessage, _options?: { relatedRequestId?: RequestId }) => {
          order.push("send");
        },
      ),
    };
    const stamp = jest.fn(async () => {
      order.push("stamp");
      return true;
    });

    requireRevisionStampBeforeInitializeResult(transport, initializeRequest, stamp);
    await transport.send({ jsonrpc: "2.0", id: 7, result: { protocolVersion: "2025-06-18" } });

    expect(order).toEqual(["stamp", "send"]);
    expect(stamp).toHaveBeenCalledTimes(1);
  });

  it("does not persist errors or results for another request", async () => {
    const transport = { send: jest.fn(async (_message: JSONRPCMessage) => undefined) };
    const stamp = jest.fn(async () => true);

    requireRevisionStampBeforeInitializeResult(transport, initializeRequest, stamp);
    await transport.send({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "Invalid initialize" },
    });
    await transport.send({ jsonrpc: "2.0", id: 8, result: {} });

    expect(stamp).not.toHaveBeenCalled();
  });

  it("withholds the successful result when the credential can no longer be stamped", async () => {
    const transport = { send: jest.fn(async (_message: JSONRPCMessage) => undefined) };
    const originalSend = transport.send;
    requireRevisionStampBeforeInitializeResult(transport, initializeRequest, async () => false);

    await expect(
      transport.send({ jsonrpc: "2.0", id: 7, result: { protocolVersion: "2025-06-18" } }),
    ).rejects.toThrow("credential became invalid");
    expect(originalSend).not.toHaveBeenCalled();
  });
});
