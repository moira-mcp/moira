import { createHash } from "node:crypto";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpPromptContext } from "@mcp-moira/shared";
import { toolDescriptions } from "./tool-descriptions.js";
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
  communicationSchema,
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
  Schema extends ZodTypeAny = ZodTypeAny,
> {
  name: Name;
  descriptions: ToolDescriptions;
  schema: Schema;
  responsePolicy: ToolResponsePolicy;
  examples: readonly Readonly<Record<string, unknown>>[];
  documentation: {
    en: ToolDocumentation;
    ru: ToolDocumentation;
  };
}

type ToolDefinitionInput<Name extends string, Schema extends ZodTypeAny> = Omit<
  ToolDefinition<Name, Schema>,
  "descriptions"
>;

const staticDescriptions = toolDescriptions as {
  default: Readonly<Record<string, string>>;
  agents: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

function getStaticDescription(name: string): string {
  const description = staticDescriptions.default[name];
  if (!description) throw new Error(`Missing static MCP tool description: ${name}`);
  return description;
}

function defineTool<const Name extends string, Schema extends ZodTypeAny>(
  definition: ToolDefinitionInput<Name, Schema>,
  agents?: ToolDescriptions["agents"],
): ToolDefinition<Name, Schema> {
  return {
    ...definition,
    descriptions: {
      default: getStaticDescription(definition.name),
      ...(agents && { agents }),
    },
  };
}

export const TOOL_DEFINITIONS = [
  defineTool({
    name: "list",
    schema: listWorkflowsSchema,
    responsePolicy: "json",
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
    examples: [
      { action: "prepare", workflowId: "moira/quick-task", parentExecutionId: "none" },
      { action: "execute", startAttemptId: "00000000-0000-4000-8000-000000000000" },
    ],
    documentation: {
      en: {
        summary: "Prepare, then execute, a replay-safe workflow start.",
        result: "A start attempt receipt or the process ID and first instruction.",
      },
      ru: {
        summary: "Подготавливает, затем выполняет защищённый от повторов запуск процесса.",
        result: "Квитанция попытки запуска либо идентификатор выполнения и первая инструкция.",
      },
    },
  }),
  defineTool(
    {
      name: "step",
      schema: stepSchema,
      responsePolicy: "text",
      examples: [
        {
          processId: "00000000-0000-4000-8000-000000000000",
          attemptId: "11111111-1111-4111-8111-111111111111",
          input: { outcome: "completed" },
        },
      ],
      documentation: {
        en: {
          summary: "Continue an existing workflow execution.",
          result: "The next instruction with its step attempt ID, or a terminal result.",
        },
        ru: {
          summary: "Продолжает существующее выполнение процесса.",
          result: "Следующая инструкция с идентификатором попытки шага или итоговый результат.",
        },
      },
    },
    {
      cursor: {
        description: staticDescriptions.agents.cursor.step,
      },
    },
  ),
  defineTool({
    name: "manage",
    schema: manageWorkflowSchema,
    responsePolicy: "json",
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
    name: "communication",
    schema: communicationSchema,
    responsePolicy: "json",
    examples: [
      { action: "send", message: "The report is ready." },
      {
        action: "attachment-token",
        message: "Report",
        kind: "document",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12000,
      },
    ],
    documentation: {
      en: {
        summary:
          "Send a message to the current user or mint a one-time authenticated attachment upload grant.",
        result: "A channel-safe delivery summary or a short-lived upload grant and endpoint.",
      },
      ru: {
        summary:
          "Отправляет сообщение текущему пользователю или создаёт одноразовый grant для авторизованной загрузки вложения.",
        result: "Безопасная сводка доставки либо временный grant и адрес загрузки.",
      },
    },
  }),
  defineTool({
    name: "session",
    schema: getSessionInfoSchema,
    responsePolicy: "json-or-text",
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
  const schema = zodToJsonSchema(definition.schema as ZodTypeAny, {
    $refStrategy: "none",
    strictUnions: true,
    pipeStrategy: "input",
  });
  return "type" in schema ? schema : { ...schema, type: "object" };
}

export type ToolContractSource = Pick<
  ToolDefinition,
  "name" | "descriptions" | "schema" | "responsePolicy" | "examples" | "documentation"
>;

export interface ToolReferenceEntry {
  name: string;
  summary: string;
  result: string;
  operations: readonly string[];
  inputSchema: unknown;
  examples: readonly Readonly<Record<string, unknown>>[];
}

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

export const MCP_TOOLS_REVISION = computeToolContractRevision();

export function getToolOperations(definition: AnyToolDefinition): readonly string[] {
  const schema = getToolJsonSchema(definition) as {
    properties?: { action?: { enum?: string[] } };
    anyOf?: Array<{ properties?: { action?: { const?: string; enum?: string[] } } }>;
    oneOf?: Array<{ properties?: { action?: { const?: string; enum?: string[] } } }>;
  };
  const direct = schema.properties?.action?.enum;
  if (direct) return direct;
  return [...(schema.anyOf ?? schema.oneOf ?? [])].flatMap((branch) => {
    const action = branch.properties?.action;
    return action?.enum ?? (action?.const ? [action.const] : []);
  });
}

export function getToolReferenceModel(
  locale: "en" | "ru" = "en",
  definitions: readonly ToolContractSource[] = TOOL_DEFINITIONS,
): readonly ToolReferenceEntry[] {
  return definitions.map((definition) => ({
    name: definition.name,
    summary: definition.documentation[locale].summary,
    result: definition.documentation[locale].result,
    operations: getToolOperations(definition as AnyToolDefinition),
    inputSchema: getToolJsonSchema(definition),
    examples: definition.examples,
  }));
}

export function renderToolReference(
  locale: "en" | "ru" = "en",
  headingLevel: 1 | 2 = 1,
  definitions: readonly ToolContractSource[] = TOOL_DEFINITIONS,
): string {
  const headingPrefix = "#".repeat(headingLevel);
  const toolHeadingPrefix = "#".repeat(headingLevel + 1);
  const detailHeadingPrefix = "#".repeat(headingLevel + 2);
  const heading =
    locale === "ru" ? `${headingPrefix} Инструменты MCP` : `${headingPrefix} MCP tools`;
  const lines = [heading, ""];
  for (const entry of getToolReferenceModel(locale, definitions)) {
    lines.push(`${toolHeadingPrefix} \`${entry.name}\``, "", entry.summary, "");
    if (entry.operations.length > 0) {
      lines.push(
        `${locale === "ru" ? "Операции" : "Actions"}: ${entry.operations.map((action) => `\`${action}\``).join(", ")}.`,
        "",
      );
    }
    lines.push(
      locale === "ru"
        ? `${detailHeadingPrefix} Схема входа`
        : `${detailHeadingPrefix} Input schema`,
      "",
    );
    lines.push("```json", JSON.stringify(entry.inputSchema, null, 2), "```", "");
    lines.push(`${locale === "ru" ? "Результат" : "Result"}: ${entry.result}`, "");
    for (const example of entry.examples) {
      lines.push("```json", JSON.stringify(example, null, 2), "```", "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
