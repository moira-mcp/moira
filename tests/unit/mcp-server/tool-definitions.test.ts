import { describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { MCP_TOOLS_REVISION } from "../../../packages/shared/src/config/mcp-tools-revision.generated.js";
import {
  MCP_TOOL_NAMES,
  TOOL_DEFINITIONS,
  computeContractRevision,
  computeToolContractRevision,
  getToolContractProjection,
  getToolJsonSchema,
  getToolOperations,
  resolveToolDescription,
  renderToolReference,
} from "../../../packages/mcp-server/src/tools/tool-definitions.js";
import { registerTools } from "../../../packages/mcp-server/src/tools/register-tools.js";

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
      "session",
      "notes",
      "artifacts",
      "lock",
    ]);
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

    const settings = TOOL_DEFINITIONS.find((definition) => definition.name === "settings")!;
    expect(settings.examples).toContainEqual({ action: "get", key: "ui.theme" });
    expect(settings.examples).toContainEqual({ action: "get", category: "notifications" });
    expect(settings.examples).toContainEqual({ action: "get" });
  });

  it("derives the complete operation inventory from schemas", () => {
    const manage = TOOL_DEFINITIONS.find((definition) => definition.name === "manage")!;
    for (const action of ["list-nodes", "get-nodes", "analyze-variables", "set-visibility"]) {
      expect(getToolOperations(manage)).toContain(action);
    }
    const manageJsonSchema = getToolJsonSchema(manage) as {
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
    const projected = getToolJsonSchema({ schema }) as {
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

    const projected = getToolJsonSchema(settings) as {
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

  it("keeps the generated client cache revision current", () => {
    expect(MCP_TOOLS_REVISION).toBe(computeToolContractRevision());
    expect(MCP_TOOLS_REVISION).toMatch(/^[a-f0-9]{64}$/);
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

  it("publishes the complete catalog with static descriptions through MCP", async () => {
    const server = new McpServer(
      { name: "tool-definition-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server);

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
        const expectedSchema = zodToJsonSchema(definition.schema, {
          $refStrategy: "none",
        });
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

    expect(description("list")).toContain("first page, not the complete catalog");
    expect(description("list")).toContain("nextOffset");
    expect(description("list")).not.toContain("list all accessible workflows");
    expect(description("list")).not.toMatch(/stable ordering/i);

    expect(description("start")).toContain(
      "without creating an execution or returning a processId",
    );
    expect(description("start")).toContain("Otherwise, returns a processId");

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
      { action: "get", key: "ui.theme" },
      { action: "get", category: "notifications" },
      { action: "get" },
      { action: "list", category: "notifications" },
      { action: "set", key: "ui.theme", value: "dark" },
    ]) {
      expect(settings.schema.safeParse(input).success).toBe(true);
    }
    expect(description("settings")).toContain('settings({ action: "get", key: "ui.theme" })');
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
      for (const parameter of Object.keys(definition.schema.shape)) {
        expect(block).toContain(`"${parameter}"`);
      }
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
