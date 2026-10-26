import { createHash } from "node:crypto";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpPromptContext } from "@mcp-moira/shared";
import { WORKSPACE_TOOL_DEFINITIONS } from "./workspace-tool-contract.js";
import { toolDescriptions } from "./tool-descriptions.js";
import {
  PUBLIC_TOOL_SCHEMAS,
  WORKSPACE_PUBLIC_ACTIONS,
  WORKSPACE_PUBLIC_SINGLETONS,
  resolvePublicTool,
} from "./public-tool-contract.js";
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
} from "./tool-schemas.js";

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

export const INTERNAL_TOOL_DEFINITIONS = [
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
        summary:
          "Показывает и разрешает конфликты сверки встроенных процессов. Статус возвращает ссылки на кандидатов всем агентам, а полные состояния кандидатов — администраторам. Чтение кандидата и разрешение конфликта доступны только администратору; для смыслового слияния кандидатов используйте Workflow Management Flow, затем передайте объединённый граф.",
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
  ...WORKSPACE_TOOL_DEFINITIONS,
] as const;

export type InternalToolDefinition = (typeof INTERNAL_TOOL_DEFINITIONS)[number];
export type InternalToolName = InternalToolDefinition["name"];
const internalDefinitions = new Map<string, InternalToolDefinition>(
  INTERNAL_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);
export function getInternalToolDefinition(name: string): InternalToolDefinition {
  const definition = internalDefinitions.get(name);
  if (!definition) throw new Error(`Unknown internal MCP purpose: ${name}`);
  return definition;
}

function publicDescription(text: string): string {
  return text
    .replace(/\b(list|manage|token)\(\{/g, (_match, name: string) =>
      name === "list" ? 'workflow({ action: "list",' : "workflow({",
    )
    .replace(/\blist\(\)/g, 'workflow({ action: "list" })')
    .replace(/\bmanage\(\)/g, "workflow authoring")
    .replace(/\bstart\(\{/g, "execution({")
    .replace(/\bstep\(\{/g, 'execution({ action: "step",')
    .replace(/\block\(\{ action: "(status|list)"/g, 'execution({ action: "lock_$1"')
    .replace(/\b(session|lock)\(\{/g, "execution({")
    .replace(/\b(start|step)\(\)/g, "execution")
    .replace(
      "completed calls replay the exact stored receipt",
      "completed calls reuse the same durable receipt and attempt; the returned presentation may include current common language guidance without rewriting the saved receipt",
    )
    .replace(
      /\bsession (current_step|execution_context|cancel-execution|executions)\b/g,
      "execution $1",
    )
    .replace(/\boperation_get\b/g, 'codespace action="collect"')
    .replace(/\boperation_find\b/g, 'codespace action="find"')
    .replace("input schema's `action` enum", "input schema's strict `action` branches");
}
function publicDefinition<Name extends keyof typeof PUBLIC_TOOL_SCHEMAS>(
  name: Name,
): ToolDefinition<Name, (typeof PUBLIC_TOOL_SCHEMAS)[Name]> {
  const actions =
    name in WORKSPACE_PUBLIC_ACTIONS
      ? WORKSPACE_PUBLIC_ACTIONS[name as keyof typeof WORKSPACE_PUBLIC_ACTIONS]
      : undefined;
  const singleton =
    name in WORKSPACE_PUBLIC_SINGLETONS
      ? WORKSPACE_PUBLIC_SINGLETONS[name as keyof typeof WORKSPACE_PUBLIC_SINGLETONS]
      : undefined;
  const owners = actions
    ? [...new Set(Object.values(actions))]
    : singleton
      ? [singleton]
      : name === "workflow"
        ? ["list", "manage", "token", "reconciliation"]
        : name === "execution"
          ? ["start", "step", "session", "lock"]
          : [name];
  const sources = owners.map(getInternalToolDefinition);
  const examples = sources.flatMap((source) =>
    source.examples.map((original) => {
      if (singleton) return original;
      const input = original as Readonly<Record<string, unknown>>;
      if (actions) {
        const action = Object.entries(actions).find(([, purpose]) => purpose === source.name)![0];
        const { action: operation, ...fields } = input;
        return {
          action,
          ...fields,
          ...(source.name === "workspace_lifecycle" ? { operation } : {}),
        };
      }
      if (name === "workflow")
        return {
          ...input,
          action:
            source.name === "list"
              ? "list"
              : source.name === "reconciliation"
                ? `reconciliation_${input.action}`
                : input.action,
        };
      if (name === "execution")
        return {
          ...input,
          action:
            source.name === "step"
              ? "step"
              : source.name === "lock" && ["status", "list"].includes(String(input.action))
                ? `lock_${input.action}`
                : input.action,
        };
      return input;
    }),
  );
  const actionGuide = actions
    ? Object.entries(actions)
        .map(
          ([action, purpose]) =>
            `${action}: ${getInternalToolDefinition(purpose).documentation.en.summary}`,
        )
        .join("\n")
    : undefined;
  const guidance: Partial<Record<keyof typeof PUBLIC_TOOL_SCHEMAS, string>> = {
    codespace:
      "lifecycle.operation=start starts a stopped environment. For incomplete setup, correct the returned prerequisite and explicitly use resume_setup on the same workspace; start does not repair setup and creating another VM is not recovery. Historical collected results retain their original time and do not grant fresh mutation authority. If a confirmed effect has no workspace observation, retain the original and collect it; do not repeat the effect.",
    codespace_terminal:
      "Named sessions preserve cwd and exported environment. session.mode=open resets the named context even if it exists; continue requires an existing context from this workspace lifetime. A missing or old-lifetime context cannot be continued. timeout_seconds is an explicit command execution deadline; without it there is no default deadline. A returned process or operation can still be running when the response returns. Use output/collect on those unchanged references, never rerun a command to obtain its output. Output windows return continuation cursors on complete UTF-8 characters; follow them to read more. run_native requires native-file stdin and cannot mix stdin_text.",
    codespace_read:
      "read returns UTF-8 windows with continuation and a whole-file reference. stat is optional metadata inspection, not a prerequisite for read or download. preview returns native PNG/JPEG only; SVG and truncated data are refused. Structural image validation does not prove page rendering or visual correctness; inspect the image.",
    codespace_download:
      'Download directly by path without a prior stat. max_bytes refuses a too-large complete file; it never returns a successful truncated file. The result is an immutable complete publication. Pass its file.reference_id unchanged to communication({action: "deliver_publication", publication: file.reference_id, kind: "document"}) to deliver the existing bytes. Publication itself does not send a message.',
    codespace_git:
      "Before creating, read by exact pushed head/base to inspect an existing pull request. A lost create reply requires collect/find of the original, not another PR. Credential/security operations have separate originals: follow the actual returned owner/security collection handle, never invent a collection path or obtain a new credential solely because a reply was lost. codespace collect/find remains available for separate security originals.",
    communication:
      "send delivers ordinary text and has no exactly-once replay guarantee. deliver consumes a native attachment. deliver_publication consumes file.reference_id from codespace_download without downloading or uploading those bytes again. Publication alone sends nothing. collect/find inspect returned delivery originals without repeating delivery; preserve the actual returned owner references.",
    workflow:
      "Use Workflow Management Flow for complex workflow changes and semantic reconciliation merges; simple supported operations remain available directly. Reconciliation actions are reconciliation_status, reconciliation_get and reconciliation_resolve. Validate the full merged graph, retain intentional changes, then resolve using the returned revision and rationale.",
    notes:
      "list and history return previews, not complete material for analysis. Read complete content with get, optionally specifying version. Empty saved text is valid.",
    playbooks:
      "list and history return previews; read full current or historical content with get and optional revision. Templates resolve {{playbook:name}} or {{playbook:@owner/name}}. Editing a playbook affects running processes at their next step-text resolution. Empty content is valid.",
    settings:
      "A masked secret is not its stored value; never write the mask back. Saving telegram.bot_token also attempts external webhook registration and updates the webhook secret. Confirmation that the setting was saved does not prove that webhook registration succeeded; inspect its returned warning/result.",
  };
  const description = [
    publicDescription(
      actionGuide ??
        sources
          .map((source) =>
            source.name === "reconciliation"
              ? source.descriptions.default.replace(
                  /`(status|get|resolve)`/g,
                  "`reconciliation_$1`",
                )
              : source.descriptions.default,
          )
          .join("\n\n"),
    ),
    guidance[name],
    actions || singleton
      ? "Copy returned references unchanged. Conflicts require a fresh observation and explicit decision. For an uncertain accepted effect use codespace collect/find (or the matching group's collect/find); never automatically resubmit. Two deliberate effect calls are distinct intents."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  const metadata =
    name === "codespace_terminal"
      ? { "openai/fileParams": ["stdin_file"] }
      : name === "codespace_upload" || name === "communication"
        ? { "openai/fileParams": ["file"] }
        : undefined;
  return {
    name,
    schema: PUBLIC_TOOL_SCHEMAS[name],
    responsePolicy: "native",
    descriptions: {
      default: description,
      ...(name === "execution"
        ? {
            agents: {
              cursor: {
                description:
                  description +
                  "\n\nCursor input note: send structured input as JSON; never JavaScript's [object Object] value.",
              },
            },
          }
        : {}),
    },
    examples,
    ...(metadata ? { _meta: metadata } : {}),
    documentation: {
      en: {
        summary: sources.map((source) => source.documentation.en.summary).join(" "),
        result: sources.map((source) => source.documentation.en.result).join(" "),
      },
      ru: {
        summary: sources.map((source) => source.documentation.ru.summary).join(" "),
        result: sources.map((source) => source.documentation.ru.result).join(" "),
      },
    },
  };
}
export const TOOL_DEFINITIONS = (
  Object.keys(PUBLIC_TOOL_SCHEMAS) as Array<keyof typeof PUBLIC_TOOL_SCHEMAS>
).map(publicDefinition);
export { resolvePublicTool, PUBLIC_TOOL_SCHEMAS };
export type McpToolName = keyof typeof PUBLIC_TOOL_SCHEMAS;
export type AnyToolDefinition = ToolDefinition<McpToolName>;
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
    let properties =
      "properties" in schema
        ? (schema.properties as Record<string, unknown> | undefined)
        : undefined;
    for (const field of fileParams) {
      if (typeof field !== "string") throw new Error("File parameter names must be strings");
      let candidate = properties?.[field];
      if (!candidate && "anyOf" in schema && Array.isArray(schema.anyOf)) {
        for (const branch of schema.anyOf) {
          if (!("properties" in branch)) continue;
          const fields = branch.properties as Record<string, unknown>;
          if (!fields[field]) continue;
          if (candidate && JSON.stringify(candidate) !== JSON.stringify(fields[field]))
            throw new Error(`Incompatible native file schemas: ${field}`);
          candidate = fields[field];
          fields[field] = {};
        }
        if (candidate) {
          properties ??= {};
          properties[field] = candidate;
          Object.assign(schema, { properties });
        }
      }
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
  return [
    ...new Set(
      [...(schema.anyOf ?? schema.oneOf ?? [])].flatMap((branch) => {
        const action = branch.properties?.action;
        return action?.enum ?? (action?.const ? [action.const] : []);
      }),
    ),
  ];
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
