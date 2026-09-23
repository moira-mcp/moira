import { describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CODESPACE_TOOL_NAME,
  MCP_TOOLS_REVISION,
  MCP_TOOL_NAMES,
  TOOL_DEFINITIONS,
  computeContractRevision,
  computeToolContractRevision,
  getToolContractProjection,
  getToolJsonSchema,
  getToolOperations,
  getToolReferenceModel,
  resolveToolDescription,
  renderToolReference,
  type McpToolName,
} from "../../../packages/mcp-server/src/tools/tool-definitions.js";
import {
  codespaceDownloadRequestSchema,
  codespaceExecRequestSchema,
} from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import {
  registerTools,
  setToolFailureReporterForTests,
} from "../../../packages/mcp-server/src/tools/register-tools.js";
import { TOOL_BINDINGS } from "../../../packages/mcp-server/src/tools/tool-bindings.js";
import { ServiceLogger } from "../../../packages/shared/src/logging/logger.js";
import { NotFoundError } from "../../../packages/shared/src/errors/app-error.js";
import { WorkflowNotFoundError } from "../../../packages/shared/src/errors/domain-errors.js";

/**
 * Observes the records the production reporters emit: the logger call itself, with its level, so a
 * test sees what an operator would see rather than only the seam the reporter passes through.
 */
function captureLoggerRecords(): {
  emitted: Array<{ level: string; message: string; error: unknown; meta?: unknown }>;
  reported: Array<{ toolName: string; error: unknown }>;
  restore: () => void;
} {
  const emitted: Array<{ level: string; message: string; error: unknown; meta?: unknown }> = [];
  const original = { error: ServiceLogger.prototype.error, warn: ServiceLogger.prototype.warn };
  for (const level of ["error", "warn"] as const) {
    ServiceLogger.prototype[level] = function capture(
      message: string,
      error?: unknown,
      meta?: unknown,
    ) {
      emitted.push({ level, message, error, meta });
    } as (typeof ServiceLogger.prototype)[typeof level];
  }
  return {
    emitted,
    reported: [],
    restore: () => {
      ServiceLogger.prototype.error = original.error;
      ServiceLogger.prototype.warn = original.warn;
    },
  };
}

function replaceToolBinding(
  name: keyof typeof TOOL_BINDINGS,
  binding: (typeof TOOL_BINDINGS)[keyof typeof TOOL_BINDINGS],
): () => void {
  const bindings = TOOL_BINDINGS as Record<string, unknown>;
  const previous = bindings[name];
  bindings[name] = binding;
  return () => {
    bindings[name] = previous;
  };
}

function dereferenceLocalJsonSchema(schema: unknown): unknown {
  const root = structuredClone(schema) as Record<string, unknown>;

  const resolvePointer = (pointer: string): unknown =>
    pointer
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], root);

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
      return visit(resolvePointer(record.$ref));
    }
    return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, visit(nested)]));
  };

  return visit(root);
}

function getRenderedToolSchema(reference: string, name: string): unknown {
  const toolHeading = new RegExp("^#{2,3} `" + name + "`$", "m");
  const start = reference.search(toolHeading);
  if (start < 0) throw new Error(`Missing rendered tool section: ${name}`);
  const schemaFence = reference.indexOf("```json\n", start);
  if (schemaFence < 0) throw new Error(`Missing rendered schema: ${name}`);
  const schemaStart = schemaFence + "```json\n".length;
  const schemaEnd = reference.indexOf("\n```", schemaStart);
  if (schemaEnd < 0) throw new Error(`Unterminated rendered schema: ${name}`);
  return JSON.parse(reference.slice(schemaStart, schemaEnd));
}

async function inspectPublishedContract(instructions: string, context?: { agent?: string }) {
  const server = new McpServer(
    { name: "tool-description-test", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions },
  );
  registerTools(server, context);

  const client = new Client(
    { name: "tool-description-client", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP tool definitions", () => {
  it("keeps the fileless-agent codespace instruction in every system-prompt copy", () => {
    const canonical = readFileSync(resolve("config/prompts/systemPrompt.md"), "utf8");
    expect(canonical).toContain(
      "If you cannot read or write the user's files, do not tell them what to run in a terminal you cannot see. Use a codespace: look for one that already fits the task, and offer to create one when none does.",
    );
    expect(readFileSync(resolve("docs/SYSTEM-PROMPT.md"), "utf8")).toBe(canonical);
    expect(
      readFileSync(resolve("packages/docs/src/content/docs/docs/SYSTEM-PROMPT.md"), "utf8"),
    ).toBe(canonical);
  });

  it("owns the exact baseline public catalog in registration order", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "list",
      "reconciliation",
      "start",
      "step",
      "manage",
      "help",
      "settings",
      "token",
      "communication",
      "session",
      "notes",
      "playbooks",
      "artifacts",
      "lock",
      "codespace",
    ]);
    expect(MCP_TOOL_NAMES.filter((name) => name.startsWith("codespace_"))).toEqual([]);
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === CODESPACE_TOOL_NAME)?.name).toBe(
      CODESPACE_TOOL_NAME,
    );
    expect(readFileSync(resolve("packages/mcp-server/src/server.ts"), "utf8")).toContain(
      "toolName === CODESPACE_TOOL_NAME",
    );
  });

  it("publishes closed codespace schemas without chat, session, auth, or provider controls", () => {
    const definition = (name: string) =>
      TOOL_DEFINITIONS.find((candidate) => candidate.name === name)!;
    const forbidden = [
      "chat_id",
      "session_id",
      "user_id",
      "oauth_state",
      "provider_token",
      "ssh_key",
      "capability",
    ];
    const serializedSchema = JSON.stringify(getToolJsonSchema(definition("codespace")));
    for (const field of forbidden) expect(serializedSchema).not.toContain(`"${field}"`);

    // `delete` is refused its own incomplete form at dispatch, not by the published object, which
    // now carries every action's fields; the published object still refuses an action it has never
    // heard of.
    expect(
      definition("codespace").schema.safeParse({
        action: "delete",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        expected_generation: 2,
      }).success,
    ).toBe(true);
    expect(definition("codespace").schema.safeParse({ action: "teleport" }).success).toBe(false);
    // The published schema is one flat root object: `action` is the only required field, every
    // action's fields are visible, and the strict per-action contract decides the form.
    const published = getToolJsonSchema(definition("codespace")) as unknown as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(published.type).toBe("object");
    expect(published.required).toEqual(["action"]);
    expect(Object.keys(published.properties).sort()).toEqual([
      "action",
      "argv",
      "background",
      "cancel",
      "codespace_id",
      "confirm_delete",
      "cwd",
      "env",
      "expected",
      "expected_generation",
      "file",
      "file_name",
      "files",
      "length",
      "max_bytes",
      "max_matches",
      "max_stderr_bytes",
      "max_stdout_bytes",
      "mime_type",
      "mode",
      "offset",
      "operation_id",
      "path",
      "query",
      "ref",
      "refresh",
      "repository_id",
      "script",
      "session",
      "session_end",
      "session_start",
      "stdin_file",
      "stdin_text",
      "stream",
      "text",
      "timeout_seconds",
    ]);
    const operationId = published.properties.operation_id as { anyOf?: unknown[] };
    const maxBytes = published.properties.max_bytes as { anyOf?: unknown[] };
    expect(operationId.anyOf).toBeUndefined();
    expect(maxBytes.anyOf).toHaveLength(2);
    expect(getToolOperations(definition("codespace"))).toEqual(
      expect.arrayContaining(["list", "setup_help", "create", "get"]),
    );
    expect(resolveToolDescription(definition("codespace"))).toContain(
      "personal instrument for executing a flow",
    );
    expect(resolveToolDescription(definition("codespace"))).toContain(
      "collaboration happens through version-control branches",
    );
    expect(
      codespaceExecRequestSchema.safeParse({
        codespace_id: "00000000-0000-4000-8000-000000000000",
        argv: ["node", "script.js"],
        timeout_seconds: 30,
        stdin_file: {
          file_id: "sediment://file_00000000000000000000000000000000",
          download_url: "https://oaiusercontent.com/file",
          file_name: "input.bin",
          mime_type: "application/octet-stream",
        },
      }).success,
    ).toBe(true);
    expect(
      codespaceExecRequestSchema.safeParse({
        codespace_id: "00000000-0000-4000-8000-000000000000",
        argv: ["node", "script.js"],
        timeout_seconds: 30,
        stdin_text: "input",
        stdin_file: {
          file_id: "sediment://file_123",
          download_url: "https://oaiusercontent.com/file",
        },
      }).success,
    ).toBe(false);
    expect(
      codespaceExecRequestSchema.safeParse({
        codespace_id: "00000000-0000-4000-8000-000000000000",
        operation_id: "00000000-0000-4000-8000-000000000001",
        argv: ["npm", "test"],
        timeout_seconds: 30,
      }).success,
    ).toBe(false);
    expect(
      definition("codespace").schema.safeParse({
        action: "exec",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        chat_id: "c1",
      }).success,
    ).toBe(false);
  });

  it("requires bounded output metadata for download recovery and rejects mixing it with a new path", () => {
    const download = codespaceDownloadRequestSchema;
    const resume = {
      codespace_id: "00000000-0000-4000-8000-000000000000",
      operation_id: "00000000-0000-4000-8000-000000000001",
      file_name: "result.bin",
      mime_type: "application/octet-stream",
    };
    expect(download.safeParse(resume).success).toBe(true);
    expect(download.safeParse({ ...resume, path: "new.bin" }).success).toBe(false);
    expect(download.safeParse({ ...resume, max_bytes: 0 }).success).toBe(false);
    expect(download.safeParse({ ...resume, file_name: "../result.bin" }).success).toBe(false);
    // The published object requires only `action`; `file_name` and `mime_type` are required of a
    // download by its own contract, which is what refuses this resume without them.
    const codespaceTool = TOOL_DEFINITIONS.find((definition) => definition.name === "codespace")!;
    expect(
      (getToolJsonSchema(codespaceTool) as unknown as { required: string[] }).required,
    ).toEqual(["action"]);
    expect(
      download.safeParse({ codespace_id: resume.codespace_id, path: "result.bin" }).success,
    ).toBe(false);
  });

  it("publishes native file metadata and optional file details at the top-level MCP boundary", async () => {
    const published = await inspectPublishedContract("native file handoff");
    const tool = published.tools.find((candidate) => candidate.name === "codespace")!;
    // Both native file parameters belong to the one tool, so both are declared on it.
    expect(tool._meta).toEqual({ "openai/fileParams": ["stdin_file", "file"] });
    for (const field of ["stdin_file", "file"]) {
      const schema = dereferenceLocalJsonSchema(tool.inputSchema) as {
        properties: Record<string, { required: string[]; properties: Record<string, unknown> }>;
      };
      expect(schema.properties[field].required.slice().sort()).toEqual(["download_url", "file_id"]);
      expect(schema.properties[field].properties).toEqual(
        expect.objectContaining({
          file_name: expect.any(Object),
          mime_type: expect.any(Object),
        }),
      );
    }
    const changed = TOOL_DEFINITIONS.map((definition) => ({ ...definition, _meta: undefined }));
    expect(computeContractRevision(getToolContractProjection(changed))).not.toBe(
      MCP_TOOLS_REVISION,
    );
    expect(renderToolReference("en")).toContain('"openai/fileParams"');
    expect(renderToolReference("ru")).toContain('"stdin_file"');
  });

  it("publishes a strict communication contract without authority controls", () => {
    const communication = TOOL_DEFINITIONS.find(
      (definition) => definition.name === "communication",
    )!;
    expect(communication.descriptions.default).toContain(
      "a valid MCP Bearer credential for the same user",
    );
    expect(communication.descriptions.default).not.toContain("the same MCP Bearer credential");
    expect(communication.schema.safeParse({ action: "send", message: "ready" }).success).toBe(true);
    expect(
      communication.schema.safeParse({ action: "send", message: "ready", recipient: "123" })
        .success,
    ).toBe(false);
    const schema = getToolJsonSchema(communication) as unknown as {
      properties: Record<string, unknown>;
    };
    for (const forbidden of [
      "recipient",
      "provider",
      "credential",
      "url",
      "path",
      "headers",
      "ttl",
    ])
      expect(schema.properties).not.toHaveProperty(forbidden);
    expect(
      communication.schema.safeParse({
        action: "attachment-token",
        message: "report",
        kind: "document",
        filename: "../report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      }).success,
    ).toBe(false);
  });

  it("keeps every documented example valid against its runtime schema", () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.examples.length).toBeGreaterThan(0);
      for (const example of definition.examples) {
        expect(definition.schema.safeParse(example).success).toBe(true);
      }
    }

    const start = TOOL_DEFINITIONS.find((definition) => definition.name === "start")!;
    expect(start.schema.safeParse({ workflowId: "moira/quick-task" }).success).toBe(false);
    expect(
      start.schema.safeParse({
        action: "prepare",
        workflowId: "moira/quick-task",
        parentExecutionId: "none",
        skipNotificationCheck: true,
      }).success,
    ).toBe(true);
    expect(
      start.schema.safeParse({
        action: "prepare",
        workflowId: "moira/quick-task",
        parentExecutionId: "none",
        skipTelegramCheck: true,
      }).success,
    ).toBe(true);
    expect(start.descriptions.default).toContain("skipNotificationCheck");
    expect(start.descriptions.default).toContain("deprecated alias");
    expect(start.descriptions.default).toContain("Lock PIN delivery remains mandatory");

    const settings = TOOL_DEFINITIONS.find((definition) => definition.name === "settings")!;
    expect(settings.examples).toContainEqual({ action: "get", key: "telegram.enabled" });
    expect(settings.examples).toContainEqual({ action: "get", category: "notifications" });
    expect(settings.examples).toContainEqual({ action: "get" });
  });

  it("publishes every MCP tool with a root-object input schema", async () => {
    const published = await inspectPublishedContract("root object schemas");

    for (const tool of published.tools) {
      const schema = dereferenceLocalJsonSchema(tool.inputSchema) as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("oneOf");
    }
  });

  it("publishes a flat Start catalog contract with both action field sets", async () => {
    const published = await inspectPublishedContract("start schema");
    const start = published.tools.find((tool) => tool.name === "start");
    expect(start).toBeDefined();
    const schema = dereferenceLocalJsonSchema(start!.inputSchema) as {
      type?: string;
      additionalProperties?: boolean;
      properties?: Record<string, { enum?: string[]; description?: string }>;
      required?: string[];
    };

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["action"],
    });
    expect(schema.properties?.action?.enum).toEqual(["prepare", "execute"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "action",
        "workflowId",
        "note",
        "parentExecutionId",
        "skipNotificationCheck",
        "skipTelegramCheck",
        "startAttemptId",
      ]),
    );
    expect(schema.properties?.workflowId?.description).toContain("prepare");
    expect(schema.properties?.startAttemptId?.description).toContain("execute");
  });

  it("derives the complete operation inventory from schemas", () => {
    const manage = TOOL_DEFINITIONS.find((definition) => definition.name === "manage")!;
    for (const action of ["list-nodes", "get-nodes", "analyze-variables", "set-visibility"]) {
      expect(getToolOperations(manage)).toContain(action);
    }
    const manageJsonSchema = getToolJsonSchema(manage) as unknown as {
      properties?: { workflow?: { type?: string }; changes?: { type?: string } };
    };
    expect(manageJsonSchema.properties?.workflow?.type).toBe("object");
    expect(manageJsonSchema.properties?.changes?.type).toBe("object");

    const session = TOOL_DEFINITIONS.find((definition) => definition.name === "session")!;
    expect(Object.keys(session.schema.shape)).not.toContain("variables");
  });

  it("uses the MCP SDK input conversion semantics for reusable tool schemas", () => {
    const schema = z.object({
      choice: z.union([z.string(), z.unknown()]),
      piped: z
        .string()
        .transform((value) => value.length)
        .pipe(z.number()),
    });
    const projected = getToolJsonSchema({ schema }) as unknown as {
      properties: { choice: unknown; piped: unknown };
    };
    const sdkSemantics = zodToJsonSchema(schema, {
      $refStrategy: "none",
      strictUnions: true,
      pipeStrategy: "input",
    });

    expect(projected).toEqual(sdkSemantics);
    expect(projected.properties.choice).toEqual({ anyOf: [{ type: "string" }] });
    expect(projected.properties.piped).toEqual({ type: "string" });
  });

  it("projects blank settings selector rejection into the published JSON Schema", () => {
    const settings = TOOL_DEFINITIONS.find((definition) => definition.name === "settings")!;
    expect(settings.schema.safeParse({ action: "get", key: "   " }).success).toBe(false);
    expect(settings.schema.safeParse({ action: "get", category: "   " }).success).toBe(false);

    const projected = getToolJsonSchema(settings) as unknown as {
      properties: {
        key: { minLength?: number; pattern?: string };
        category: { minLength?: number; pattern?: string };
      };
    };
    expect(projected.properties.key).toEqual(
      expect.objectContaining({ minLength: 1, pattern: "\\S" }),
    );
    expect(projected.properties.category).toEqual(
      expect.objectContaining({ minLength: 1, pattern: "\\S" }),
    );
  });

  it("computes the current client cache revision directly from the contract", () => {
    expect(MCP_TOOLS_REVISION).toBe(computeToolContractRevision());
    expect(MCP_TOOLS_REVISION).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps executable bindings exhaustive without duplicating contract order", () => {
    expect(Object.keys(TOOL_BINDINGS).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });

  it("projects one contract change into the revision, runtime reference, and public model", () => {
    const marker = "Direct contract projection marker";
    const changed = TOOL_DEFINITIONS.map((definition, index) =>
      index === 0
        ? {
            ...definition,
            documentation: {
              ...definition.documentation,
              en: { ...definition.documentation.en, summary: marker },
            },
          }
        : definition,
    );

    expect(computeContractRevision(getToolContractProjection(changed))).not.toBe(
      MCP_TOOLS_REVISION,
    );
    expect(renderToolReference("en", 1, changed)).toContain(marker);
    expect(getToolReferenceModel("en", changed)[0].summary).toBe(marker);
  });

  it("keeps revisions stable for key ordering and changes them for client-visible facts", () => {
    const projection = getToolContractProjection();
    const reordered = JSON.parse(JSON.stringify(projection), (_key, value) => {
      if (!value || Array.isArray(value) || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).reverse());
    });
    expect(computeContractRevision(reordered)).toBe(computeContractRevision(projection));

    const runtimeChanged = TOOL_DEFINITIONS.map((definition) => ({
      ...definition,
      invoke: async () => ({ success: true, data: "different runtime implementation" }),
    }));
    expect(computeContractRevision(getToolContractProjection(runtimeChanged))).toBe(
      computeContractRevision(projection),
    );

    const changedSchema = structuredClone(projection);
    (changedSchema as Array<{ schema: { description?: string } }>)[0].schema.description =
      "client-visible change";
    expect(computeContractRevision(changedSchema)).not.toBe(computeContractRevision(projection));

    const changedExample = structuredClone(projection);
    (changedExample as Array<{ examples: unknown[] }>)[0].examples.push({ limit: 21 });
    expect(computeContractRevision(changedExample)).not.toBe(computeContractRevision(projection));

    const changedDefaultDescription = structuredClone(projection);
    (
      changedDefaultDescription as Array<{ descriptions: { default: string } }>
    )[0].descriptions.default += " changed";
    expect(computeContractRevision(changedDefaultDescription)).not.toBe(
      computeContractRevision(projection),
    );

    const changedAgentDescription = structuredClone(projection);
    const step = (
      changedAgentDescription as Array<{
        name: string;
        descriptions: { agents?: Record<string, { description?: string }> };
      }>
    ).find((definition) => definition.name === "step")!;
    step.descriptions.agents!.cursor.description += " changed";
    expect(computeContractRevision(changedAgentDescription)).not.toBe(
      computeContractRevision(projection),
    );
  });

  it("records a suppressed tool failure server-side while the caller keeps the sanitized text", async () => {
    // A message the sanitizer suppresses is exactly the case that used to leave no trace.
    const failure = new Error("sqlite disk I/O error at /var/lib/moira/private.db");
    const restoreBinding = replaceToolBinding("list", async () => {
      throw failure;
    });
    const records = captureLoggerRecords();
    const restoreReporter = setToolFailureReporterForTests((toolName, error) => {
      records.reported.push({ toolName, error });
    });
    const server = new McpServer(
      { name: "tool-failure-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, undefined, () => null);
    const client = new Client({ name: "tool-failure-client", version: "1.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = (await client.callTool({
        name: "list",
        arguments: { search: "private search term" },
      })) as { isError?: boolean; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe("Error: Internal server error");
      expect(JSON.stringify(result)).not.toMatch(/sqlite|private\.db|private search term/);
      expect(records.reported).toEqual([{ toolName: "list", error: failure }]);
      expect(JSON.stringify(records.reported.map(({ toolName }) => toolName))).not.toContain(
        "private search term",
      );
    } finally {
      restoreBinding();
      restoreReporter();
      records.restore();
      await client.close();
      await server.close();
    }
  });

  it.each<[string, Error, "error" | "warn"]>([
    [
      "an unexpected failure",
      new Error("sqlite disk I/O error at /var/lib/moira/private.db"),
      "error",
    ],
    [
      "an operational failure",
      new NotFoundError("Workflow not found", { workflowId: "missing-workflow" }),
      "warn",
    ],
    // A domain error counts as operational only after normalization, which is the project's rule.
    ["a domain failure", new WorkflowNotFoundError("missing-workflow", "slug"), "warn"],
  ])("classifies %s the way this project classifies failures", async (_name, failure, level) => {
    // The default reporter is left in place: the level it chooses is the property under test.
    const restoreBinding = replaceToolBinding("list", async () => {
      throw failure;
    });
    const records = captureLoggerRecords();
    const server = new McpServer(
      { name: "tool-level-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, undefined, () => null);
    const client = new Client({ name: "tool-level-client", version: "1.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = (await client.callTool({
        name: "list",
        arguments: { search: "private search term" },
      })) as { isError?: boolean };

      expect(result.isError).toBe(true);
      expect(records.emitted).toEqual([
        { level, message: "MCP tool failed", error: failure, meta: { tool: "list" } },
      ]);
    } finally {
      restoreBinding();
      records.restore();
      await client.close();
      await server.close();
    }
  });

  it("records a failure from the tool that answers its own failures", async () => {
    // reconciliation catches internally and returns a sanitized result, so the registration
    // wrapper never sees it: the record has to come from the tool itself.
    const records = captureLoggerRecords();
    const server = new McpServer(
      { name: "tool-own-failure-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, undefined, () => null);
    const client = new Client({ name: "tool-own-failure-client", version: "1.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = (await client.callTool({
        name: "reconciliation",
        arguments: { action: "status" },
      })) as { isError?: boolean; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(records.emitted).toEqual([
        {
          level: "error",
          message: "MCP tool failed",
          error: expect.any(Error),
          meta: { tool: "reconciliation" },
        },
      ]);
    } finally {
      records.restore();
      await client.close();
      await server.close();
    }
  });

  it("publishes the complete catalog with static descriptions through MCP", async () => {
    const server = new McpServer(
      { name: "tool-definition-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, undefined, () => null);

    const client = new Client(
      { name: "tool-definition-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const published = await client.listTools();
      const projection = getToolContractProjection() as Array<{ name: string; schema: unknown }>;
      const renderedReference = renderToolReference("en");

      expect(published.tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
      for (const definition of TOOL_DEFINITIONS) {
        const tool = published.tools.find((candidate) => candidate.name === definition.name);
        const expectedSchema = getToolJsonSchema(definition);
        const publishedSchema = dereferenceLocalJsonSchema(tool?.inputSchema);
        expect(tool?.description).toBe(resolveToolDescription(definition));
        expect(publishedSchema).toEqual(dereferenceLocalJsonSchema(expectedSchema));
        expect(
          dereferenceLocalJsonSchema(
            projection.find((candidate) => candidate.name === definition.name)?.schema,
          ),
        ).toEqual(publishedSchema);
        expect(
          dereferenceLocalJsonSchema(getRenderedToolSchema(renderedReference, definition.name)),
        ).toEqual(publishedSchema);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a mixed start execute payload through the registered MCP boundary", async () => {
    const server = new McpServer(
      { name: "start-discrimination-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, undefined, () => null);
    const client = new Client(
      { name: "start-discrimination-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "start",
        arguments: {
          action: "execute",
          startAttemptId: "00000000-0000-4000-8000-000000000000",
          workflowId: "must-not-be-read",
        },
      });
      expect(result.isError).toBe(true);
      const [firstBlock] = result.content as Array<{ type: string; text: string }>;
      expect(firstBlock).toMatchObject({ type: "text" });
      const errorText = firstBlock.text;
      expect(errorText).toContain("Unrecognized key");
      expect(errorText).toContain("workflowId");
      expect(errorText).not.toContain("must-not-be-read");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("selects model, agent, and default descriptions without database state", () => {
    const descriptions = {
      default: "default",
      agents: {
        cursor: {
          description: "agent",
          models: { "cursor-small": "model", empty: "" },
        },
      },
    };

    expect(resolveToolDescription({ descriptions })).toBe("default");
    expect(resolveToolDescription({ descriptions }, { agent: "cursor" })).toBe("agent");
    expect(
      resolveToolDescription({ descriptions }, { agent: "cursor", model: "cursor-small" }),
    ).toBe("model");
    expect(resolveToolDescription({ descriptions }, { agent: "cursor", model: "empty" })).toBe("");
  });

  it("keeps static descriptions aligned with pagination, schema, secrets, and runtime policy", () => {
    const description = (name: McpToolName, context?: { agent?: string }) =>
      resolveToolDescription(
        TOOL_DEFINITIONS.find((definition) => definition.name === name)!,
        context,
      );

    expect(description("list")).toContain("Results are paginated");
    expect(description("list")).toContain("nextOffset");
    expect(description("list")).not.toContain("list all accessible workflows");
    expect(description("list")).not.toMatch(/stable ordering/i);

    expect(description("start")).toContain("no execution or workflow effect is created");
    expect(description("start")).toContain("completed calls replay the exact stored receipt");
    expect(description("start")).toContain("ATTEMPT_OUTCOME_UNKNOWN");

    const manage = TOOL_DEFINITIONS.find((definition) => definition.name === "manage")!;
    expect(description("manage")).toContain("input schema's `action` enum");
    expect(description("manage")).toContain("invitations");
    expect(description("manage")).toContain("access");
    expect(description("manage")).toContain("`variableRegistry`");
    expect(description("manage")).not.toMatch(/Actions \(\d+ total\)/);
    expect(getToolOperations(manage)).toContain("create-invite");
    expect(getToolOperations(manage)).toContain("revoke-invite");
    expect(getToolOperations(manage)).toContain("list-access");
    expect(getToolOperations(manage)).toContain("revoke-access");

    const settings = TOOL_DEFINITIONS.find((definition) => definition.name === "settings")!;
    for (const input of [
      { action: "get", key: "telegram.enabled" },
      { action: "get", category: "notifications" },
      { action: "get" },
      { action: "list", category: "notifications" },
      { action: "set", key: "telegram.enabled", value: false },
    ]) {
      expect(settings.schema.safeParse(input).success).toBe(true);
    }
    expect(description("settings")).toContain(
      'settings({ action: "get", key: "telegram.enabled" })',
    );
    expect(description("settings")).toContain(
      'settings({ action: "get", category: "notifications" })',
    );
    expect(description("settings")).toContain('settings({ action: "get" })');
    expect(description("settings")).not.toContain("notifications.telegram");

    expect(description("lock")).toContain("never returns the generated PIN");
    expect(description("lock")).toContain("user supplies the PIN");
    expect(description("lock")).not.toMatch(/returns (a )?PIN/i);
    const lock = TOOL_DEFINITIONS.find((definition) => definition.name === "lock")!;
    expect(
      lock.schema.safeParse({ action: "unlock", executionId: "execution", pin: "123456" }).success,
    ).toBe(true);

    expect(description("notes")).toContain("Use `stats` for the current total storage limit");
    expect(description("notes")).toContain("first page of notes");
    expect(description("notes")).toContain("`limit` and `offset`");
    expect(description("notes")).not.toContain('notes({ action: "list" }) - all notes');
    expect(description("notes")).not.toMatch(/100KB|1MB total/i);
    expect(description("artifacts")).toContain("Use `stats` for the current storage");
    expect(description("artifacts")).toContain("may be administrator-configured");
    expect(description("artifacts")).not.toMatch(/30 days|5MB|100MB|50 per user/i);

    expect(description("help")).toContain("Call without `topic`");
    expect(description("help")).toContain("current topic names and accepted aliases");
    expect(description("help")).not.toContain("without parameters for overview");
    expect(description("help")).not.toContain("Getting Started: introduction");
    expect(description("reconciliation")).toContain("`current`, `incoming`, or `previous`");
    expect(description("session")).toContain("active or completed states");
    expect(description("session")).toContain("Process ID, directive, success criteria");
    expect(description("session")).toContain("active-child, system-reminder, and teleport context");
    expect(description("session")).toContain("not a complete step input/output transcript");
    expect(description("session")).not.toContain("FULL execution history");
    expect(description("session")).not.toContain("ONLY current directive and inputSchema");

    const cursorStep = description("step", { agent: "cursor" });
    expect(cursorStep).toContain("Cursor input note:");
    expect(cursorStep).toContain("[object Object]");
    expect(cursorStep).not.toContain("VERY IMPORTANT");
  });

  it("changes initialization instructions without changing static Cursor tool descriptions", async () => {
    const first = await inspectPublishedContract("database prompt alpha", { agent: "cursor" });
    const second = await inspectPublishedContract("unrelated prompt beta", { agent: "cursor" });
    const step = TOOL_DEFINITIONS.find((definition) => definition.name === "step")!;
    const help = TOOL_DEFINITIONS.find((definition) => definition.name === "help")!;

    expect(first.instructions).toBe("database prompt alpha");
    expect(second.instructions).toBe("unrelated prompt beta");
    expect(first.tools.find((tool) => tool.name === "step")?.description).toBe(
      resolveToolDescription(step, { agent: "cursor" }),
    );
    expect(resolveToolDescription(step, { agent: "cursor" })).not.toBe(
      resolveToolDescription(step),
    );
    expect(first.tools.find((tool) => tool.name === "help")?.description).toBe(
      resolveToolDescription(help, { agent: "cursor" }),
    );
    expect(second.tools.find((tool) => tool.name === "help")?.description).toBe(
      first.tools.find((tool) => tool.name === "help")?.description,
    );
  });

  it("renders matching English and Russian factual references", () => {
    const english = renderToolReference("en");
    const russian = renderToolReference("ru");
    for (const name of MCP_TOOL_NAMES) {
      expect(english).toContain(`## \`${name}\``);
      expect(russian).toContain(`## \`${name}\``);
    }
    expect(english).toContain("### Input schema");
    expect(english).toContain('"parentExecutionId"');
    expect(english).toContain('"required": [');
    expect(english).toContain('"maxLength": 500');
    expect(russian).toContain("### Схема входа");
    expect(russian).toContain('"set-visibility"');

    for (const [index, definition] of TOOL_DEFINITIONS.entries()) {
      const next = TOOL_DEFINITIONS[index + 1];
      const start = english.indexOf(`## \`${definition.name}\``);
      const end = next ? english.indexOf(`## \`${next.name}\``, start) : english.length;
      const block = english.slice(start, end);
      for (const example of definition.examples) {
        expect(block).toContain(JSON.stringify(example, null, 2));
      }
    }
  });

  it("offsets generated fragment headings without changing standalone help", () => {
    const standalone = renderToolReference("en");
    const fragment = renderToolReference("en", 2);

    expect(standalone).toMatch(/^# MCP tools\n/);
    expect(standalone).toContain("\n## `list`\n");
    expect(fragment).toMatch(/^## MCP tools\n/);
    expect(fragment).toContain("\n### `list`\n");
    expect(fragment).toContain("\n#### Input schema\n");
    expect(fragment).not.toMatch(/^# /m);
  });
});
