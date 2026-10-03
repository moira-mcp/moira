import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { openLocalState, initializeLocal, approveRepository, setEnabled } from "./config.js";
import { LocalRecords } from "./space-record.js";
import { LocalManager } from "./manager.js";
import { LocalJobs } from "./jobs.js";
import { LocalRpc } from "./rpc.js";
import { SbxRuntime } from "./sbx-runtime.js";
import { admitStorage } from "./storage.js";
import { LocalRefusal, MAX_MESSAGE_BYTES, publicPolicy } from "./policy.js";

const HELP = `Moira Local — user-owned, mountless Docker Sandboxes codespaces

Usage: moira-local <command> [options]

  init         Create private local state and bounded storage; work starts disabled
  login        Sign in to Docker within the companion's separate runtime
  setup        Initialize an empty dedicated runtime with host integrations disabled
  approve OWNER/REPO [--private] [--push] [--delete] [--domain HOST ...]
               Grant repository, egress and optional destructive rights locally
  git-token OWNER/REPO
               Read this repository's GitHub token from stdin; never from arguments
  enable [--hours 8] | disable
               Grant a finite local work lease, or stop all owned sandboxes
  status | doctor
               Inspect local grants, health and isolation prerequisites
  create OWNER/REPO [--ref main]
  start SPACE_ID | stop SPACE_ID | remove SPACE_ID --confirm
  exec SPACE_ID -- COMMAND [ARG ...]
               Run a command inside the VM, never in the host's shell
  request      Read one bounded JSON protocol request from stdin

Options: --state PATH --sbx PATH --template IMAGE@sha256:DIGEST
         --storage-root PATH --storage-gib 32 --cpus 2 --memory-gib 4
         --max-sandboxes 2 --label NAME --json --help

macOS init creates a private bounded disk image. On Linux provide an empty,
private, already mounted bounded filesystem. Docker Sandboxes sign-in is required.
No host folders, host secrets or production credentials are supplied to a sandbox.
Codespace content is visible to Moira. Review returned code before running it locally.
`;

async function input(limit: number): Promise<Buffer> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit)
      throw new LocalRefusal("LOCAL_INPUT_LIMIT", "Input exceeds the local bound.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function main(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const separator = args.indexOf("--");
  const commandArgs = separator < 0 ? [] : args.slice(separator + 1);
  const parsed = parseArgs({
    args: separator < 0 ? args : args.slice(0, separator),
    allowPositionals: true,
    strict: true,
    options: {
      state: { type: "string" },
      sbx: { type: "string" },
      template: { type: "string" },
      "storage-root": { type: "string" },
      "storage-gib": { type: "string" },
      cpus: { type: "string" },
      "memory-gib": { type: "string" },
      "max-sandboxes": { type: "string" },
      label: { type: "string" },
      ref: { type: "string" },
      hours: { type: "string" },
      domain: { type: "string", multiple: true },
      private: { type: "boolean" },
      push: { type: "boolean" },
      delete: { type: "boolean" },
      confirm: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [command, target] = parsed.positionals;
  const options = parsed.values;
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (!command || options.help) {
    process.stdout.write(HELP);
    return;
  }
  const state = await openLocalState(options.state);
  const records = new LocalRecords(state);
  const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));
  if (command === "init") {
    const policy = await initializeLocal(
      state,
      {
        binary: options.sbx ?? "sbx",
        template: options.template,
        label: options.label,
        storageRoot: options["storage-root"],
        storageGiB: number(options["storage-gib"]),
        cpuCores: number(options.cpus),
        memoryGiB: number(options["memory-gib"]),
        maxSandboxes: number(options["max-sandboxes"]),
      },
      environment,
    );
    output(publicPolicy(policy));
    return;
  }
  if (command === "approve") {
    output(
      await approveRepository(records, {
        fullName: target,
        private: options.private ?? false,
        allowPush: options.push ?? false,
        allowDelete: options.delete ?? false,
        domains: options.domain,
      }),
    );
    return;
  }
  if (command === "enable") {
    output(await setEnabled(records, true, number(options.hours) ?? 8));
    return;
  }
  if (command === "git-token") {
    const repository = (await records.policy()).repositories.find(
      (item) => item.fullName === target,
    );
    if (!repository)
      throw new LocalRefusal(
        "LOCAL_REPOSITORY_DENIED",
        "Approve the repository before supplying its token.",
      );
    const token = z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_]+$/)
      .parse((await input(4096)).toString("utf8").trim());
    await state.write(`git-${repository.id}.json`, { token });
    output({ stored: true, repository: repository.fullName });
    return;
  }
  const policy = await records.policy();
  const runtime = new SbxRuntime(policy);
  if (command === "status") {
    output({
      ...publicPolicy(policy),
      spaces: (await records.list()).map(({ id, phase, repositoryId, generation, failure }) => ({
        id,
        phase,
        repositoryId,
        generation,
        failure,
      })),
    });
    return;
  }
  if (command === "setup") {
    await admitStorage(policy);
    await runtime.initialize();
    output({ configured: true });
    return;
  }
  if (command === "doctor") {
    await admitStorage(policy);
    await runtime.verifySettings();
    await runtime.list();
    output({ ready: true, liveVmIsolationVerified: false });
    return;
  }
  if (command === "login") {
    await mkdir(join(runtime.home, "tmp"), { recursive: true, mode: 0o700 });
    await runtime.validateExecutable();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(policy.runtime.binary, ["login"], {
        cwd: runtime.home,
        env: { ...runtime.environment },
        stdio: "inherit",
        shell: false,
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new LocalRefusal("LOCAL_LOGIN_FAILED", "Docker sign-in did not complete.")),
      );
    });
    return;
  }
  if (command === "disable") {
    await setEnabled(records, false);
    for (const space of await records.list()) {
      if (space.runtimeId && space.phase !== "deleted")
        await runtime.stop({ name: space.name, runtimeId: space.runtimeId });
    }
    output({ enabled: false });
    return;
  }
  await runManagerCommand(command, target, commandArgs, options, records, output);
}

async function runManagerCommand(
  command: string,
  target: string,
  argv: string[],
  options: { ref?: string; confirm?: boolean },
  records: LocalRecords,
  output: (value: unknown) => void,
): Promise<void> {
  const manager = new LocalManager(records);
  await manager.open();
  try {
    if (command === "request") {
      const response = await new LocalRpc(manager).handle(
        JSON.parse((await input(MAX_MESSAGE_BYTES)).toString("utf8")),
      );
      output(response);
      if (!response.ok) process.exitCode = 1;
      return;
    }
    if (command === "create") {
      const repository = (await records.policy()).repositories.find(
        (item) => item.fullName === target,
      );
      if (!repository)
        throw new LocalRefusal("LOCAL_REPOSITORY_DENIED", "Approve this repository locally first.");
      const space = await manager.create(
        repository.id,
        options.ref ?? "main",
        `moira-${randomBytes(12).toString("hex")}`,
      );
      output({ spaceId: space.id, repository: repository.fullName });
      return;
    }
    z.string().uuid().parse(target);
    if (command === "start") {
      await manager.start(target);
      output({ started: true, spaceId: target });
      return;
    }
    if (command === "stop") {
      await manager.stop(target);
      output({ stopped: true, dataPreserved: true });
      return;
    }
    if (command === "remove") {
      if (!options.confirm)
        throw new LocalRefusal(
          "LOCAL_DELETE_CONFIRM",
          "Pass --confirm to permanently remove this sandbox.",
        );
      await manager.remove(target, (await manager.require(target)).generation, true);
      output({ deleted: true });
      return;
    }
    if (command === "exec") {
      if (!argv.length)
        throw new LocalRefusal("LOCAL_COMMAND_REQUIRED", "Provide the guest command after --.");
      await manager.start(target);
      const jobs = new LocalJobs(manager);
      const policy = await records.policy();
      const remoteMarker = `moira-op-${randomBytes(16).toString("hex")}`;
      let result = await jobs.dispatch(target, {
        version: 1,
        action: "execute",
        remoteMarker,
        argv,
        stdin: "",
        timeoutMs: policy.limits.maxOperationMs,
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 256 * 1024,
        maxRetainedBytes: policy.limits.maxOutputBytes,
      });
      while (
        typeof result === "object" &&
        result !== null &&
        "state" in result &&
        result.state === "running"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        result = await jobs.dispatch(target, { version: 1, action: "inspect", remoteMarker });
      }
      output(result);
      if (
        typeof result === "object" &&
        result !== null &&
        "exitCode" in result &&
        typeof result.exitCode === "number"
      )
        process.exitCode = result.exitCode;
      return;
    }
    throw new LocalRefusal("LOCAL_COMMAND_UNKNOWN", "Unknown command; run moira-local --help.");
  } finally {
    await manager.close();
  }
}

void main(process.argv.slice(2), { ...process.env }).catch((error: unknown) => {
  const code = error instanceof LocalRefusal ? error.code : "LOCAL_COMMAND_FAILED";
  const message =
    error instanceof LocalRefusal
      ? error.message
      : "Local command failed; check its arguments and prerequisites.";
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
});
