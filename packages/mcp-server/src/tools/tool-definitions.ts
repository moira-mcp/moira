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
  workspaceApplyPatchSchema,
  workspaceCreateSchema,
  workspaceDeleteSchema,
  workspaceDownloadSchema,
  workspaceExecSchema,
  workspaceGetSchema,
  workspaceListSchema,
  workspaceReadSchema,
  workspaceSearchSchema,
  workspaceStartSchema,
  workspaceStatSchema,
  workspaceStopSchema,
  workspaceUploadSchema,
  workspaceWriteSchema,
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
  _meta?: Readonly<Record<string, unknown>>;
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
  defineTool({
    name: "workspace_list",
    schema: workspaceListSchema,
    responsePolicy: "json",
    examples: [{}],
    documentation: {
      en: {
        summary: "List reusable cloud workspaces and approved repository targets.",
        result: "Sanitized readiness, repository targets, and persistent workspace summaries.",
      },
      ru: {
        summary: "Показывает переиспользуемые облачные workspace и разрешённые репозитории.",
        result: "Безопасные сведения о готовности, репозиториях и постоянных workspace.",
      },
    },
  }),
  defineTool({
    name: "workspace_create",
    schema: workspaceCreateSchema,
    responsePolicy: "json",
    examples: [{ repository_id: "123456", ref: "main" }],
    documentation: {
      en: {
        summary: "Create a persistent user-owned cloud workspace.",
        result: "A sanitized usable or truthfully pending workspace.",
      },
      ru: {
        summary: "Создаёт постоянный пользовательский облачный workspace.",
        result: "Безопасное описание готового или ещё создающегося workspace.",
      },
    },
  }),
  defineTool({
    name: "workspace_get",
    schema: workspaceGetSchema,
    responsePolicy: "json",
    examples: [{ workspace_id: "00000000-0000-4000-8000-000000000000" }],
    documentation: {
      en: { summary: "Inspect one owned workspace.", result: "A sanitized workspace summary." },
      ru: { summary: "Показывает один свой workspace.", result: "Безопасная сводка workspace." },
    },
  }),
  defineTool({
    name: "workspace_start",
    schema: workspaceStartSchema,
    responsePolicy: "json",
    examples: [{ workspace_id: "00000000-0000-4000-8000-000000000000" }],
    documentation: {
      en: { summary: "Start a stopped persistent workspace.", result: "Current workspace state." },
      ru: {
        summary: "Запускает остановленный постоянный workspace.",
        result: "Текущее состояние workspace.",
      },
    },
  }),
  defineTool({
    name: "workspace_stop",
    schema: workspaceStopSchema,
    responsePolicy: "json",
    examples: [{ workspace_id: "00000000-0000-4000-8000-000000000000" }],
    documentation: {
      en: {
        summary: "Stop a workspace while preserving its data.",
        result: "Stopped or pending workspace state with data_preserved=true.",
      },
      ru: {
        summary: "Останавливает workspace с сохранением данных.",
        result: "Остановленное или ожидающее состояние с data_preserved=true.",
      },
    },
  }),
  defineTool({
    name: "workspace_delete",
    schema: workspaceDeleteSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        expected_generation: 3,
        confirm_delete: true,
      },
    ],
    documentation: {
      en: {
        summary: "Permanently delete a workspace using its current generation.",
        result: "Deleted or pending state with data_preserved=false.",
      },
      ru: {
        summary: "Безвозвратно удаляет workspace по его текущему поколению.",
        result: "Удалённое или ожидающее состояние с data_preserved=false.",
      },
    },
  }),
  defineTool({
    name: "workspace_exec",
    _meta: { "openai/fileParams": ["stdin_file"] },
    schema: workspaceExecSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        argv: ["git", "status", "--short"],
        cwd: ".",
        timeout_seconds: 60,
      },
    ],
    documentation: {
      en: {
        summary: "Run one bounded argv command directly in a workspace.",
        result:
          "Durable operation state and bounded stdout, stderr, and exact exit code when terminal.",
      },
      ru: {
        summary: "Выполняет одну ограниченную argv-команду прямо в workspace.",
        result:
          "Состояние операции и ограниченные stdout, stderr и точный код выхода после завершения.",
      },
    },
  }),
  defineTool({
    name: "workspace_stat",
    schema: workspaceStatSchema,
    responsePolicy: "json",
    examples: [{ workspace_id: "00000000-0000-4000-8000-000000000000", path: "package.json" }],
    documentation: {
      en: {
        summary: "Inspect repository-relative file metadata.",
        result: "Bounded file or directory metadata and version.",
      },
      ru: {
        summary: "Показывает метаданные файла относительно репозитория.",
        result: "Ограниченные метаданные файла или каталога и версия.",
      },
    },
  }),
  defineTool({
    name: "workspace_search",
    schema: workspaceSearchSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        path: ".",
        query: "TODO",
        mode: "literal",
        max_matches: 100,
        max_bytes: 65536,
      },
    ],
    documentation: {
      en: {
        summary: "Search repository text with explicit limits.",
        result: "Bounded match coordinates and a truncation flag.",
      },
      ru: {
        summary: "Ищет текст в репозитории с явными ограничениями.",
        result: "Ограниченные координаты совпадений и признак усечения.",
      },
    },
  }),
  defineTool({
    name: "workspace_read",
    schema: workspaceReadSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        path: "src/index.ts",
        offset: 0,
        length: 65536,
      },
    ],
    documentation: {
      en: {
        summary: "Read a bounded UTF-8 byte range from a workspace file.",
        result:
          "Text with offset, total size, and SHA-256; binary data requires workspace_download.",
      },
      ru: {
        summary: "Читает ограниченный UTF-8 диапазон файла workspace.",
        result:
          "Текст, смещение, полный размер и SHA-256; для бинарных данных используется workspace_download.",
      },
    },
  }),
  defineTool({
    name: "workspace_write",
    schema: workspaceWriteSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        path: "notes.txt",
        text: "done\n",
        expected: { exists: false },
      },
    ],
    documentation: {
      en: {
        summary: "Atomically replace one UTF-8 file with preconditions.",
        result: "Previous and current content versions.",
      },
      ru: {
        summary: "Атомарно заменяет один UTF-8 файл с предусловиями.",
        result: "Предыдущая и текущая версии содержимого.",
      },
    },
  }),
  defineTool({
    name: "workspace_apply_patch",
    schema: workspaceApplyPatchSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        files: [
          {
            path: "notes.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 4, text: "ready" }],
          },
        ],
      },
    ],
    documentation: {
      en: {
        summary: "Apply a coherent structured multi-file patch with preconditions.",
        result: "Per-file versions and a bounded content-free edit summary.",
      },
      ru: {
        summary: "Согласованно применяет структурированный патч к нескольким файлам.",
        result: "Версии файлов и ограниченная сводка изменений без содержимого.",
      },
    },
  }),
  defineTool({
    name: "workspace_upload",
    _meta: { "openai/fileParams": ["file"] },
    schema: workspaceUploadSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        path: "input.txt",
        file: {
          file_id: "sediment://file_00000000000000000000000000000000",
          download_url: "https://oaiusercontent.com/example-temporary-file",
          file_name: "input.txt",
          mime_type: "text/plain",
          size_bytes: 12,
        },
        expected: { exists: false },
      },
    ],
    documentation: {
      en: {
        summary: "Atomically upload a native ChatGPT file reference into a workspace.",
        result: "Previous and current file versions without returning source URL or bytes.",
      },
      ru: {
        summary: "Атомарно загружает нативный файловый reference ChatGPT в workspace.",
        result: "Предыдущая и текущая версии без исходной ссылки и байтов.",
      },
    },
  }),
  defineTool({
    name: "workspace_download",
    schema: workspaceDownloadSchema,
    responsePolicy: "json",
    examples: [
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        path: "result.pdf",
        max_bytes: 4194304,
        file_name: "result.pdf",
        mime_type: "application/pdf",
      },
      {
        workspace_id: "00000000-0000-4000-8000-000000000000",
        operation_id: "11111111-1111-4111-8111-111111111111",
        file_name: "result.pdf",
        mime_type: "application/pdf",
      },
    ],
    documentation: {
      en: {
        summary: "Create a one-use native download for a workspace file.",
        result: "An MCP resource_link plus safe file and operation metadata.",
      },
      ru: {
        summary: "Создаёт одноразовую нативную загрузку файла workspace.",
        result: "MCP resource_link и безопасные метаданные файла и операции.",
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

export function getToolJsonSchema(definition: Pick<ToolDefinition, "schema" | "_meta">) {
  const schema = zodToJsonSchema(definition.schema as ZodTypeAny, {
    $refStrategy: "none",
    strictUnions: true,
    pipeStrategy: "input",
  });
  const fileParams = definition._meta?.["openai/fileParams"];
  if (Array.isArray(fileParams) && !("properties" in schema)) {
    const union = schema as {
      anyOf?: Array<{ properties?: Record<string, unknown> }>;
      oneOf?: Array<{ properties?: Record<string, unknown> }>;
    };
    const branches = union.anyOf ?? union.oneOf ?? [];
    const properties: Record<string, unknown> = {};
    for (const field of fileParams) {
      if (typeof field !== "string") throw new Error("File parameter names must be strings");
      const candidates = branches.flatMap((branch) =>
        branch.properties?.[field] ? [branch.properties[field]] : [],
      );
      if (
        !candidates.length ||
        candidates.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(candidates[0]))
      ) {
        throw new Error(`File parameter has no consistent object schema: ${field}`);
      }
      properties[field] = candidates[0];
    }
    // Native-file discovery reads top-level properties. Keep the original closed
    // branches as constraints, so publishing file fields does not permit mixed calls.
    return { ...schema, type: "object", properties };
  }
  return "type" in schema ? schema : { ...schema, type: "object" };
}

export type ToolContractSource = Pick<
  ToolDefinition,
  "name" | "descriptions" | "schema" | "responsePolicy" | "examples" | "documentation" | "_meta"
>;

export interface ToolReferenceEntry {
  name: string;
  summary: string;
  result: string;
  operations: readonly string[];
  inputSchema: unknown;
  examples: readonly Readonly<Record<string, unknown>>[];
  metadata?: Readonly<Record<string, unknown>>;
}

export function getToolContractProjection(
  definitions: readonly ToolContractSource[] = TOOL_DEFINITIONS,
): unknown {
  return definitions.map((definition) => ({
    name: definition.name,
    descriptions: definition.descriptions,
    schema: getToolJsonSchema(definition),
    responsePolicy: definition.responsePolicy,
    ...(definition._meta ? { _meta: definition._meta } : {}),
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
    ...(definition._meta ? { metadata: definition._meta } : {}),
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
    if (entry.metadata) {
      lines.push(
        `${detailHeadingPrefix} ${locale === "ru" ? "Метаданные инструмента" : "Tool metadata"}`,
        "",
        "```json",
        JSON.stringify({ _meta: entry.metadata }, null, 2),
        "```",
        "",
      );
    }
    lines.push(`${locale === "ru" ? "Результат" : "Result"}: ${entry.result}`, "");
    for (const example of entry.examples) {
      lines.push("```json", JSON.stringify(example, null, 2), "```", "");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
