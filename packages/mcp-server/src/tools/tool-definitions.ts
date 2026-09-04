import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpPromptContext } from "@mcp-moira/shared";
import {
  getSessionInfoSchema,
  helpSchema,
  listWorkflowsSchema,
  manageArtifactsSchema,
  manageLocksSchema,
  manageNotesSchema,
  manageReconciliationSchema,
  manageWorkflowSchema,
  settingsSchema,
  startSchema,
  stepSchema,
  tokenSchema,
} from "./tool-schemas.js";

export type ToolResponsePolicy = "json" | "text" | "json-or-text" | "formatted-text";

export interface ToolDocumentation {
  summary: string;
  result: string;
}

export interface ToolDescriptionScope {
  description?: string;
  models?: Readonly<Record<string, string>>;
}

export interface ToolDescriptions {
  default: string;
  agents?: Readonly<Record<string, ToolDescriptionScope>>;
}

export interface ToolDefinition<
  Name extends string = string,
  Schema extends z.AnyZodObject = z.AnyZodObject,
> {
  name: Name;
  descriptions: ToolDescriptions;
  schema: Schema;
  responsePolicy: ToolResponsePolicy;
  invoke: (params: z.infer<Schema>) => Promise<ToolInvocationResult>;
  examples: readonly Readonly<Record<string, unknown>>[];
  documentation: {
    en: ToolDocumentation;
    ru: ToolDocumentation;
  };
}

export interface ToolCallResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ToolResultLike {
  success: boolean;
  data?: unknown;
  error?: string;
}

type ToolInvocationResult = ToolCallResult | ToolResultLike;

function isToolResultLike(result: ToolInvocationResult): result is ToolResultLike {
  return typeof (result as ToolResultLike).success === "boolean";
}

function renderToolResult(result: ToolResultLike, policy: ToolResponsePolicy): ToolCallResult {
  if (!result.success) {
    return { content: [{ type: "text", text: `Error: ${result.error ?? "Unknown error"}` }] };
  }
  const text =
    policy === "json"
      ? (JSON.stringify(result.data, null, 2) ?? "No result")
      : typeof result.data === "string"
        ? result.data
        : result.data === undefined
          ? "No result"
          : JSON.stringify(result.data, null, 2);
  return { content: [{ type: "text", text }] };
}

type ToolDefinitionInput<Name extends string, Schema extends z.AnyZodObject> = Omit<
  ToolDefinition<Name, Schema>,
  "descriptions"
>;

function readStaticToolDescription(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), "config/prompts", relativePath), "utf8");
}

function defineTool<const Name extends string, Schema extends z.AnyZodObject>(
  definition: ToolDefinitionInput<Name, Schema>,
  agents?: ToolDescriptions["agents"],
): ToolDefinition<Name, Schema> {
  return {
    ...definition,
    descriptions: {
      default: readStaticToolDescription(`toolDescriptions/${definition.name}.md`),
      ...(agents && { agents }),
    },
  };
}

export const TOOL_DEFINITIONS = [
  defineTool({
    name: "list",
    schema: listWorkflowsSchema,
    responsePolicy: "json",
    invoke: async (params) => (await import("./list-workflows.js")).listWorkflows(params),
    examples: [
      { limit: 20, offset: 0 },
      { limit: 20, offset: 20 },
    ],
    documentation: {
      en: {
        summary: "Discover workflows available to the current user.",
        result:
          "A workflow page with explicit offset, limit, returnedCount, hasMore, and nextOffset.",
      },
      ru: {
        summary: "Показывает доступные текущему пользователю процессы.",
        result:
          "Страница каталога процессов с явными offset, limit, returnedCount, hasMore и nextOffset.",
      },
    },
  }),
  defineTool({
    name: "reconciliation",
    schema: manageReconciliationSchema,
    responsePolicy: "json",
    invoke: async (params) =>
      (await import("./manage-reconciliation.js")).manageReconciliation(params),
    examples: [{ action: "status" }],
    documentation: {
      en: {
        summary:
          "Inspect or resolve bundled-workflow reconciliation errors. Status returns candidate references to every agent and full candidate states to administrators. Get and resolve are administrator-only; use Workflow Management Flow to semantically merge candidates, then submit the merged graph.",
        result: "Conflict status, a candidate, or a resolution result.",
      },
      ru: {
        summary: "Показывает и разрешает конфликты сверки встроенных процессов.",
        result: "Статус конфликта, кандидат или результат разрешения.",
      },
    },
  }),
  defineTool({
    name: "start",
    schema: startSchema,
    responsePolicy: "text",
    invoke: async (params) => (await import("./start-workflow.js")).startWorkflow(params),
    examples: [{ workflowId: "moira/quick-task", parentExecutionId: "none" }],
    documentation: {
      en: {
        summary: "Start a workflow execution.",
        result: "The process ID and first instruction.",
      },
      ru: {
        summary: "Запускает выполнение процесса.",
        result: "Идентификатор выполнения и первая инструкция.",
      },
    },
  }),
  defineTool(
    {
      name: "step",
      schema: stepSchema,
      responsePolicy: "text",
      invoke: async (params) => {
        const result = await (await import("./execute-step.js")).executeStep(params);
        if (!result.success) {
          return {
            content: [{ type: "text", text: result.error ?? "No result" }],
            isError: true,
          };
        }
        return renderToolResult(result, "text");
      },
      examples: [
        { processId: "00000000-0000-4000-8000-000000000000", input: { outcome: "completed" } },
      ],
      documentation: {
        en: {
          summary: "Continue an existing workflow execution.",
          result: "The next instruction or terminal result.",
        },
        ru: {
          summary: "Продолжает существующее выполнение процесса.",
          result: "Следующая инструкция или итоговый результат.",
        },
      },
    },
    {
      cursor: {
        description: readStaticToolDescription("agents/cursor/toolDescriptions/step.md"),
      },
    },
  ),
  defineTool({
    name: "manage",
    schema: manageWorkflowSchema,
    responsePolicy: "json",
    invoke: async (params) => (await import("./manage-workflow.js")).manageWorkflow(params),
    examples: [
      {
        action: "get",
        workflowId: "moira/quick-task",
        includeNodes: false,
        includeValidation: false,
      },
      { action: "list-nodes", workflowId: "moira/quick-task", includePreview: true },
      { action: "get-nodes", workflowId: "moira/quick-task", nodeIds: ["start", "end"] },
      { action: "analyze-variables", workflowId: "moira/quick-task" },
      { action: "set-visibility", workflowId: "my-workflow", visibility: "private" },
    ],
    documentation: {
      en: {
        summary: "Create, inspect, validate, and modify workflows.",
        result: "Action-specific workflow data.",
      },
      ru: {
        summary: "Создаёт, проверяет и изменяет процессы.",
        result: "Данные процесса, зависящие от операции.",
      },
    },
  }),
  defineTool({
    name: "help",
    schema: helpSchema,
    responsePolicy: "text",
    invoke: async (params) =>
      (await import("./get-help.js")).getHelp(params, () => renderToolReference("en")),
    examples: [{ topic: "tools" }],
    documentation: {
      en: {
        summary: "Read runtime documentation and the factual tool reference.",
        result: "Markdown documentation.",
      },
      ru: {
        summary: "Возвращает документацию и фактический справочник инструментов.",
        result: "Документация в Markdown.",
      },
    },
  }),
  defineTool({
    name: "settings",
    schema: settingsSchema,
    responsePolicy: "json",
    invoke: async (params) => (await import("./manage-settings.js")).manageSettings(params),
    examples: [
      { action: "get", key: "ui.theme" },
      { action: "get", category: "notifications" },
      { action: "get" },
    ],
    documentation: {
      en: {
        summary: "Read or update user settings.",
        result: "Masked setting data or an update result.",
      },
      ru: {
        summary: "Читает или изменяет настройки пользователя.",
        result: "Безопасно скрытые настройки или результат изменения.",
      },
    },
  }),
  defineTool({
    name: "token",
    schema: tokenSchema,
    responsePolicy: "formatted-text",
    invoke: async (params) => {
      const result = await (await import("./create-workflow-token.js")).createWorkflowToken(params);
      if (!result.success) return renderToolResult(result, "formatted-text");
      const { formatUploadToken, formatDownloadToken } = await import("../messages/index.js");
      const text =
        params.action === "upload"
          ? formatUploadToken(result.data as Parameters<typeof formatUploadToken>[0])
          : formatDownloadToken(result.data as Parameters<typeof formatDownloadToken>[0]);
      return { content: [{ type: "text", text }] };
    },
    examples: [{ action: "upload", ttlMinutes: 60 }],
    documentation: {
      en: {
        summary: "Create short-lived workflow upload or download tokens.",
        result: "A formatted URL and usage instructions.",
      },
      ru: {
        summary: "Создаёт временные токены загрузки или скачивания процесса.",
        result: "Ссылка и инструкция по использованию.",
      },
    },
  }),
  defineTool({
    name: "session",
    schema: getSessionInfoSchema,
    responsePolicy: "json-or-text",
    invoke: async (params) => (await import("./get-session-info.js")).getSessionInfo(params),
    examples: [{ action: "executions", limit: 20, offset: 0 }],
    documentation: {
      en: {
        summary: "Inspect and update execution-scoped state.",
        result: "Action-specific session or execution data.",
      },
      ru: {
        summary: "Читает и изменяет состояние выполнения.",
        result: "Данные сессии или выполнения для выбранной операции.",
      },
    },
  }),
  defineTool({
    name: "notes",
    schema: manageNotesSchema,
    responsePolicy: "json",
    invoke: async (params) => (await import("./manage-notes.js")).manageNotes(params),
    examples: [{ action: "list", limit: 20, offset: 0 }],
    documentation: {
      en: { summary: "Store and retrieve versioned notes.", result: "Action-specific note data." },
      ru: {
        summary: "Хранит и возвращает версионируемые заметки.",
        result: "Данные заметок для выбранной операции.",
      },
    },
  }),
  defineTool({
    name: "artifacts",
    schema: manageArtifactsSchema,
    responsePolicy: "json",
    invoke: async (params) => (await import("./manage-artifacts.js")).manageArtifacts(params),
    examples: [{ action: "list", limit: 20, offset: 0 }],
    documentation: {
      en: {
        summary: "Manage static HTML artifacts.",
        result: "Artifact metadata, quota data, or a token.",
      },
      ru: {
        summary: "Управляет статическими HTML-артефактами.",
        result: "Метаданные, квота или токен артефакта.",
      },
    },
  }),
  defineTool({
    name: "lock",
    schema: manageLocksSchema,
    responsePolicy: "json",
    invoke: async (params) => (await import("./manage-locks.js")).manageLocks(params),
    examples: [{ action: "status", executionId: "00000000-0000-4000-8000-000000000000" }],
    documentation: {
      en: {
        summary: "Inspect, create, or unlock execution locks.",
        result: "Lock state without a secret PIN.",
      },
      ru: {
        summary: "Проверяет, создаёт или снимает блокировки выполнения.",
        result: "Состояние блокировки без секретного PIN-кода.",
      },
    },
  }),
] as const;

export type McpToolName = (typeof TOOL_DEFINITIONS)[number]["name"];
export type AnyToolDefinition = (typeof TOOL_DEFINITIONS)[number];

export async function invokeToolDefinition(
  definition: AnyToolDefinition,
  params: unknown,
): Promise<ToolCallResult> {
  const parsed = definition.schema.parse(params);
  const invoke = definition.invoke as (validated: unknown) => Promise<ToolInvocationResult>;
  const result = await invoke(parsed);
  return isToolResultLike(result) ? renderToolResult(result, definition.responsePolicy) : result;
}
export const MCP_TOOL_NAMES = TOOL_DEFINITIONS.map(
  (definition) => definition.name,
) as readonly McpToolName[];

const definitionsByName = new Map<McpToolName, AnyToolDefinition>(
  TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);

export function getToolDefinition(name: McpToolName): AnyToolDefinition {
  const definition = definitionsByName.get(name);
  if (!definition) throw new Error(`Unknown MCP tool definition: ${name}`);
  return definition;
}

export function getToolInputShape(name: McpToolName): ZodRawShape {
  return getToolDefinition(name).schema.shape;
}

export function resolveToolDescription(
  definition: Pick<ToolDefinition, "descriptions">,
  context?: McpPromptContext,
): string {
  const agent = context?.agent ?? undefined;
  const model = context?.model ?? undefined;
  const scope = agent ? definition.descriptions.agents?.[agent] : undefined;
  const source =
    (model ? scope?.models?.[model] : undefined) ??
    scope?.description ??
    definition.descriptions.default;
  return source;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function getToolJsonSchema(definition: Pick<ToolDefinition, "schema">) {
  return zodToJsonSchema(definition.schema as ZodTypeAny, {
    $refStrategy: "none",
    strictUnions: true,
    pipeStrategy: "input",
  });
}

type ToolContractSource = Pick<
  ToolDefinition,
  "name" | "descriptions" | "schema" | "responsePolicy" | "examples" | "documentation"
>;

export function getToolContractProjection(
  definitions: readonly ToolContractSource[] = TOOL_DEFINITIONS,
): unknown {
  return definitions.map((definition) => ({
    name: definition.name,
    descriptions: definition.descriptions,
    schema: getToolJsonSchema(definition),
    responsePolicy: definition.responsePolicy,
    examples: definition.examples,
    documentation: definition.documentation,
  }));
}

export function computeContractRevision(projection: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(projection)))
    .digest("hex");
}

export function computeToolContractRevision(): string {
  return computeContractRevision(getToolContractProjection());
}

export function getToolOperations(definition: AnyToolDefinition): readonly string[] {
  const schema = getToolJsonSchema(definition) as {
    properties?: { action?: { enum?: string[] } };
  };
  return schema.properties?.action?.enum ?? [];
}

export function renderToolReference(locale: "en" | "ru" = "en", headingLevel: 1 | 2 = 1): string {
  const headingPrefix = "#".repeat(headingLevel);
  const toolHeadingPrefix = "#".repeat(headingLevel + 1);
  const detailHeadingPrefix = "#".repeat(headingLevel + 2);
  const heading =
    locale === "ru" ? `${headingPrefix} Инструменты MCP` : `${headingPrefix} MCP tools`;
  const lines = [heading, ""];
  for (const definition of TOOL_DEFINITIONS) {
    const docs = definition.documentation[locale];
    const operations = getToolOperations(definition);
    lines.push(`${toolHeadingPrefix} \`${definition.name}\``, "", docs.summary, "");
    if (operations.length > 0) {
      lines.push(
        `${locale === "ru" ? "Операции" : "Actions"}: ${operations.map((action) => `\`${action}\``).join(", ")}.`,
        "",
      );
    }
    const inputSchema = getToolJsonSchema(definition);
    lines.push(
      locale === "ru"
        ? `${detailHeadingPrefix} Схема входа`
        : `${detailHeadingPrefix} Input schema`,
      "",
    );
    lines.push("```json", JSON.stringify(inputSchema, null, 2), "```", "");
    lines.push(`${locale === "ru" ? "Результат" : "Result"}: ${docs.result}`, "");
    for (const example of definition.examples) {
      lines.push("```json", JSON.stringify(example, null, 2), "```", "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
