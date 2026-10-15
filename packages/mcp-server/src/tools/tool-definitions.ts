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
  managePlaybooksSchema,
  manageReconciliationSchema,
  manageWorkflowSchema,
  settingsSchema,
  startSchema,
  stepSchema,
  tokenSchema,
  communicationSchema,
  codespaceSchema,
  codespaceProcessSchema,
} from "./tool-schemas.js";

/**
 * The one definition of the published name of this tool. The catalogue entry and the server's
 * log-context selector both read it, so neither can be renamed without the other.
 */
export const CODESPACE_TOOL_NAME = "codespace" as const;
export const CODESPACE_PROCESS_TOOL_NAME = "codespace_process" as const;

export type ToolResponsePolicy = "json" | "text" | "json-or-text" | "formatted-text" | "native";

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
        summary:
          "Create, inspect, validate, and modify workflows. Express a decision as `cases` on the node that has the evidence (a directive routes on its own answer, `success` when no case holds) with single-purpose arithmetic as its `expressions`; keep a separate condition or expression node only for a shared or standalone decision. Bind a progress block to the list it works through with `list`.",
        result: "Action-specific workflow data.",
      },
      ru: {
        summary:
          "Создаёт, проверяет и изменяет процессы. Решение выражайте через `cases` на ноде, у которой есть данные (директива маршрутизирует по своему ответу, `success` — когда ни один кейс не сработал), а простую арифметику — через её `expressions`; отдельную ноду condition или expression оставляйте только для общего или самостоятельного решения. Блок прогресса привязывайте к списку, по которому он идёт, через `list`.",
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
      { action: "get", key: "telegram.enabled" },
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
    _meta: { "openai/fileParams": ["file"] },
    schema: communicationSchema,
    responsePolicy: "json",
    examples: [
      { action: "send", message: "The report is ready." },
      {
        action: "deliver-file",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
        message: "Report",
        kind: "document",
        referenceId:
          "owner-file://workspace/00000000-0000-4000-8000-000000000000/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      {
        action: "operation",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
        device_id: "00000000-0000-4000-8000-000000000000",
      },
    ],
    documentation: {
      en: {
        summary:
          "Send ordinary text or deliver a native/owner-held file through configured channels. Binary delivery requires an original ws1 request_id and an available source owner; operation collects its receipt without resending.",
        result:
          "A text delivery summary or an owner receipt with its original request and assigned device/workspace identity. Uncertainty preserves that identity; no cloud file grant is issued.",
      },
      ru: {
        summary:
          "Отправляет обычный текст либо native-файл/файл владельца через настроенные каналы. Для файла нужны исходный request_id вида ws1 и доступный владелец источника; operation читает результат без повторной отправки.",
        result:
          "Сводка текстовой доставки либо квитанция владельца с исходным запросом и устройством/средой. Неопределённость сохраняет эту идентичность; облачный grant файла не создаётся.",
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
    name: "playbooks",
    schema: managePlaybooksSchema,
    responsePolicy: "json",
    examples: [{ action: "list", limit: 20, offset: 0 }],
    documentation: {
      en: {
        summary: "Keep named, reusable behaviour text an agent can read where it is needed.",
        result: "Action-specific playbook data.",
      },
      ru: {
        summary: "Хранит именованный переиспользуемый текст поведения для чтения агентом.",
        result: "Данные playbook для выбранной операции.",
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
    name: CODESPACE_TOOL_NAME,
    // Both native file parameters belong to the same tool now, so the host is told about both.
    _meta: { "openai/fileParams": ["stdin_file", "file"] },
    schema: codespaceSchema,
    responsePolicy: "native",
    examples: [
      { action: "list" },
      { action: "repositories" },
      { action: "setup_help" },
      { action: "local_devices" },
      {
        action: "operation",
        device_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "repository_add",
        device_id: "00000000-0000-4000-8000-000000000000",
        repository_id: "123456",
        request_id: "11111111-1111-4111-8111-111111111111",
      },
      {
        action: "repository_create",
        device_id: "00000000-0000-4000-8000-000000000000",
        request_id: "11111111-1111-4111-8111-111111111111",
        repository_name: "private-app",
        installation_id: "123456",
      },
      {
        action: "preview_image",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        path: "screenshots/app.png",
      },
      {
        action: "create",
        repository_id: "123456",
        ref: "main",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "adopt",
        provider_resource_name: "owned-space-123",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "adopt",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        generation: 2,
        device_id: "22222222-2222-4222-8222-222222222222",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "create",
        repository_id:
          "local:00000000-0000-4000-8000-000000000000:22222222-2222-4222-8222-222222222222",
        ref: "main",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      { action: "get", codespace_id: "00000000-0000-4000-8000-000000000000" },
      {
        action: "pull_request_create",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
        head: "feature/change",
        base: "main",
        title: "Change",
      },
      {
        action: "pull_request_create",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "start",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        generation: 3,
        request_id: "ws1-22222222-2222-4222-8222-222222222222",
      },
      {
        action: "stop",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        generation: 4,
        request_id: "ws1-33333333-3333-4333-8333-333333333333",
      },
      {
        action: "exec",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
        argv: ["git", "status", "--short"],
        cwd: ".",
        timeout_seconds: 60,
      },
      {
        action: "exec",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "read",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        path: "src/index.ts",
        offset: 0,
        length: 65536,
      },
      {
        action: "delete",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        generation: 5,
        request_id: "ws1-44444444-4444-4444-8444-444444444444",
        confirm_delete: true,
      },
      {
        action: "search",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        path: ".",
        query: "TODO",
        mode: "literal",
      },
      {
        action: "write",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
        path: "notes.txt",
        text: "done\n",
        expected: { exists: false },
      },
      {
        action: "download",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        path: "result.pdf",
        file_name: "result.pdf",
        mime_type: "application/pdf",
      },
    ],
    documentation: {
      en: {
        summary:
          "Work in a persistent GitHub or local Docker Sandboxes codespace: lifecycle, commands and files, by action. Both providers' lifecycle mutations require a caller-selected ws1 request_id; start/stop/delete and adoption by codespace_id require the observed generation from get/list. GitHub create/adopt runs through the selected available paired controller. Recover through operation with device_id and the original request_id, including a lost create reply before a codespace_id is known.",
        result:
          "Discovery, lifecycle state, owner operation receipts, workspace-owned command state and output, guarded file results, a private download link or PNG/JPEG preview. Lifecycle collection never resubmits or provisions an effect; accepted/unconfirmed receipts retain the original identity. An offline Local owner returns unavailable to MCP, without queuing; direct owner/guest CLI access to existing VMs remains subject to local grants and leases. New creation requires cloud route registration and initial Git authority. Choose a fresh ws1-<lowercase UUID> request_id for commands and file mutations; legacy UUIDs cannot execute. Collect a command through exec with the original request_id and no command fields. Background commands use codespace_process.",
      },
      ru: {
        summary:
          "Работа в постоянном codespace GitHub или локальной Docker Sandboxes VM: жизненный цикл, команды и файлы, по action. Для обоих провайдеров выберите request_id вида ws1 до изменения; start/stop/delete и adopt по codespace_id требуют наблюдаемое generation из get/list. GitHub create/adopt выполняет выбранный доступный сопряжённый контроллер. После потери ответа используйте operation с device_id и исходным request_id, в том числе если create ещё не вернул codespace_id.",
        result:
          "Обнаружение сред, состояние жизненного цикла, квитанции операций владельца, состояние команды и вывод, защищённые изменения файлов, приватная ссылка или PNG/JPEG preview. Чтение квитанции не повторяет действие и подготовку среды; accepted/unconfirmed сохраняют исходную идентичность. Недоступный Local owner возвращает MCP unavailable без постановки в очередь; прямой CLI владельца или среды работает с существующими VM в рамках локальных прав и lease. Новое создание требует облачной регистрации маршрута и начальных Git-полномочий. Для команды или изменения файла выберите новый request_id вида ws1-<UUID в нижнем регистре>; старые UUID не выполняются. Получайте результат команды через exec с исходным request_id без полей команды. Для фоновых команд используйте codespace_process.",
      },
    },
  }),
  defineTool({
    name: CODESPACE_PROCESS_TOOL_NAME,
    schema: codespaceProcessSchema,
    _meta: { "openai/fileParams": ["stdin_file"] },
    responsePolicy: "native",
    examples: [
      {
        action: "start",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
        argv: ["npm", "run", "dev"],
      },
      {
        action: "get",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        process_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "get",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        request_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
      {
        action: "read",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        process_id: "ws1-11111111-1111-4111-8111-111111111111",
        stream: "stdout",
        offset: 0,
        length: 65536,
      },
      {
        action: "stop",
        codespace_id: "00000000-0000-4000-8000-000000000000",
        process_id: "ws1-11111111-1111-4111-8111-111111111111",
      },
    ],
    documentation: {
      en: {
        summary: "Start, inspect, read and stop a background command in an owned codespace.",
        result:
          "Workspace-owned process state with request_id/process_id and readable output ranges. Recover a lost start reply through get with the original identity; stop explicitly cancels that process. A caller-selected deadline is optional.",
      },
      ru: {
        summary: "Запускает, проверяет, читает и останавливает фоновую команду в своём кодспейсе.",
        result:
          "Состояние процесса в рабочей среде с request_id/process_id и диапазонами вывода. После потери ответа start используйте get с исходным идентификатором; stop отменяет этот процесс. Срок выполнения задаётся только явно.",
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
  if (Array.isArray(fileParams)) {
    // Native-file discovery reads top-level properties of the published root object.
    const properties =
      "properties" in schema
        ? (schema.properties as Record<string, unknown> | undefined)
        : undefined;
    for (const field of fileParams) {
      if (typeof field !== "string") throw new Error("File parameter names must be strings");
      const candidate = properties?.[field];
      if (!candidate || typeof candidate !== "object" || !("properties" in candidate)) {
        throw new Error(`File parameter has no top-level object schema: ${field}`);
      }
    }
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
