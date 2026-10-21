import { z } from "zod";
import { isReference, type ReferenceKind } from "./workspace-references.mjs";
import { communicationOwnerReferenceSchema } from "@mcp-moira/shared/communication-owner-protocol";
import { gitBranchSchema } from "@mcp-moira/shared/git-ref";

const codespaceMimeTypeSchema = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);
const codespaceFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "Filename must not contain paths or control characters",
  );

export const workspaceNativeFileSchema = z
  .object({
    file_id: z
      .string()
      .max(512)
      .regex(/^(?:sediment:\/\/)?file_[A-Za-z0-9]+$/),
    download_url: z.string().url(),
    file_name: codespaceFileNameSchema.optional(),
    mime_type: codespaceMimeTypeSchema.optional(),
    size_bytes: z.number().int().min(0).optional(),
  })
  .strict()
  .describe(
    "Native ChatGPT reference acquired by the workspace owner; pass it without base64. Source refusal before admission is confirmed, not a lost accepted mutation",
  );

const reference = (...kinds: ReferenceKind[]) =>
  z
    .string()
    .refine((value) => kinds.some((kind) => isReference(value, kind)), "Use a returned reference")
    .describe(`Copy the returned ${kinds.join(" or ")} reference; never manufacture or refresh it`);
const workspace = reference("workspace");
const controller = reference("controller");
const process = reference("process");
const owner = reference("workspace", "controller");
const positive = z.number().int().positive().safe();
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const expected = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ file: reference("file") }).strict(),
]);
const format = z.enum(["plain", "markdown", "html"]).optional();
const channel = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .optional();
const command = z.union([
  z.object({ argv: z.array(z.string().refine((value) => !value.includes("\0"))).min(1) }).strict(),
  z.object({ script: z.string().min(1) }).strict(),
]);
const commandFields = {
  workspace,
  command,
  session: z
    .object({
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
      mode: z.enum(["open", "continue"]),
    })
    .strict()
    .optional(),
  cwd: path.optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  background: z.boolean().optional(),
  timeout_seconds: positive.optional(),
  max_stdout_bytes: positive.optional(),
  max_stderr_bytes: positive.optional(),
};
const deliveryFields = {
  kind: z.enum(["image", "document"]),
  message: z.string().optional(),
  format,
  silent: z.boolean().optional(),
  channel,
};
export const WORKSPACE_TOOL_SCHEMAS = {
  workspace_list: z.object({}).strict(),
  workspace_targets: z.object({}).strict(),
  workspace_observe: z.object({ workspace: reference("workspace", "workspace-identity") }).strict(),
  workspace_create: z
    .object({
      target: reference("target"),
      branch: gitBranchSchema,
      devcontainer_path: path.optional(),
    })
    .strict(),
  workspace_lifecycle: z
    .object({ workspace, action: z.enum(["start", "stop", "resume_setup"]) })
    .strict(),
  workspace_adopt: z.object({ workspace, controller }).strict(),
  workspace_delete: z.object({ workspace, confirm_delete: z.literal(true) }).strict(),
  workspace_setup_help: z.object({ target: reference("target").optional() }).strict(),
  workspace_adopt_external: z
    .object({ controller, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/) })
    .strict(),
  repository_admit: z
    .object({ controller, repository: z.string().regex(/^[1-9][0-9]*$/) })
    .strict(),
  repository_create: z
    .object({
      controller,
      installation: reference("installation"),
      name: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9_.-]+$/)
        .refine((name) => name !== "." && name !== ".." && !name.toLowerCase().endsWith(".git")),
    })
    .strict(),
  code_search: z
    .object({
      workspace,
      path,
      query: z.string().min(1),
      mode: z.enum(["literal", "regex"]).optional(),
      max_matches: positive.optional(),
      max_bytes: positive.optional(),
    })
    .strict(),
  file_stat: z.object({ workspace, path }).strict(),
  file_read: z
    .object({
      workspace,
      path,
      window: z
        .union([
          z.object({ start_line: positive.optional(), max_lines: positive.optional() }).strict(),
          z.object({ cursor: reference("file-cursor") }).strict(),
        ])
        .optional(),
      max_bytes: positive.optional(),
    })
    .strict(),
  file_create: z.object({ workspace, path, text: z.string() }).strict(),
  file_replace: z.object({ workspace, path, text: z.string(), expected }).strict(),
  file_patch: z
    .object({
      workspace,
      files: z
        .array(
          z
            .object({
              path,
              expected: expected.optional(),
              replacements: z
                .array(
                  z
                    .object({
                      old_text: z.string().min(1),
                      new_text: z.string(),
                      occurrence: z.enum(["one", "all"]).optional(),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  file_upload: z
    .object({
      workspace,
      target: z.union([
        z.object({ create: z.object({ path }).strict() }).strict(),
        z.object({ replace: z.object({ file: reference("file") }).strict() }).strict(),
      ]),
      file: workspaceNativeFileSchema,
    })
    .strict(),
  file_download: z
    .object({
      workspace,
      path,
      file_name: codespaceFileNameSchema.optional(),
      mime_type: z
        .string()
        .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i)
        .optional(),
      max_bytes: positive.optional(),
    })
    .strict(),
  file_preview: z.object({ workspace, path, max_bytes: positive.optional() }).strict(),
  command_run: z.object({ ...commandFields, stdin_text: z.string().optional() }).strict(),
  command_run_native: z
    .object({ ...commandFields, stdin_file: workspaceNativeFileSchema })
    .strict(),
  session_close: z
    .object({ workspace, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/) })
    .strict(),
  process_output: z
    .object({
      process,
      stream: z.enum(["stdout", "stderr"]),
      cursor: reference("output-cursor").optional(),
      max_bytes: positive.optional(),
    })
    .strict(),
  process_stop: z.object({ process }).strict(),
  operation_get: z.object({ reference: reference("operation", "process") }).strict(),
  operation_resume: z.object({ reference: reference("operation") }).strict(),
  operation_find: z
    .object({
      owner,
      kind: z
        .enum([
          "command",
          "file-change",
          "lifecycle",
          "repository",
          "pull-request",
          "delivery",
          "session",
          "unknown",
        ])
        .optional(),
      query: z.string().optional(),
      cursor: z.string().min(1).optional(),
    })
    .strict(),
  pull_request_create: z
    .object({
      workspace,
      head: gitBranchSchema,
      base: gitBranchSchema,
      title: z.string().trim().min(1),
      body: z.string().optional(),
      draft: z.boolean().optional(),
    })
    .strict(),
  pull_request_read: z
    .object({
      workspace,
      query: z.union([
        z.object({ number: positive }).strict(),
        z.object({ head: gitBranchSchema, base: gitBranchSchema }).strict(),
      ]),
    })
    .strict(),
  communication_send: z
    .object({ message: z.string().min(1), format, silent: z.boolean().optional(), channel })
    .strict(),
  communication_deliver: z
    .object({ owner: controller.optional(), file: workspaceNativeFileSchema, ...deliveryFields })
    .strict(),
  communication_deliver_publication: z
    .object({ publication: communicationOwnerReferenceSchema, ...deliveryFields })
    .strict(),
} as const;
export type WorkspaceToolName = keyof typeof WORKSPACE_TOOL_SCHEMAS;
