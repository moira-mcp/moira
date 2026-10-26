import { describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MCP_TOOLS_REVISION,
  MCP_TOOL_NAMES,
  TOOL_DEFINITIONS,
  INTERNAL_TOOL_DEFINITIONS,
  PUBLIC_TOOL_SCHEMAS,
  resolvePublicTool,
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
import { WORKSPACE_TOOL_SCHEMAS } from "../../../packages/mcp-server/src/tools/workspace-tool-contract.js";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
import {
  registerTools,
  setToolFailureReporterForTests,
} from "../../../packages/mcp-server/src/tools/register-tools.js";
import {
  TOOL_BINDINGS,
  invokeToolDefinition,
} from "../../../packages/mcp-server/src/tools/tool-bindings.js";
import { ServiceLogger } from "../../../packages/shared/src/logging/logger.js";
import { NotFoundError } from "../../../packages/shared/src/errors/app-error.js";
import { WorkflowNotFoundError } from "../../../packages/shared/src/errors/domain-errors.js";
import { publicToolLogContext } from "../../../packages/mcp-server/src/tools/public-tool-contract.js";

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
  it("retains the complete authored graph through the actual grouped binding", async () => {
    const workflow = {
      metadata: {
        name: "Flow",
        version: "1.0.0",
        description: "Flow",
        schemaVersion: 2,
        authorExtension: { value: false },
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "end" } },
        { id: "end", type: "end" },
      ],
      authorExtension: { value: 0 },
      variableRegistry: { flag: { type: "boolean", description: "Flag", default: false } },
    };
    let received: unknown;
    const restore = replaceToolBinding("manage", async (params: unknown) => {
      received = params;
      return { success: true, data: "retained" };
    });
    try {
      const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "workflow")!;
      await invokeToolDefinition(definition, { action: "validate", workflow });
      expect(received).toEqual({ action: "validate", workflow });
    } finally {
      restore();
    }
  });
  it("rejects missing values and cross-action fields while retaining actual false, null and empty text", () => {
    for (const value of [null, false, 0, ""]) {
      expect(
        PUBLIC_TOOL_SCHEMAS.workflow.safeParse({
          action: "set-variable",
          workflowId: "flow",
          variableName: "value",
          variableValue: value,
        }).success,
      ).toBe(true);
      expect(
        PUBLIC_TOOL_SCHEMAS.execution.safeParse({
          action: "set-variable",
          executionId: "run",
          variableName: "value",
          variableValue: value,
          expectedRevision: 0,
          expectedContextRevision: "a".repeat(64),
        }).success,
      ).toBe(true);
      expect(
        PUBLIC_TOOL_SCHEMAS.settings.safeParse({ action: "set", key: "key", value }).success,
      ).toBe(true);
    }
    const invalid: Array<[McpToolName, unknown]> = [
      ["workflow", { action: "set-variable", workflowId: "flow", variableName: "value" }],
      [
        "execution",
        {
          action: "set-variable",
          executionId: "run",
          variableName: "value",
          expectedRevision: 0,
          expectedContextRevision: "a".repeat(64),
        },
      ],
      ["settings", { action: "set", key: "key" }],
      ["settings", { action: "get", key: "key", category: "notifications" }],
      ["settings", { action: "list", value: false }],
      ["workflow", { action: "get", workflowId: "flow", overwrite: true }],
      ["workflow", { action: "validate", workflowId: "flow" }],
      ["workflow", { action: "edit", workflowId: "flow", changes: {} }],
      [
        "workflow",
        {
          action: "move-node",
          workflowId: "flow",
          nodeId: "node",
          targetIndex: 0,
          afterNodeId: "other",
        },
      ],
      [
        "execution",
        { action: "step", processId: "run", attemptId: "attempt", input: {}, teleportTo: "target" },
      ],
      [
        "execution",
        {
          action: "prepare",
          workflowId: "flow",
          parentExecutionId: "none",
          skipNotificationCheck: true,
          skipTelegramCheck: false,
        },
      ],
      [
        "execution",
        { action: "await-user", executionId: "run", question: "Question?", resolve: true },
      ],
      ["execution", { action: "unlock", executionId: "run", reason: "reason" }],
      ["notes", { action: "delete", key: "key", value: "ignored" }],
      ["playbooks", { action: "restore", name: "name", revision: 1, owner: "other" }],
      ["artifacts", { action: "upload", name: "report", content: "" }],
      ["artifacts", { action: "update", uuid: "id", content: "html", executionId: "ignored" }],
    ];
    for (const [name, input] of invalid)
      expect(PUBLIC_TOOL_SCHEMAS[name].safeParse(input).success).toBe(false);
    expect(
      PUBLIC_TOOL_SCHEMAS.notes.safeParse({ action: "save", key: "key", value: "" }).success,
    ).toBe(true);
    expect(
      PUBLIC_TOOL_SCHEMAS.playbooks.safeParse({ action: "save", name: "name", content: "" })
        .success,
    ).toBe(true);
    expect(
      PUBLIC_TOOL_SCHEMAS.workflow.safeParse({
        action: "clone-node",
        workflowId: "flow",
        nodeId: "node",
      }).success,
    ).toBe(true);
    expect(
      PUBLIC_TOOL_SCHEMAS.workflow.safeParse({ action: "revoke-invite", inviteId: "invite" })
        .success,
    ).toBe(true);
  });

  it("keeps conditional native schema valid before and after root-only client path masking", () => {
    const workspace = encodeReference("workspace", {
      resourceId: "00000000-0000-4000-8000-000000000001",
      provider: "github-codespaces",
      generation: 1,
    });
    const file = {
      file_id: "file_Example",
      download_url: "https://files.oaiusercontent.com/private-signature",
    };
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === "codespace_terminal")!;
    const schema = getToolJsonSchema(definition);
    const ajv = new Ajv({ strict: false });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    const validate = ajv.compile(schema);
    const run = { action: "run", workspace, command: { argv: ["cat"] } };
    const native = { ...run, action: "run_native", stdin_file: file };
    expect(validate(run)).toBe(true);
    expect(validate(native)).toBe(true);
    expect(validate({ ...run, stdin_file: file })).toBe(false);
    expect(validate({ ...native, stdin_file: undefined })).toBe(false);
    expect(validate({ ...native, stdin_file: "/tmp/input" })).toBe(false);
    const masked = structuredClone(schema) as unknown as Record<string, unknown> & {
      properties: Record<string, unknown>;
    };
    masked.properties.stdin_file = { type: "string" };
    const validateMasked = ajv.compile(masked);
    expect(validateMasked({ ...native, stdin_file: "/tmp/input" })).toBe(true);
    expect(validateMasked({ ...run, stdin_file: "/tmp/input" })).toBe(false);
    expect(validateMasked(native)).toBe(false);
    expect(
      PUBLIC_TOOL_SCHEMAS.codespace_terminal.safeParse({ ...native, stdin_file: "/tmp/input" })
        .success,
    ).toBe(false);
  });

  it("routes lifecycle and grouped actions without forwarding selectors or private data to generic logs", () => {
    const workspace = encodeReference("workspace", {
      resourceId: "00000000-0000-4000-8000-000000000001",
      provider: "github-codespaces",
      generation: 1,
    });
    expect(
      resolvePublicTool("codespace", { action: "lifecycle", workspace, operation: "resume_setup" }),
    ).toEqual({
      purpose: "workspace_lifecycle",
      params: { workspace, action: "resume_setup" },
      privateInput: true,
    });
    expect(resolvePublicTool("execution", { action: "lock_status", executionId: "run" })).toEqual({
      purpose: "lock",
      params: { executionId: "run", action: "status" },
      privateInput: false,
    });
    const input = {
      action: "run_native",
      workspace,
      command: { script: "secret command" },
      stdin_file: {
        file_id: "file_Example",
        download_url: "https://files.oaiusercontent.com/signed-secret",
      },
    };
    expect(publicToolLogContext("codespace_terminal", input)).toEqual({
      inputData: { workspace_tool: "command_run_native" },
      resourceIds: {},
    });
    expect(JSON.stringify(publicToolLogContext("codespace_terminal", input))).not.toMatch(
      /secret|file_Example|https/,
    );
  });
  it("keeps the fileless-agent codespace instruction in the canonical default prompt", () => {
    const canonical = readFileSync(resolve("config/prompts/systemPrompt.md"), "utf8");
    expect(canonical).toContain(
      "inspect the available workspace capabilities and look for an authorized codespace that fits",
    );
    expect(canonical).toContain("creating or accessing it still requires the user's authority");
    expect(canonical).toContain(
      "rather than claim execution or verification you could not observe",
    );
  });

  it("publishes the agreed groups without old public purpose aliases", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(
      [
        "codespace",
        "codespace_terminal",
        "codespace_read",
        "codespace_search",
        "codespace_edit",
        "codespace_upload",
        "codespace_download",
        "codespace_git",
        "workflow",
        "execution",
        "communication",
        "notes",
        "playbooks",
        "artifacts",
        "settings",
        "help",
      ].sort(),
    );
    for (const old of [
      "list",
      "start",
      "step",
      "manage",
      "session",
      "token",
      "lock",
      "reconciliation",
      ...Object.keys(WORKSPACE_TOOL_SCHEMAS),
    ])
      expect(MCP_TOOL_NAMES).not.toContain(old);
  });

  it("publishes native files as required only for the matching strict purposes", async () => {
    const published = await inspectPublishedContract("native file handoff");
    for (const [name, field] of [
      ["codespace_upload", "file"],
      ["codespace_terminal", "stdin_file"],
      ["communication", "file"],
    ]) {
      const tool = published.tools.find((candidate) => candidate.name === name)!;
      const schema = dereferenceLocalJsonSchema(tool.inputSchema) as {
        required: string[];
        properties: Record<string, { required: string[] }>;
      };
      expect(schema.required ?? []).toEqual(
        name === "codespace_upload"
          ? expect.arrayContaining([field])
          : expect.not.arrayContaining([field]),
      );
      expect(schema.properties[field].required.slice().sort()).toEqual(["download_url", "file_id"]);
      expect(tool._meta).toEqual({ "openai/fileParams": [field] });
    }
    const changed = TOOL_DEFINITIONS.map((definition) => ({ ...definition, _meta: undefined }));
    expect(computeContractRevision(getToolContractProjection(changed))).not.toBe(
      MCP_TOOLS_REVISION,
    );
    expect(renderToolReference("en")).toContain('"openai/fileParams"');
  });

  it("requires returned references, separates observe-only identities and refuses agent-supplied authority", () => {
    const workspace = encodeReference("workspace", {
      resourceId: "00000000-0000-4000-8000-000000000001",
      provider: "github-codespaces",
      generation: 2,
    });
    const identity = encodeReference("workspace-identity", {
      resourceId: "00000000-0000-4000-8000-000000000001",
      provider: "github-codespaces",
    });
    expect(
      WORKSPACE_TOOL_SCHEMAS.workspace_observe.safeParse({ workspace: identity }).success,
    ).toBe(true);
    expect(
      WORKSPACE_TOOL_SCHEMAS.workspace_delete.safeParse({
        workspace: identity,
        confirm_delete: true,
      }).success,
    ).toBe(false);
    expect(WORKSPACE_TOOL_SCHEMAS.workspace_delete.safeParse({ workspace }).success).toBe(false);
    expect(
      WORKSPACE_TOOL_SCHEMAS.workspace_delete.safeParse({ workspace, confirm_delete: true })
        .success,
    ).toBe(true);
    for (const field of [
      "request_id",
      "generation",
      "device_id",
      "provider",
      "credential",
      "url",
      "chat_id",
    ]) {
      expect(
        WORKSPACE_TOOL_SCHEMAS.command_run.safeParse({
          workspace,
          command: { argv: ["true"] },
          [field]: "private",
        }).success,
      ).toBe(false);
    }
    expect(
      WORKSPACE_TOOL_SCHEMAS.command_run.safeParse({
        workspace,
        command: { argv: ["cat"] },
        stdin_file: {
          file_id: "file_Example",
          download_url: "https://files.oaiusercontent.com/example",
        },
      }).success,
    ).toBe(false);
    expect(
      WORKSPACE_TOOL_SCHEMAS.command_run_native.safeParse({ workspace, command: { argv: ["cat"] } })
        .success,
    ).toBe(false);
    expect(
      WORKSPACE_TOOL_SCHEMAS.communication_send.safeParse({
        message: "ready",
        recipient: "someone",
      }).success,
    ).toBe(false);
    expect(
      WORKSPACE_TOOL_SCHEMAS.file_download.safeParse({ workspace, path: "report.bin" }).success,
    ).toBe(true);
  });

  it("preserves native image content through the registered MCP boundary", async () => {
    const native = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" };
    const restore = replaceToolBinding("file_preview", async () => ({ content: [native] }));
    const server = new McpServer(
      { name: "native-preview", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, undefined, () => null);
    const client = new Client({ name: "image-consumer", version: "1.0.0" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const workspace = encodeReference("workspace", {
        resourceId: "00000000-0000-4000-8000-000000000001",
        provider: "github-codespaces",
        generation: 1,
      });
      expect(
        (
          await client.callTool({
            name: "codespace_read",
            arguments: { action: "preview", workspace, path: "image.png" },
          })
        ).content,
      ).toEqual([native]);
    } finally {
      restore();
      await client.close();
      await server.close();
    }
  });

  it("keeps every documented example valid against its runtime schema", () => {
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.examples.length).toBeGreaterThan(0);
      for (const example of definition.examples) {
        expect(definition.schema.safeParse(example).success).toBe(true);
        const schema: z.ZodTypeAny = definition.schema;
        const request: Readonly<Record<string, unknown>> = example;
        expect(schema.safeParse(request)).toMatchObject({ success: true });
      }
    }

    const start = TOOL_DEFINITIONS.find((definition) => definition.name === "execution")!;
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
      expect(tool.inputSchema).toEqual(
        getToolJsonSchema(TOOL_DEFINITIONS.find((definition) => definition.name === tool.name)!),
      );
    }
  });

  it("publishes distinct strict prepare and execute catalog branches", async () => {
    const published = await inspectPublishedContract("start schema");
    const start = published.tools.find((tool) => tool.name === "execution");
    expect(start).toBeDefined();
    const schema = dereferenceLocalJsonSchema(start!.inputSchema) as {
      type?: string;
      anyOf: Array<{
        additionalProperties: boolean;
        properties: Record<string, { const?: string }>;
        required: string[];
      }>;
    };

    const prepare = schema.anyOf.find((branch) => branch.properties.action.const === "prepare")!;
    const execute = schema.anyOf.find((branch) => branch.properties.action.const === "execute")!;
    expect(prepare).toMatchObject({
      additionalProperties: false,
      required: ["action", "workflowId", "parentExecutionId"],
    });
    expect(execute).toMatchObject({
      additionalProperties: false,
      required: ["action", "startAttemptId"],
    });
    expect(prepare.properties).not.toHaveProperty("startAttemptId");
    expect(execute.properties).not.toHaveProperty("workflowId");
  });

  it("derives the complete operation inventory from schemas", () => {
    const manage = TOOL_DEFINITIONS.find((definition) => definition.name === "workflow")!;
    for (const action of ["list-nodes", "get-nodes", "analyze-variables", "set-visibility"]) {
      expect(getToolOperations(manage)).toContain(action);
    }
    const manageJsonSchema = getToolJsonSchema(manage) as unknown as {
      anyOf: Array<{ properties: { workflow?: { type: string }; changes?: { type: string } } }>;
    };
    expect(
      manageJsonSchema.anyOf.some((branch) => branch.properties.workflow?.type === "object"),
    ).toBe(true);
    expect(
      manageJsonSchema.anyOf.some((branch) => branch.properties.changes?.type === "object"),
    ).toBe(true);

    const session = TOOL_DEFINITIONS.find((definition) => definition.name === "execution")!;
    expect(
      session.schema.safeParse({
        action: "execution_context",
        executionId: "id",
        variables: ["secret"],
      }).success,
    ).toBe(false);
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
      anyOf: Array<{
        properties: {
          key?: { minLength: number; pattern: string };
          category?: { minLength: number; pattern: string };
        };
      }>;
    };
    expect(projected.anyOf.find((branch) => branch.properties.key)?.properties.key).toEqual(
      expect.objectContaining({ minLength: 1, pattern: "\\S" }),
    );
    expect(
      projected.anyOf.find((branch) => branch.properties.category)?.properties.category,
    ).toEqual(expect.objectContaining({ minLength: 1, pattern: "\\S" }));
  });

  it("computes the current client cache revision directly from the contract", () => {
    expect(MCP_TOOLS_REVISION).toBe(computeToolContractRevision());
    expect(MCP_TOOLS_REVISION).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps executable bindings exhaustive without duplicating contract order", () => {
    expect(Object.keys(TOOL_BINDINGS).sort()).toEqual(
      INTERNAL_TOOL_DEFINITIONS.map((definition) => definition.name).sort(),
    );
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
    ).find((definition) => definition.name === "execution")!;
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
        name: "workflow",
        arguments: { action: "list", search: "private search term" },
      })) as { isError?: boolean; content: Array<{ text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe("Error: Internal server error");
      expect(JSON.stringify(result)).not.toMatch(/sqlite|private\.db|private search term/);
      expect(records.reported).toEqual([{ toolName: "workflow", error: failure }]);
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
        name: "workflow",
        arguments: { action: "list", search: "private search term" },
      })) as { isError?: boolean };

      expect(result.isError).toBe(true);
      expect(records.emitted).toEqual([
        { level, message: "MCP tool failed", error: failure, meta: { tool: "workflow" } },
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
        name: "workflow",
        arguments: { action: "reconciliation_status" },
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
        name: "execution",
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
      expect(errorText).toMatch(/Invalid|Unrecognized/i);
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

    expect(description("workflow")).toContain("Results are paginated");
    expect(description("workflow")).toContain("nextOffset");
    expect(description("workflow")).not.toContain("list all accessible workflows");
    expect(description("workflow")).not.toMatch(/stable ordering/i);

    expect(description("execution")).toContain("no execution or workflow effect is created");
    expect(description("execution")).toContain(
      "completed calls reuse the same durable receipt and attempt",
    );
    expect(description("execution")).toContain(
      "current common language guidance without rewriting the saved receipt",
    );
    expect(description("execution")).toContain("ATTEMPT_OUTCOME_UNKNOWN");

    const manage = TOOL_DEFINITIONS.find((definition) => definition.name === "workflow")!;
    expect(description("workflow")).toContain("input schema's strict `action` branches");
    expect(description("workflow")).toContain("invitations");
    expect(description("workflow")).toContain("access");
    expect(description("workflow")).toContain("`variableRegistry`");
    expect(description("workflow")).not.toMatch(/Actions \(\d+ total\)/);
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

    expect(description("execution")).toContain("never returns the generated PIN");
    expect(description("execution")).toContain("user supplies the PIN");
    expect(description("execution")).not.toMatch(/returns (a )?PIN/i);
    const lock = TOOL_DEFINITIONS.find((definition) => definition.name === "execution")!;
    expect(
      lock.schema.safeParse({ action: "unlock", executionId: "execution", pin: "123456" }).success,
    ).toBe(true);

    expect(description("notes")).toContain("Use `stats` for the current total storage limit");
    expect(description("notes")).toContain("first page of notes");
    expect(description("notes")).toContain("`limit` and `offset`");
    expect(description("notes")).not.toContain('notes({ action: "list" }) - all notes');
    expect(description("notes")).not.toMatch(/100KB|1MB total/i);
    expect(description("artifacts")).toContain(
      "stats: Effective file-size, storage and artifact-count limits and usage",
    );
    expect(description("artifacts")).toContain(
      "policies are server-configured and may have user overrides",
    );
    expect(description("artifacts")).not.toMatch(/30 days|5MB|100MB|50 per user/i);

    expect(description("help")).toContain("Call without `topic`");
    expect(description("help")).toContain("current topic names and accepted aliases");
    expect(description("help")).not.toContain("without parameters for overview");
    expect(description("help")).not.toContain("Getting Started: introduction");
    expect(description("workflow")).toContain("`current`, `incoming`, or `previous`");
    expect(description("execution")).toContain("active or completed states");
    expect(description("execution")).toContain("Process ID, directive, success criteria");
    expect(description("execution")).toContain(
      "active-child, system-reminder, and teleport context",
    );
    expect(description("execution")).toContain("not a complete step input/output transcript");
    expect(description("execution")).not.toContain("FULL execution history");
    expect(description("execution")).not.toContain("ONLY current directive and inputSchema");

    const cursorStep = description("execution", { agent: "cursor" });
    expect(cursorStep).toContain("Cursor input note:");
    expect(cursorStep).toContain("[object Object]");
    expect(cursorStep).not.toContain("VERY IMPORTANT");
  });

  it("changes initialization instructions without changing static Cursor tool descriptions", async () => {
    const first = await inspectPublishedContract("database prompt alpha", { agent: "cursor" });
    const second = await inspectPublishedContract("unrelated prompt beta", { agent: "cursor" });
    const step = TOOL_DEFINITIONS.find((definition) => definition.name === "execution")!;
    const help = TOOL_DEFINITIONS.find((definition) => definition.name === "help")!;

    expect(first.instructions).toBe("database prompt alpha");
    expect(second.instructions).toBe("unrelated prompt beta");
    expect(first.tools.find((tool) => tool.name === "execution")?.description).toBe(
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

    for (const reference of [english, russian]) {
      for (const [index, definition] of TOOL_DEFINITIONS.entries()) {
        const next = TOOL_DEFINITIONS[index + 1];
        const start = reference.indexOf(`## \`${definition.name}\``);
        const end = next ? reference.indexOf(`## \`${next.name}\``, start) : reference.length;
        const block = reference.slice(start, end);
        for (const example of definition.examples) {
          expect(block).toContain(JSON.stringify(example, null, 2));
        }
      }
    }
  });

  it("offsets generated fragment headings without changing standalone help", () => {
    const standalone = renderToolReference("en");
    const fragment = renderToolReference("en", 2);

    expect(standalone).toMatch(/^# MCP tools\n/);
    expect(standalone).toContain("\n## `workflow`\n");
    expect(fragment).toMatch(/^## MCP tools\n/);
    expect(fragment).toContain("\n### `workflow`\n");
    expect(fragment).toContain("\n#### Input schema\n");
    expect(fragment).not.toMatch(/^# /m);
  });
});
