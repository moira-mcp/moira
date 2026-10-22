import { createReadStream } from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { createWorkspaceRequestId } from "../../shared/src/codespaces/workspace-request-id.mjs";
import { workspaceRequest, workspaceJson } from "./client.mjs";
import { workspaceFailure } from "./presentation.mjs";
import {
  encodeOwnerFrame,
  OWNER_STREAM_CONTENT_TYPE,
} from "../../shared/src/http/owner-stream-frame.mjs";
import { decodeReference } from "../../shared/src/codespaces/workspace-references.mjs";
export { workspaceRequest } from "./client.mjs";

function invalid() {
  throw Object.assign(new Error("CLI_REQUEST_INVALID"), { publicCode: "CLI_REQUEST_INVALID" });
}
async function inputText(path) {
  if (path !== "-") return new TextDecoder("utf8", { fatal: true }).decode(await readFile(path));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
}
async function nativeInput() {
  try {
    return JSON.parse(await inputText("-"));
  } catch {
    invalid();
  }
}
function options(args, boolean = []) {
  const positional = [],
    flags = {};
  let index = 0;
  while (index < args.length) {
    const value = args[index++];
    if (value === "--") return { positional: positional.concat(args.slice(index)), flags };
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (boolean.includes(key)) flags[key] = true;
    else {
      if (index === args.length || args[index].startsWith("--")) invalid();
      (flags[key] ??= []).push(args[index++]);
    }
  }
  return { positional, flags };
}
function one(flags, name) {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 1) invalid();
  return value[0];
}
function number(flags, name) {
  const value = one(flags, name);
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) invalid();
  return result;
}
const present = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
const effect = new Set([
  "command_run",
  "command_run_native",
  "session_close",
  "file_create",
  "file_replace",
  "file_patch",
  "file_upload",
  "pull_request_create",
  "communication_deliver",
  "communication_deliver_publication",
]);

/** Each invocation is fresh intent; uncertain calls are inspected/discovered, never auto-retried. */
export async function runWorkspaceCli(
  args,
  {
    socketPath = process.env.MOIRA_WORKSPACE_SOCKET ??
      join(homedir(), ".local/state/moira/workspace-service/service.sock"),
    stdout = process.stdout,
  } = {},
) {
  const [command, ...rest] = args;
  if (!command || command === "--help") {
    stdout.write(
      "moira-workspace exec [--background] [--cwd PATH] [--session NAME --continue] [--env KEY=VALUE] [--timeout SECONDS] [--stdin|--native-stdin] -- COMMAND ARG...\n",
    );
    stdout.write("moira-workspace exec --script SOURCE|- [execution options]\n");
    stdout.write(
      "moira-workspace get REFERENCE | find [--kind KIND] [--query TEXT] [--cursor CURSOR]\nmoira-workspace output PROCESS [--stream stdout|stderr] [--cursor CURSOR] [--max-bytes N]\nmoira-workspace stop PROCESS | session-close NAME\n",
    );
    stdout.write(
      "moira-workspace stat PATH | read PATH [--start-line N] [--max-lines N] [--max-bytes N] [--cursor CURSOR]\nmoira-workspace search PATH QUERY [--regex]\n",
    );
    stdout.write(
      "moira-workspace create PATH SOURCE|-\nmoira-workspace replace PATH SOURCE|- (--expected-text TEXT|--expected-file REFERENCE)\nmoira-workspace patch PATH... --old TEXT --new TEXT [--all] [--expected-file REFERENCE] (repeat pairs for one path, or one pair/reference per path)\n",
    );
    stdout.write(
      "moira-workspace upload PATH SOURCE|- [--replace FILE_REFERENCE]\nmoira-workspace native-upload PATH [--replace FILE_REFERENCE] (native descriptor on stdin)\nmoira-workspace download PATH [--name NAME] [--mime MIME] [--max-bytes N]\nmoira-workspace preview PATH [--max-bytes N]\n",
    );
    stdout.write(
      "moira-workspace pr-create HEAD BASE TITLE [--body SOURCE|-] [--draft]\nmoira-workspace pr-get NUMBER | pr-find HEAD BASE\nmoira-workspace deliver (--native|--publication REFERENCE) --kind image|document [--message TEXT] [--channel NAME]\n",
    );
    stdout.write(
      "Copy returned operation/process/file references. After a lost reply use find/get; identical new commands are distinct intents. Native descriptor URLs belong on stdin, never argv. Raw control JSON and caller operation IDs are not CLI inputs.\n",
    );
    return;
  }
  const { positional: p, flags: f } = options(rest, [
    "background",
    "continue",
    "stdin",
    "native-stdin",
    "regex",
    "all",
    "draft",
    "native",
  ]);
  const allowed = {
    exec: [
      "script",
      "background",
      "cwd",
      "session",
      "continue",
      "env",
      "timeout",
      "max-stdout",
      "max-stderr",
      "stdin",
      "native-stdin",
    ],
    get: [],
    find: ["kind", "query", "cursor"],
    stop: [],
    output: ["stream", "cursor", "max-bytes"],
    "session-close": [],
    stat: [],
    read: ["start-line", "max-lines", "max-bytes", "cursor"],
    preview: ["max-bytes"],
    download: ["name", "mime", "max-bytes"],
    search: ["regex", "max-bytes", "max-matches"],
    create: [],
    replace: ["expected-text", "expected-file"],
    patch: ["old", "new", "all", "expected-file"],
    upload: ["replace"],
    "native-upload": ["replace"],
    "pr-create": ["body", "draft"],
    "pr-get": [],
    "pr-find": [],
    deliver: ["native", "publication", "kind", "message", "channel"],
  }[command];
  if (!allowed || Object.keys(f).some((key) => !allowed.includes(key))) invalid();
  let action, request, source;
  if (command === "exec") {
    const script = one(f, "script");
    if (
      (script === undefined && !p.length) ||
      (script !== undefined && p.length) ||
      (f.stdin && f["native-stdin"]) ||
      (script === "-" && (f.stdin || f["native-stdin"])) ||
      (f.continue && !one(f, "session"))
    )
      invalid();
    const env = {};
    for (const value of f.env ?? []) {
      const split = value.indexOf("=");
      if (split < 1) invalid();
      env[value.slice(0, split)] = value.slice(split + 1);
    }
    action = f["native-stdin"] ? "command_run_native" : "command_run";
    request = present({
      command: script === undefined ? { argv: p } : { script: await inputText(script) },
      cwd: one(f, "cwd"),
      env: Object.keys(env).length ? env : undefined,
      session: one(f, "session")
        ? { name: one(f, "session"), mode: f.continue ? "continue" : "open" }
        : undefined,
      background: f.background || undefined,
      timeout_seconds: number(f, "timeout"),
      max_stdout_bytes: number(f, "max-stdout"),
      max_stderr_bytes: number(f, "max-stderr"),
      stdin_file: f["native-stdin"] ? await nativeInput() : undefined,
    });
    if (f.stdin) source = process.stdin;
  } else if (command === "get") {
    if (p.length !== 1) invalid();
    action = "operation_get";
    request = { reference: p[0] };
  } else if (command === "find") {
    if (p.length) invalid();
    action = "operation_find";
    request = present({ kind: one(f, "kind"), query: one(f, "query"), cursor: one(f, "cursor") });
  } else if (command === "stop") {
    if (p.length !== 1) invalid();
    action = "process_stop";
    request = { process: p[0] };
  } else if (command === "output") {
    if (p.length !== 1) invalid();
    action = "process_output";
    request = present({
      process: p[0],
      stream: one(f, "stream") ?? "stdout",
      cursor: one(f, "cursor"),
      max_bytes: number(f, "max-bytes"),
    });
  } else if (command === "session-close") {
    if (p.length !== 1) invalid();
    action = "session_close";
    request = { name: p[0] };
  } else if (["stat", "read", "preview", "download"].includes(command)) {
    if (p.length !== 1) invalid();
    action = {
      stat: "file_stat",
      read: "file_read",
      preview: "file_preview",
      download: "file_download",
    }[command];
    request = present({
      path: p[0],
      max_bytes: number(f, "max-bytes"),
      file_name: one(f, "name"),
      mime_type: one(f, "mime"),
    });
    if (command === "read") {
      if (one(f, "cursor") && (one(f, "start-line") || one(f, "max-lines"))) invalid();
      request.window = one(f, "cursor")
        ? { cursor: one(f, "cursor") }
        : present({ start_line: number(f, "start-line"), max_lines: number(f, "max-lines") });
    }
  } else if (command === "search") {
    if (p.length !== 2) invalid();
    action = "code_search";
    request = present({
      path: p[0],
      query: p[1],
      mode: f.regex ? "regex" : "literal",
      max_bytes: number(f, "max-bytes"),
      max_matches: number(f, "max-matches"),
    });
  } else if (command === "create" || command === "replace") {
    if (p.length !== 2) invalid();
    action = command === "create" ? "file_create" : "file_replace";
    request = { path: p[0], text: await inputText(p[1]) };
    if (command === "replace") {
      const text = one(f, "expected-text"),
        file = one(f, "expected-file");
      if ((text === undefined) === (file === undefined)) invalid();
      request.expected = file === undefined ? { text } : { file };
    }
  } else if (command === "patch") {
    if (
      !p.length ||
      !f.old?.length ||
      f.old.length !== f.new?.length ||
      (p.length > 1 && f.old.length !== p.length) ||
      (f["expected-file"] && f["expected-file"].length !== p.length)
    )
      invalid();
    const pairs = f.old.map((old_text, index) => ({
      old_text,
      new_text: f.new[index],
      ...(f.all ? { occurrence: "all" } : {}),
    }));
    action = "file_patch";
    request = {
      files: p.map((path, index) => ({
        path,
        ...(f["expected-file"] ? { expected: { file: f["expected-file"][index] } } : {}),
        replacements: p.length === 1 ? pairs : [pairs[index]],
      })),
    };
  } else if (command === "upload" || command === "native-upload") {
    if (p.length !== (command === "upload" ? 2 : 1)) invalid();
    action = "file_upload";
    if (one(f, "replace") && decodeReference(one(f, "replace"), "file").path !== p[0]) invalid();
    request = {
      target: one(f, "replace")
        ? { replace: { file: one(f, "replace") } }
        : { create: { path: p[0] } },
    };
    if (command === "native-upload") request.file = await nativeInput();
    else source = p[1] === "-" ? process.stdin : createReadStream(p[1]);
  } else if (command === "pr-create") {
    if (p.length !== 3) invalid();
    action = "pull_request_create";
    request = present({
      head: p[0],
      base: p[1],
      title: p[2],
      body: one(f, "body") ? await inputText(one(f, "body")) : undefined,
      draft: f.draft || undefined,
    });
  } else if (command === "pr-get" || command === "pr-find") {
    if (p.length !== (command === "pr-get" ? 1 : 2)) invalid();
    action = "pull_request_read";
    request = {
      query: command === "pr-get" ? { number: Number(p[0]) } : { head: p[0], base: p[1] },
    };
  } else if (command === "deliver") {
    if (p.length || Boolean(f.native) === Boolean(one(f, "publication"))) invalid();
    action = f.native ? "communication_deliver" : "communication_deliver_publication";
    request = present({
      kind: one(f, "kind"),
      message: one(f, "message"),
      channel: one(f, "channel"),
      ...(f.native ? { file: await nativeInput() } : { publication: one(f, "publication") }),
    });
  } else invalid();
  const call = {
    action,
    request,
    ...(effect.has(action) ? { requestId: createWorkspaceRequestId() } : {}),
  };
  let result;
  try {
    if (source) {
      const frame = encodeOwnerFrame(call, source);
      const response = await workspaceRequest(
        socketPath,
        "POST",
        "/v1/tools",
        Readable.from(frame.body),
        { "content-type": OWNER_STREAM_CONTENT_TYPE },
      );
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } else result = await workspaceJson(socketPath, "POST", "/v1/tools", call);
  } catch (error) {
    result = workspaceFailure(error);
  }
  stdout.write(JSON.stringify(result) + "\n");
  if (result.isError) throw Object.assign(new Error("Owner request failed"), { ownerResult: true });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkspaceCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      error.publicCode === "CLI_REQUEST_INVALID"
        ? "CLI input was refused before dispatch.\n"
        : "Inspect the original operation or use find after an uncertain reply; do not automatically repeat the effect.\n",
    );
    process.exitCode = 1;
  });
}
