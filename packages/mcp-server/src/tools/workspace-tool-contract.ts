import { encodeReference } from "@mcp-moira/shared/workspace-references";
import {
  WORKSPACE_TOOL_SCHEMAS,
  type WorkspaceToolName,
} from "@mcp-moira/shared/workspace-tool-schemas";
import type { ToolDefinition } from "./tool-definitions.js";
export {
  WORKSPACE_TOOL_SCHEMAS,
  type WorkspaceToolName,
} from "@mcp-moira/shared/workspace-tool-schemas";

export const WORKSPACE_EFFECTS = new Set<WorkspaceToolName>([
  "workspace_create",
  "workspace_lifecycle",
  "workspace_adopt",
  "workspace_delete",
  "workspace_adopt_external",
  "repository_admit",
  "repository_create",
  "operation_resume",
  "file_create",
  "file_replace",
  "file_patch",
  "file_upload",
  "command_run",
  "command_run_native",
  "session_close",
  "pull_request_create",
  "communication_deliver",
  "communication_deliver_publication",
]);
const purposes: Record<WorkspaceToolName, [string, string]> = {
  workspace_list: [
    "List actionable owned workspaces for one provider; explicitly select diagnostics or history for retained unavailable or deleted identities. Other providers and billing are not awaited.",
    "Показывает рабочие среды выбранного провайдера; диагностика и история явно открывают сохранённые недоступные или удалённые идентичности. Другие провайдеры и оплата не задерживают ответ.",
  ],
  workspace_targets: [
    "Discover repository targets and registered controllers for new work at one selected provider.",
    "Находит репозитории и зарегистрированные контроллеры выбранного провайдера для новой работы.",
  ],
  workspace_observe: [
    "Observe a workspace and return a fresh reference for a deliberate next action.",
    "Наблюдает среду и возвращает новую ссылку для следующего явного действия.",
  ],
  workspace_create: [
    "Create one workspace from a returned target and branch.",
    "Создаёт одну среду по возвращённой цели и ветке.",
  ],
  workspace_lifecycle: [
    "Start, stop or resume incomplete Local or GitHub setup using the captured workspace reference.",
    "Запускает, останавливает или продолжает подготовку Local или GitHub по сохранённой ссылке.",
  ],
  workspace_adopt: [
    "Prepare an observed GitHub workspace at the explicitly selected registered controller.",
    "Подготавливает наблюдённую GitHub-среду на явно выбранном зарегистрированном контроллере.",
  ],
  workspace_delete: [
    "Permanently delete exactly the confirmed workspace observation.",
    "Безвозвратно удаляет именно подтверждённую наблюдённую среду.",
  ],
  workspace_setup_help: [
    "Explain the current missing setup requirement without provisioning.",
    "Объясняет текущую недостающую предпосылку без создания среды.",
  ],
  workspace_adopt_external: [
    "Explicitly prepare an owned external GitHub environment at its selected controller.",
    "Явно подготавливает собственную внешнюю GitHub-среду выбранным контроллером.",
  ],
  repository_admit: [
    "Request owner-approved admission of a verified GitHub repository.",
    "Запрашивает одобренный владельцем допуск проверенного GitHub-репозитория.",
  ],
  repository_create: [
    "Create a private repository under the selected installation and owner consent.",
    "Создаёт приватный репозиторий в выбранной установке с согласия владельца.",
  ],
  code_search: [
    "Search code at the workspace owner with explicit result windows.",
    "Ищет код у владельца среды с явно заданными окнами результата.",
  ],
  file_stat: [
    "Observe metadata and return a checked file reference for a regular file.",
    "Читает метаданные и возвращает проверенную ссылку обычного файла.",
  ],
  file_read: [
    "Read complete UTF-8 characters with a whole-file reference and continuation.",
    "Читает полные UTF-8 символы со ссылкой целого файла и продолжением.",
  ],
  file_create: [
    "Create a text file only when absent.",
    "Создаёт текстовый файл только при его отсутствии.",
  ],
  file_replace: [
    "Replace text only against complete expected text or an observed file reference.",
    "Заменяет текст только по полному ожидаемому тексту или наблюдённой ссылке файла.",
  ],
  file_patch: [
    "Replace matching old text atomically against one original across the selected files.",
    "Атомарно заменяет старый текст по одному исходному состоянию выбранных файлов.",
  ],
  file_upload: [
    "Stream a required native attachment to a new path or an observed replacement target.",
    "Передаёт обязательное нативное вложение в новый путь или наблюдённую цель замены.",
  ],
  file_download: [
    "Publish a complete file link with derived default name and media type.",
    "Публикует ссылку полного файла с автоматически выбранными именем и типом.",
  ],
  file_preview: [
    "Return a validated native image preview.",
    "Возвращает проверенный нативный предпросмотр изображения.",
  ],
  command_run: [
    "Run argv or a script; return original operation/process references without a default execution deadline.",
    "Выполняет argv или скрипт; возвращает ссылки исходной операции/процесса без общего срока исполнения.",
  ],
  command_run_native: [
    "Run a command with required native-file stdin, never mixed with text stdin.",
    "Выполняет команду с обязательным нативным stdin без смешивания с текстовым вводом.",
  ],
  session_close: ["Close a named workspace session.", "Закрывает именованную сессию среды."],
  process_output: [
    "Read original process output with complete-character continuation.",
    "Читает исходный вывод процесса с продолжением по полным символам.",
  ],
  process_stop: [
    "Cancel only the process addressed by its returned reference.",
    "Отменяет только процесс, указанный возвращённой ссылкой.",
  ],
  operation_get: [
    "Collect the original operation or process without resubmitting any effect.",
    "Читает исходную операцию или процесс без повторной отправки эффекта.",
  ],
  operation_resume: [
    "Explicitly continue a retained private-repository setup using only its original repository-create handle; never rerun commands or create another repository.",
    "Явно продолжает сохранённую подготовку приватного репозитория только по исходной ссылке его создания; не повторяет команды и не создаёт другой репозиторий.",
  ],
  operation_find: [
    "Discover original owner receipts; ambiguous candidates are never selected or replayed automatically.",
    "Находит исходные записи владельца; неоднозначные результаты не выбираются и не повторяются автоматически.",
  ],
  pull_request_create: [
    "Create one pull request through the workspace's scoped Git broker.",
    "Создаёт один pull request через ограниченный Git-брокер среды.",
  ],
  pull_request_read: [
    "Read a pull request by number or pushed head/base without creation.",
    "Читает pull request по номеру или опубликованным head/base без создания.",
  ],
  communication_send: [
    "Send ordinary text through configured user channels without choosing credentials or recipients.",
    "Отправляет обычный текст в настроенные каналы пользователя без выбора credentials или получателей.",
  ],
  communication_deliver: [
    "Deliver a required native attachment through its selected paired owner and configured channels.",
    "Доставляет обязательное нативное вложение выбранным сопряжённым владельцем в настроенные каналы.",
  ],
  communication_deliver_publication: [
    "Deliver an immutable existing owner publication without reacquiring or rewriting its bytes.",
    "Доставляет существующую неизменяемую публикацию владельца без повторного получения или перезаписи байтов.",
  ],
};
type SemanticDefinition = {
  [K in WorkspaceToolName]: ToolDefinition<K, (typeof WORKSPACE_TOOL_SCHEMAS)[K]>;
}[WorkspaceToolName];
const exampleId = "00000000-0000-4000-8000-000000000001";
const exampleOwner = { kind: "github" as const, resourceId: exampleId };
const exampleWorkspace = encodeReference("workspace", {
  resourceId: exampleId,
  provider: "github-codespaces",
  generation: 1,
});
const exampleController = encodeReference("controller", {
  deviceId: exampleId,
  connectionId: exampleId,
});
const exampleProcess = encodeReference("process", {
  owner: exampleOwner,
  requestId: `ws1-${exampleId}`,
});
const exampleNative = {
  file_id: "file_Example",
  download_url: "https://files.oaiusercontent.com/example",
};
const examples: Record<WorkspaceToolName, Record<string, unknown>> = {
  workspace_list: { provider: "local-sandboxes" },
  workspace_targets: { provider: "local-sandboxes" },
  workspace_observe: { workspace: exampleWorkspace },
  workspace_create: {
    target: encodeReference("target", {
      provider: "github-codespaces",
      repositoryId: "42",
      controller: { deviceId: exampleId, connectionId: exampleId },
    }),
    branch: "main",
  },
  workspace_lifecycle: { workspace: exampleWorkspace, action: "start" },
  workspace_delete: { workspace: exampleWorkspace, confirm_delete: true },
  workspace_adopt: { workspace: exampleWorkspace, controller: exampleController },
  workspace_setup_help: {},
  workspace_adopt_external: { controller: exampleController, name: "existing-environment" },
  repository_admit: { controller: exampleController, repository: "42" },
  repository_create: {
    controller: exampleController,
    installation: encodeReference("installation", {
      controller: { deviceId: exampleId, connectionId: exampleId },
      installationId: "42",
    }),
    name: "new-project",
  },
  code_search: { workspace: exampleWorkspace, path: ".", query: "TODO" },
  file_stat: { workspace: exampleWorkspace, path: "README.md" },
  file_read: { workspace: exampleWorkspace, path: "README.md" },
  file_create: { workspace: exampleWorkspace, path: "notes.txt", text: "Hello\n" },
  file_replace: {
    workspace: exampleWorkspace,
    path: "notes.txt",
    text: "Updated\n",
    expected: { text: "Hello\n" },
  },
  file_patch: {
    workspace: exampleWorkspace,
    files: [{ path: "notes.txt", replacements: [{ old_text: "Hello", new_text: "Welcome" }] }],
  },
  file_upload: {
    workspace: exampleWorkspace,
    target: { create: { path: "input.bin" } },
    file: exampleNative,
  },
  file_download: { workspace: exampleWorkspace, path: "report.pdf" },
  file_preview: { workspace: exampleWorkspace, path: "screen.png" },
  command_run: { workspace: exampleWorkspace, command: { argv: ["git", "status", "--short"] } },
  command_run_native: {
    workspace: exampleWorkspace,
    command: { argv: ["cat"] },
    stdin_file: exampleNative,
  },
  session_close: { workspace: exampleWorkspace, name: "shell" },
  process_output: { process: exampleProcess, stream: "stdout" },
  process_stop: { process: exampleProcess },
  operation_get: { reference: exampleProcess },
  operation_resume: {
    reference: encodeReference("operation", {
      owner: { kind: "controller", deviceId: exampleId, connectionId: exampleId },
      requestId: `ws1-${exampleId}`,
      kind: "repository",
      journal: "repository-create",
    }),
  },
  operation_find: { owner: exampleWorkspace, kind: "command" },
  pull_request_create: {
    workspace: exampleWorkspace,
    head: "feature/change",
    base: "main",
    title: "Change",
  },
  pull_request_read: { workspace: exampleWorkspace, query: { number: 42 } },
  communication_send: { message: "The report is ready." },
  communication_deliver: { file: exampleNative, kind: "document" },
  communication_deliver_publication: {
    publication: `owner-file://workspace/${exampleId}/${"A".repeat(43)}`,
    kind: "document",
  },
};
export const WORKSPACE_TOOL_DEFINITIONS = (
  Object.keys(WORKSPACE_TOOL_SCHEMAS) as WorkspaceToolName[]
).map((name) => {
  const [en, ru] = purposes[name];
  const fileParams =
    name === "command_run_native"
      ? ["stdin_file"]
      : ["file_upload", "communication_deliver"].includes(name)
        ? ["file"]
        : undefined;
  return {
    name,
    schema: WORKSPACE_TOOL_SCHEMAS[name],
    responsePolicy: "native",
    descriptions: {
      default: `${en} Copy returned references unchanged. A conflict requires a new explicit observation and decision. An uncertain reply is collected with operation_get or operation_find; never automatically resubmit. Two deliberate calls are distinct intents.`,
    },
    examples: [examples[name]],
    documentation: {
      en: {
        summary: en,
        result:
          "Owner-produced data, native content or original operation references; unavailable observation does not prove absence.",
      },
      ru: {
        summary: ru,
        result:
          "Данные владельца, нативный контент или ссылки исходных операций; недоступность наблюдения не доказывает отсутствие.",
      },
    },
    ...(fileParams ? { _meta: { "openai/fileParams": fileParams } } : {}),
  };
}) as readonly SemanticDefinition[];
