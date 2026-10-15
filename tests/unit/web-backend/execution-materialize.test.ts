import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import { describe, expect, test } from "@jest/globals";
import request from "supertest";
import { extract, pack } from "tar-stream";
import {
  TokenManager,
  metadataRevision,
  type WorkflowToken,
  type CommunicationOwnerScope,
  type CommunicationOwnerSubmit,
} from "@mcp-moira/shared";
import {
  CommunicationChannelOwnerUnavailableError,
  type CommunicationFileOwner,
  type MaterializeFile,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { createExecutionMaterializeRoutes } from "../../../packages/web-backend/src/routes/execution-materialize.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";
import { LiveCommunicationFileOwner } from "../../../packages/web-backend/src/services/communication-file-owner.js";
import type { WorkspaceClient } from "../../../packages/web-backend/src/services/workspace-router.js";

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

/**
 * Supertest's parser signature names its first argument a Response; what it hands over is the
 * readable stream of the body, which is what this reads.
 */
function binaryParser(
  response: NodeJS.ReadableStream,
  callback: (error: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => chunks.push(chunk));
  response.once("end", () => callback(null, Buffer.concat(chunks)));
  response.once("error", callback);
}

const ownerScope: Extract<CommunicationOwnerScope, { kind: "controller" }> = {
  kind: "controller",
  userId: "user-1",
  deviceId: "620b1509-24ea-48d4-a73e-063fae51e166",
  deviceGeneration: 2,
  connectionId: "620b1509-24ea-48d4-a73e-063fae51e167",
};
function archiveStore(authorize = () => true, validate = () => grant as WorkflowToken | null) {
  let archive: { owner: typeof ownerScope; requestId: string } | null = null;
  return {
    validateToken: validate,
    authorizeMaterializeToken: authorize,
    getMaterializeArchive: () => archive,
    bindMaterializeArchive(
      _token: string,
      _execution: string,
      _node: string,
      _user: string,
      _revision: string,
      candidate: NonNullable<typeof archive>,
    ) {
      if (archive) return { created: false, archive };
      archive = candidate;
      return { created: true, archive };
    },
  };
}
/** Test-only owner boundary: production archive construction is exercised at the actual controller. */
function archiveOwner(waitForCollection = false) {
  const submitted: CommunicationOwnerSubmit[] = [];
  const collected: string[] = [];
  let bytes = Buffer.alloc(0);
  let receipt: Record<string, unknown> | undefined;
  let collectedFirst!: () => void;
  const firstCollection = new Promise<void>((resolve) => {
    collectedFirst = resolve;
  });
  const owner: CommunicationFileOwner = {
    async select() {
      return ownerScope;
    },
    async submit(_userId, input) {
      submitted.push(input);
      if (input.source.type !== "materialize-text-set") throw new Error("wrong source contract");
      if (waitForCollection) await firstCollection;
      const tar = pack();
      for (const file of input.source.files) tar.entry({ name: file.path }, file.content);
      tar.finalize();
      const chunks: Buffer[] = [];
      for await (const chunk of tar) chunks.push(Buffer.from(chunk));
      bytes = Buffer.concat(chunks);
      receipt = {
        requestId: input.requestId,
        state: "completed",
        outcome: {
          ok: true,
          result: {
            file: {
              referenceId: `owner-file://controller/${ownerScope.deviceId}/${"a".repeat(43)}`,
              uri: `https://moira.test/api/communication/files/${ownerScope.deviceId}/${"a".repeat(43)}`,
              fileName: "materialize.tar",
              mimeType: "application/x-tar",
              size: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              expiresAt: Date.now() + 60000,
            },
          },
        },
      };
      return receipt;
    },
    async collect(_userId, requestId) {
      collected.push(requestId);
      collectedFirst();
      return receipt ?? { requestId, state: "absent" };
    },
    async openPublication() {
      return {
        headers: { "content-type": "application/x-tar", "content-length": String(bytes.length) },
        body: Readable.from([bytes]),
      };
    },
  };
  return { owner, submitted, collected };
}

describe("GET /api/public/executions/materialize/:token", () => {
  test.each([
    {
      name: "file-parent collision",
      files: [
        { path: "a", content: "" },
        { path: "a/b", content: "" },
      ],
      source: "text",
    },
    {
      name: "drive-prefixed path",
      files: [{ path: "C:/guide.md", from: "source" }],
      source: "text",
    },
    {
      name: "lone-surrogate path",
      files: [{ path: "guide\ud800.md", from: "source" }],
      source: "text",
    },
    {
      name: "lone-surrogate content",
      files: [{ path: "guide.md", from: "source" }],
      source: "text\ud800",
    },
  ])(
    "$name refuses before assignment and the corrected definition can reuse the same grant",
    async (scenario) => {
      const tokens = archiveStore();
      const f = archiveOwner();
      const dispatched: string[] = [];
      const client: WorkspaceClient = {
        async json(user, _id, input) {
          dispatched.push(input.method);
          expect(input.method).toBe("POST");
          expect(input.path).toBe("/v1/communication");
          return f.owner.submit(user, input.body as CommunicationOwnerSubmit);
        },
        async request(user) {
          const opened = await f.owner.openPublication(user, "unused-fixture-reference");
          return { statusCode: 200, headers: opened.headers, body: Readable.from(opened.body) };
        },
      };
      // The real cloud adapter validates the finished source before its HTTP
      // client. The existing archive fixture stands only for that remote owner.
      const observed = { ...ownerScope, status: "active", owner: { state: "available" } };
      const owner = new LiveCommunicationFileOwner({
        devices: () =>
          ({
            listOwned: async () => ({ devices: [observed] }),
            getDeviceIdentity: () => observed,
          }) as never,
        controller: () => client,
        workspace: () => client,
        authorizePublication: () => ownerScope.userId,
      });
      let definition = graphWithFiles(scenario.source, scenario.files as MaterializeFile[]);
      const app = express().use(
        "/api/public/executions",
        createExecutionMaterializeRoutes(
          tokens,
          {
            getExecution: async () => execution,
            getWorkflowGraph: async () => definition,
          },
          owner,
        ),
      );
      app.use(setupErrorMiddleware());
      const refused = await request(app).get("/api/public/executions/materialize/grant");
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ error: "Materialize archive could not be generated" });
      expect(tokens.getMaterializeArchive()).toBeNull();
      expect(dispatched).toEqual([]);
      expect(f.submitted).toEqual([]);
      definition = graph("corrected {{name}}");
      const successful = await request(app)
        .get("/api/public/executions/materialize/grant")
        .buffer(true)
        .parse(binaryParser as unknown as (str: string) => unknown);
      expect(successful.status).toBe(200);
      expect(await firstTarEntry(successful.body as Buffer)).toEqual({
        name: "result.md",
        content: "corrected runtime",
      });
      expect(dispatched).toEqual(["POST"]);
      expect(f.submitted).toHaveLength(1);
      expect(tokens.getMaterializeArchive()).toEqual({
        owner: ownerScope,
        requestId: f.submitted[0].requestId,
      });
    },
  );

  test("a bound but absent original publication is collected without another render or submit", async () => {
    const tokens = archiveStore();
    const requestId = "ws1-11111111-1111-4111-8111-111111111111";
    tokens.bindMaterializeArchive(
      "grant",
      execution.executionId,
      "materialize",
      "user-1",
      metadataRevision(execution.globalContext),
      { owner: ownerScope, requestId },
    );
    const f = archiveOwner();
    const owner = {
      ...f.owner,
      async select(): Promise<typeof ownerScope> {
        throw new Error("cannot reassign original");
      },
      async submit(): Promise<Record<string, unknown>> {
        throw new Error("cannot resubmit original");
      },
    };
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(
        tokens,
        {
          getExecution: async () => execution,
          getWorkflowGraph: async () =>
            graphWithFiles("missing source must not render", [
              { path: "result.md", from: "undeclared" },
            ]),
        },
        owner,
      ),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(app).get("/api/public/executions/materialize/grant");
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({
        code: "COMMUNICATION_OUTCOME_UNCONFIRMED",
        request_id: requestId,
      });
    }
    expect(f.collected).toEqual([requestId, requestId]);
    expect(f.submitted).toEqual([]);
  });

  test("context changed across asynchronous resolution refuses before assigning an owner effect", async () => {
    let current = structuredClone(execution);
    const revision = metadataRevision(current.globalContext);
    const tokens = archiveStore(
      () => true,
      () => ({ ...grant, optionsJson: JSON.stringify({ contextRevision: revision }) }),
    );
    let graphReads = 0;
    const f = archiveOwner();
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(
        tokens,
        {
          getExecution: async () => structuredClone(current),
          getWorkflowGraph: async () => {
            await Promise.resolve();
            if (++graphReads === 2)
              current = {
                ...current,
                globalContext: {
                  ...current.globalContext,
                  variables: { ...current.globalContext.variables, changed: true },
                },
              };
            return graph("content");
          },
        },
        f.owner,
      ),
    );
    const result = await request(app).get("/api/public/executions/materialize/grant");
    expect(result.status).toBe(401);
    expect(tokens.getMaterializeArchive()).toBeNull();
    expect(f.submitted).toEqual([]);
  });

  test("an unavailable controller is operational 503 and leaves the grant unassigned", async () => {
    const tokens = archiveStore();
    const f = archiveOwner();
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(
        tokens,
        {
          getExecution: async () => execution,
          getWorkflowGraph: async () => graph("content"),
        },
        {
          ...f.owner,
          async select() {
            throw new CommunicationChannelOwnerUnavailableError();
          },
        },
      ),
    );
    app.use(setupErrorMiddleware());
    const result = await request(app).get("/api/public/executions/materialize/grant");
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("COMMUNICATION_OWNER_UNAVAILABLE");
    expect(tokens.getMaterializeArchive()).toBeNull();
    expect(f.submitted).toEqual([]);
  });

  test("concurrent readers share one original publication and later reads do not rerender changed text", async () => {
    const tokens = archiveStore();
    const fileOwner = archiveOwner(true);
    let arrivals = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    let currentDefinition = graph("fresh definition for {{name}}");
    const repository = {
      getExecution: async () => {
        arrivals++;
        if (arrivals === 2) releaseBoth();
        await bothArrived;
        return execution;
      },
      getWorkflowGraph: async () => currentDefinition,
    };
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(tokens, repository, fileOwner.owner),
    );

    const responses = await Promise.all([
      request(app)
        .get("/api/public/executions/materialize/grant")
        .buffer(true)
        .parse(binaryParser as unknown as (str: string) => unknown),
      request(app)
        .get("/api/public/executions/materialize/grant")
        .buffer(true)
        .parse(binaryParser as unknown as (str: string) => unknown),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const successful = responses.find((response) => response.status === 200)!;
    for (const response of [successful]) {
      expect(response.headers["content-type"]).toContain("application/x-tar");
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="materialize.tar"',
      );
      expect(await firstTarEntry(response.body as Buffer)).toEqual({
        name: "result.md",
        content: "fresh definition for runtime",
      });
    }
    expect(fileOwner.submitted).toHaveLength(1);
    expect(fileOwner.collected).toHaveLength(1);
    expect(fileOwner.collected[0]).toBe(fileOwner.submitted[0].requestId);
    expect(fileOwner.submitted[0].expectedScope).toEqual(ownerScope);
    currentDefinition = graph("changed definition for {{name}}");
    const repeated = await request(app)
      .get("/api/public/executions/materialize/grant")
      .buffer(true)
      .parse(binaryParser as unknown as (str: string) => unknown);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(successful.body);
    expect(fileOwner.submitted).toHaveLength(1);
    expect(fileOwner.collected).toEqual([
      fileOwner.submitted[0].requestId,
      fileOwner.submitted[0].requestId,
    ]);
  });

  test("publishes sets above the former count, individual and aggregate archive caps", async () => {
    const content = "x".repeat(1024 * 1024 + 1);
    const files: MaterializeFile[] = Array.from({ length: 101 }, (_, index) =>
      index < 11 ? { path: `${index}.txt`, from: "source" } : { path: `${index}.txt`, content: "" },
    );
    const tokens = archiveStore();
    const fileOwner = archiveOwner();
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(
        tokens,
        {
          getExecution: async () => execution,
          getWorkflowGraph: async () => graphWithFiles(content, files),
        },
        fileOwner.owner,
      ),
    );
    const response = await request(app)
      .get("/api/public/executions/materialize/grant")
      .buffer(true)
      .parse(binaryParser as unknown as (str: string) => unknown);
    expect(response.status).toBe(200);
    expect(fileOwner.submitted).toHaveLength(1);
    const source = fileOwner.submitted[0].source;
    expect(source.type).toBe("materialize-text-set");
    if (source.type !== "materialize-text-set") throw new Error("wrong source");
    expect(source.files).toHaveLength(101);
    expect(source.files[10].content).toBe(content);
    expect((response.body as Buffer).length).toBeGreaterThan(10 * 1024 * 1024);
  });

  test("returns no tar and preserves the grant for a declared non-string source", async () => {
    const tokens = archiveStore();
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
      createExecutionMaterializeRoutes(tokens, repository, archiveOwner().owner),
    );

    const response = await request(app).get("/api/public/executions/materialize/grant");
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).not.toContain("application/x-tar");
    expect(response.body.error).toBe("Materialize archive could not be generated");
    expect(tokens.getMaterializeArchive()).toBeNull();
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
      const tokens = archiveStore(() => true, scenario.validate ?? (() => grant));
      const repository = {
        getExecution: async () => scenario.execution,
        getWorkflowGraph: async () => scenario.graph,
      };
      const app = express().use(
        "/api/public/executions",
        createExecutionMaterializeRoutes(tokens, repository, archiveOwner().owner),
      );
      const response = await request(app).get("/api/public/executions/materialize/grant");
      expect(response.status).toBe(scenario.expectedStatus);
      expect(response.headers["content-type"]).not.toContain("application/x-tar");
      expect(typeof response.body.error).toBe("string");
      expect(tokens.getMaterializeArchive()).toBeNull();
    }
  });

  test("forwards unexpected failures to the HTTP error boundary", async () => {
    const tokens = archiveStore();
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
      .use(
        "/api/public/executions",
        createExecutionMaterializeRoutes(tokens, repository, archiveOwner().owner),
      )
      .use(boundary);

    const response = await request(app).get("/api/public/executions/materialize/grant");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(response.body)).not.toContain("unexpected repository defect");
    expect(tokens.getMaterializeArchive()).toBeNull();
  });
});
