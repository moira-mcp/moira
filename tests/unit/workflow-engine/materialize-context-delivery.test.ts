import { Buffer } from "node:buffer";
import express from "express";
import { describe, expect, test } from "@jest/globals";
import request from "supertest";
import { extract } from "tar-stream";
import { TokenManager, ValidationError, type WorkflowToken } from "@mcp-moira/shared";
import {
  assertMaterializeContextBudget,
  MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES,
  resolveMaterializeDelivery,
  type RenderedMaterializeFile,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { formatMaterializeDelivery } from "../../../packages/mcp-server/src/messages/index.js";
import { createExecutionMaterializeRoutes } from "../../../packages/web-backend/src/routes/execution-materialize.js";

const grant: WorkflowToken = {
  token: "grant",
  workflowId: null,
  executionId: "execution-1",
  nodeId: "materialize",
  userId: "user-1",
  type: "materialize",
  workflowVersion: null,
  executionRevision: null,
  optionsJson: null,
  expiresAt: Date.now() + TokenManager.MATERIALIZE_TTL_MS,
  used: false,
  createdAt: Date.now(),
};

const execution: WorkflowExecution = {
  revision: 0,
  executionId: "execution-1",
  workflowId: "workflow-1",
  userId: "user-1",
  currentNodeId: "materialize",
  waitingForInputNodeId: "materialize",
  globalContext: {
    executionId: "execution-1",
    workflowId: "workflow-1",
    userId: "user-1",
    variables: { name: "runtime" },
    nodeStates: {},
  },
  status: "running",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function graph(source: string): WorkflowGraph {
  return {
    id: "workflow-1",
    metadata: { name: "Test", version: "1.0.0", description: "Test" },
    variableRegistry: {
      source: { type: "string", description: "Current source", default: source },
      name: { type: "string", description: "Runtime name", default: "registry" },
      second: { type: "string", description: "Second body", default: "second body for {{name}}" },
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "materialize" } },
      {
        id: "materialize",
        type: "materialize",
        basePath: "out",
        files: [
          { path: "guide.md", from: "source" },
          { path: "nested/second.md", from: "second" },
        ],
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

const alwaysAuthorized = {
  validateToken: () => grant,
  authorizeMaterializeToken: () => true,
};

function repositoryFor(
  currentExecution: WorkflowExecution,
  currentGraph: WorkflowGraph,
): {
  getExecution: () => Promise<WorkflowExecution>;
  getWorkflowGraph: () => Promise<WorkflowGraph>;
} {
  return {
    getExecution: async () => currentExecution,
    getWorkflowGraph: async () => currentGraph,
  };
}

async function tarEntries(buffer: Buffer): Promise<Map<string, Buffer>> {
  const parser = extract();
  const entries = new Map<string, Buffer>();
  return new Promise((resolve, reject) => {
    parser.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.once("error", reject);
      stream.resume();
    });
    parser.once("finish", () => resolve(entries));
    parser.once("error", reject);
    parser.end(buffer);
  });
}

function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => chunks.push(chunk));
  response.once("end", () => callback(null, Buffer.concat(chunks)));
  response.once("error", callback);
}

function fileOfSize(bytes: number): RenderedMaterializeFile {
  return { path: "big.md", content: Buffer.alloc(bytes, "x") };
}

describe("materialize context delivery", () => {
  test("delivers the same bytes the archive channel serves for the same grant", async () => {
    const definition = graph("guide body for {{name}}");

    const delivery = await resolveMaterializeDelivery(
      "grant",
      alwaysAuthorized,
      repositoryFor(execution, definition),
    );

    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(alwaysAuthorized, repositoryFor(execution, definition)),
    );
    const archived = await request(app)
      .get("/api/public/executions/materialize/grant")
      .buffer(true)
      .parse(binaryParser);
    expect(archived.status).toBe(200);
    const entries = await tarEntries(archived.body as Buffer);

    expect(delivery.authorized).toBe(true);
    if (!delivery.authorized) return;
    expect(delivery.files.map((file) => file.path)).toEqual(["guide.md", "nested/second.md"]);
    for (const file of delivery.files) {
      const archivedContent = entries.get(file.path);
      expect(archivedContent).toBeDefined();
      // Byte equality, not name equality: a separately rendered body would pass a name check.
      expect(file.content.equals(archivedContent!)).toBe(true);
    }
    expect(delivery.files[0]!.content.toString("utf8")).toBe("guide body for runtime");
  });

  test("refuses when the execution has moved past the materialize node", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      alwaysAuthorized,
      repositoryFor({ ...execution, waitingForInputNodeId: "other" }, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "execution_binding_mismatch" });
  });

  test("refuses when the grant is expired or unknown", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      { validateToken: () => null, authorizeMaterializeToken: () => true },
      repositoryFor(execution, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "grant_invalid_or_expired" });
  });

  test("refuses when the execution belongs to another user", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      alwaysAuthorized,
      repositoryFor({ ...execution, userId: "other-user" }, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "execution_binding_mismatch" });
  });

  test("refuses when the recorded context revision no longer matches the execution", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      {
        validateToken: () => ({
          ...grant,
          optionsJson: JSON.stringify({ contextRevision: "revision-from-another-state" }),
        }),
        authorizeMaterializeToken: () => true,
      },
      repositoryFor(execution, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "execution_binding_mismatch" });
  });

  test("refuses when authorization is lost between rendering and delivery", async () => {
    const delivery = await resolveMaterializeDelivery(
      "grant",
      { validateToken: () => grant, authorizeMaterializeToken: () => false },
      repositoryFor(execution, graph("body")),
    );
    expect(delivery).toEqual({ authorized: false, reason: "authorization_lost" });
  });

  test("accepts a set at the context budget and refuses one byte more without truncating", () => {
    expect(() =>
      assertMaterializeContextBudget([fileOfSize(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES)]),
    ).not.toThrow();

    const oversized = [fileOfSize(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES + 1)];
    expect(() => assertMaterializeContextBudget(oversized)).toThrow(ValidationError);
    // The rejected set is untouched: refusal must not be implemented as a shortened delivery.
    expect(oversized[0]!.content.byteLength).toBe(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES + 1);
  });

  test("counts the budget across files, not per file", () => {
    const half = Math.ceil(MATERIALIZE_CONTEXT_MAX_TOTAL_BYTES / 2) + 1;
    expect(() =>
      assertMaterializeContextBudget([
        { path: "a.md", content: Buffer.alloc(half, "a") },
        { path: "b.md", content: Buffer.alloc(half, "b") },
      ]),
    ).toThrow(ValidationError);
  });

  test("presents each file as its own block carrying the body verbatim", () => {
    const blocks = formatMaterializeDelivery([
      { path: "guide.md", content: '# Title\n\n"quoted"\tand\ttabs\n' },
      { path: "nested/second.md", content: "second" },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.text).toContain('- "guide.md"');
    expect(blocks[0]!.text).toContain('- "nested/second.md"');
    // Verbatim, not JSON-escaped: an escaped body is the plausible wrong state here.
    expect(blocks[1]!.text).toBe('===== FILE: guide.md =====\n# Title\n\n"quoted"\tand\ttabs\n');
    expect(blocks[2]!.text).toBe("===== FILE: nested/second.md =====\nsecond");
  });
});
