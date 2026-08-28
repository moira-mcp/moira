import { Buffer } from "node:buffer";
import express from "express";
import { describe, expect, test } from "@jest/globals";
import request from "supertest";
import { extract } from "tar-stream";
import { TokenManager, type WorkflowToken } from "@mcp-moira/shared";
import {
  MATERIALIZE_MAX_FILE_BYTES,
  MATERIALIZE_MAX_FILES,
  type MaterializeFile,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { createExecutionMaterializeRoutes } from "../../../packages/web-backend/src/routes/execution-materialize.js";

const grant: WorkflowToken = {
  token: "grant",
  workflowId: null,
  executionId: "execution-1",
  nodeId: "materialize",
  userId: "user-1",
  type: "materialize",
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
    variables: { name: "runtime", source: "stale execution snapshot" },
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
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "materialize" } },
      {
        id: "materialize",
        type: "materialize",
        basePath: "out",
        files: [{ path: "result.md", from: "source" }],
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

function graphWithFiles(source: string, files: MaterializeFile[]): WorkflowGraph {
  const current = graph(source);
  return {
    ...current,
    nodes: current.nodes.map((candidate) =>
      candidate.type === "materialize" ? { ...candidate, files } : candidate,
    ),
  };
}

async function firstTarEntry(buffer: Buffer): Promise<{ name: string; content: string }> {
  const parser = extract();
  return new Promise((resolve, reject) => {
    parser.once("entry", (header, stream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () =>
        resolve({ name: header.name, content: Buffer.concat(chunks).toString("utf8") }),
      );
      stream.once("error", reject);
      stream.resume();
    });
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

describe("GET /api/public/executions/materialize/:token", () => {
  test("reads the current workflow definition, returns tar, and permits one claim", async () => {
    let used = false;
    let claims = 0;
    const tokens = {
      validateToken: () => (used ? null : grant),
      claimMaterializeToken: () => {
        if (used) return false;
        used = true;
        claims++;
        return true;
      },
    };
    let arrivals = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const repository = {
      getExecution: async () => {
        arrivals++;
        if (arrivals === 2) releaseBoth();
        await bothArrived;
        return execution;
      },
      getWorkflowGraph: async () => graph("fresh definition for {{name}}"),
    };
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(tokens, repository),
    );

    const responses = await Promise.all([
      request(app).get("/api/public/executions/materialize/grant").buffer(true).parse(binaryParser),
      request(app).get("/api/public/executions/materialize/grant").buffer(true).parse(binaryParser),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const response = responses.find((candidate) => candidate.status === 200)!;
    expect(response.headers["content-type"]).toContain("application/x-tar");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="materialize.tar"');
    expect(claims).toBe(1);
    expect(await firstTarEntry(response.body as Buffer)).toEqual({
      name: "result.md",
      content: "fresh definition for runtime",
    });

    expect(claims).toBe(1);
  });

  test("returns no tar and preserves the grant for every one-over resource bound", async () => {
    const exactFile = "x".repeat(MATERIALIZE_MAX_FILE_BYTES);
    const cases = [
      {
        name: "file count",
        graph: graphWithFiles(
          "x",
          Array.from({ length: MATERIALIZE_MAX_FILES + 1 }, (_, index) => ({
            path: `${index}.txt`,
            from: "source",
          })),
        ),
      },
      {
        name: "individual file bytes",
        graph: graph(`${exactFile}x`),
      },
      {
        name: "aggregate bytes",
        graph: graphWithFiles(
          exactFile,
          Array.from({ length: 11 }, (_, index) => ({
            path: `${index}.txt`,
            from: "source",
          })),
        ),
      },
    ];

    for (const scenario of cases) {
      let claims = 0;
      const tokens = {
        validateToken: () => grant,
        claimMaterializeToken: () => {
          claims++;
          return true;
        },
      };
      const repository = {
        getExecution: async () => execution,
        getWorkflowGraph: async () => scenario.graph,
      };
      const app = express().use(
        "/api/public/executions",
        createExecutionMaterializeRoutes(tokens, repository),
      );

      const response = await request(app).get("/api/public/executions/materialize/grant");
      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).not.toContain("application/x-tar");
      expect(response.body.error).toBe("Materialize archive could not be generated");
      expect(claims).toBe(0);
    }
  });

  test("returns no tar and preserves the grant for a declared non-string source", async () => {
    let claims = 0;
    const tokens = {
      validateToken: () => grant,
      claimMaterializeToken: () => {
        claims++;
        return true;
      },
    };
    const nonStringGraph = graph("fresh");
    nonStringGraph.variableRegistry!.source = {
      type: "number",
      description: "Not valid materialize content",
      default: 42,
    };
    const repository = {
      getExecution: async () => execution,
      getWorkflowGraph: async () => nonStringGraph,
    };
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(tokens, repository),
    );

    const response = await request(app).get("/api/public/executions/materialize/grant");
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).not.toContain("application/x-tar");
    expect(response.body.error).toBe("Materialize archive could not be generated");
    expect(claims).toBe(0);
  });

  test("rejects expired, wrong-node, unsafe, and colliding requests without archive data", async () => {
    const cases: Array<{
      name: string;
      expectedStatus: number;
      validate?: () => WorkflowToken | null;
      execution: WorkflowExecution;
      graph: WorkflowGraph;
    }> = [
      {
        name: "expired",
        expectedStatus: 401,
        validate: () => null,
        execution,
        graph: graph("fresh"),
      },
      {
        name: "wrong node",
        expectedStatus: 401,
        execution: { ...execution, waitingForInputNodeId: "other" },
        graph: graph("fresh"),
      },
      {
        name: "wrong current node",
        expectedStatus: 401,
        execution: { ...execution, currentNodeId: "other" },
        graph: graph("fresh"),
      },
      {
        name: "wrong user",
        expectedStatus: 401,
        execution: { ...execution, userId: "other-user" },
        graph: graph("fresh"),
      },
      {
        name: "unsafe rendered path",
        expectedStatus: 400,
        execution: {
          ...execution,
          globalContext: {
            ...execution.globalContext,
            variables: { ...execution.globalContext.variables, target: "../escape" },
          },
        },
        graph: {
          ...graph("fresh"),
          nodes: graph("fresh").nodes.map((candidate) =>
            candidate.type === "materialize"
              ? { ...candidate, files: [{ path: "{{target}}", from: "source" }] }
              : candidate,
          ),
        },
      },
      {
        name: "rendered collision",
        expectedStatus: 400,
        execution: {
          ...execution,
          globalContext: {
            ...execution.globalContext,
            variables: {
              ...execution.globalContext.variables,
              first: "dir\\same",
              second: "dir/same",
            },
          },
        },
        graph: {
          ...graph("fresh"),
          nodes: graph("fresh").nodes.map((candidate) =>
            candidate.type === "materialize"
              ? {
                  ...candidate,
                  files: [
                    { path: "{{first}}", from: "source" },
                    { path: "{{second}}", content: "" },
                  ],
                }
              : candidate,
          ),
        },
      },
    ];

    for (const scenario of cases) {
      let claims = 0;
      const tokens = {
        validateToken: scenario.validate ?? (() => grant),
        claimMaterializeToken: () => {
          claims++;
          return true;
        },
      };
      const repository = {
        getExecution: async () => scenario.execution,
        getWorkflowGraph: async () => scenario.graph,
      };
      const app = express().use(
        "/api/public/executions",
        createExecutionMaterializeRoutes(tokens, repository),
      );
      const response = await request(app).get("/api/public/executions/materialize/grant");
      expect(response.status).toBe(scenario.expectedStatus);
      expect(response.headers["content-type"]).not.toContain("application/x-tar");
      expect(typeof response.body.error).toBe("string");
      expect(claims).toBe(0);
    }
  });

  test("forwards unexpected failures to the HTTP error boundary", async () => {
    let claims = 0;
    const tokens = {
      validateToken: () => grant,
      claimMaterializeToken: () => {
        claims++;
        return true;
      },
    };
    const repository = {
      getExecution: async (): Promise<WorkflowExecution | null> => {
        throw new Error("unexpected repository defect");
      },
      getWorkflowGraph: async () => graph("fresh"),
    };
    const boundary: express.ErrorRequestHandler = (error, _req, res, _next) => {
      expect(error).toBeInstanceOf(Error);
      res.status(500).json({ error: "Internal server error" });
    };
    const app = express()
      .use("/api/public/executions", createExecutionMaterializeRoutes(tokens, repository))
      .use(boundary);

    const response = await request(app).get("/api/public/executions/materialize/grant");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(response.body)).not.toContain("unexpected repository defect");
    expect(claims).toBe(0);
  });
});
