import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { openLocalState, initializeLocal, approveRepository, setEnabled } from "./config.js";
import { LocalRecords } from "./space-record.js";
import { LocalManager } from "./manager.js";
import { LocalRelay } from "./relay.js";
import { controllerRequest } from "./controller.js";
import { ControllerState } from "./controller-state.js";
import {
  controllerIdentitySchema,
  controllerRequestIdSchema,
} from "../../shared/src/codespaces/local-controller-protocol.js";
import { createWorkspaceRequestId } from "../../shared/src/codespaces/workspace-request-id.js";
import { LocalWebControl } from "./web-control.js";
import {
  runLocalService,
  serviceRequest,
  collectServiceMaintenance,
  serviceFailure,
} from "./service.js";
import {
  stageLocalService,
  ensureLocalServiceStarted,
  serviceInstallation,
  serviceBundleIdentity,
  LOCAL_SERVICE_PROTOCOL,
} from "./service-install.js";
import { localControlCeilingSchema } from "../../shared/src/codespaces/local-management-types.js";
import { SbxRuntime } from "./sbx-runtime.js";
import { admitStorage } from "./storage.js";
import { LocalRefusal, publicPolicy } from "./policy.js";
import {
  prepareLocalCredentialRecovery,
  recoverLocalDevice,
  stopLocalDevice,
  withLocalRuntimeOwner,
} from "./guard.js";

const HELP = `Moira Local — paired controller and optional user-owned Local sandboxes

Usage: moira-local <command> [options]

  init         Create private local state and bounded storage; work starts disabled
  login        Sign in to Docker within the companion's separate runtime
               --new-store creates a separate encrypted store; existing credentials are preserved
  setup        Initialize an empty dedicated runtime with host integrations disabled
  approve OWNER/REPO [--private] [--push] [--delete]
               Grant repository and optional destructive rights locally
  enable | disable
               Enable work until explicitly disabled, or stop all owned sandboxes
  status | doctor
               Inspect controller/capability state; doctor checks the configured Local SDK
  stop SPACE_ID | remove SPACE_ID --confirm
  create OWNER/REPO --ref BRANCH | start SPACE_ID
               Call the running owner controller using the currently observed generation
               Create requires cloud route registration and initial Git credential authority
  resume-setup SPACE_ID
               Resume preparation of the same known VM; preserve files and original create outcome
  collect REQUEST_ID
               Inspect the original ws1 request ID without repeating the operation
  github-start RESOURCE_ID | github-stop RESOURCE_ID
  github-adopt RESOURCE_ID | github-remove RESOURCE_ID --confirm
               Use the paired controller assigned to the GitHub resource; no Local SDK is needed
               Adopt prepares the existing VM without creating a replacement
  recover SPACE_ID --confirm
               Acknowledge a verified stopped VM for recovery; prior jobs are never retried
  recover --confirm
               Acknowledge orphan device shutdown while work is disabled; preserve jobs and data
  enroll --server HTTPS_URL --pairing-id UUID
               Read the browser's pairing token from stdin; confirm device identity in Moira
               Enrollment and run do not require Local SDK initialization or storage
  install      Stage a complete owner/client release and register login startup
               An existing physical owner continues running unchanged
  run          Start or connect to the persistent host owner; exiting this client does not stop VMs
  maintenance --confirm [--request-id ID]
               Explicitly interrupt and settle the owner, activate its staged release and recover intent
               Collect the original request after a lost reply; accepted commands are never replayed
  maintenance --pause --confirm | maintenance --resume --request-id ID --confirm
               Pause physical ownership for login/setup/recover, then resume the original saved intent
  service-status
               Observe the actual running release and staged maintenance requirement
  web-control --confirm
               Approve or revise owner web settings within locally confirmed resource limits
               Omitted limits retain the previous approval; changing a limit does not resize VMs

Options: --state PATH --sbx PATH --template IMAGE@sha256:DIGEST
         --storage-root PATH --storage-gib 32 --cpus 2 --memory-gib 4
         --request-id ws1-<lowercase UUID> for lifecycle commands
         --label NAME --json --help

Lifecycle commands print their requestId before waiting for the result.
After a lost reply, run collect with that original ID; do not submit a replacement mutation.
An unconfirmed outcome does not prove that the effect did not happen.
With cloud transport unavailable, existing owner-admitted VMs and their guest CLI remain
subject to current local grants. A confirmed authority refusal is not offline access.

The physical Local VM runtime supports macOS; init creates a private bounded disk image.
Linux Local VM execution is refused until its kernel ownership contract is supported.
Docker Sandboxes sign-in is required only for the physical Local capability.
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
      label: { type: "string" },
      private: { type: "boolean" },
      push: { type: "boolean" },
      delete: { type: "boolean" },
      "pull-requests": { type: "boolean" },
      confirm: { type: "boolean" },
      json: { type: "boolean" },
      "new-store": { type: "boolean" },
      help: { type: "boolean" },
      server: { type: "string" },
      "pairing-id": { type: "string" },
      "docker-gib": { type: "string" },
      ref: { type: "string" },
      "request-id": { type: "string" },
      pause: { type: "boolean" },
      resume: { type: "boolean" },
    },
  });
  const [command, target] = parsed.positionals;
  const options = parsed.values;
  if (options["new-store"] && command !== "login")
    throw new LocalRefusal(
      "LOCAL_OPTION_INVALID",
      "--new-store is available only for local login.",
    );
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (!command || options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "request")
    throw new LocalRefusal(
      "LOCAL_COMMAND_UNSUPPORTED",
      "Use the running owner controller; raw host request envelopes are not supported.",
    );
  if (command === "git-token")
    throw new LocalRefusal(
      "LOCAL_COMMAND_UNSUPPORTED",
      "Git credentials are issued to the paired private broker; manual tokens are not accepted.",
    );
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
        ...(options["pull-requests"] ? { allowPullRequests: true } : {}),
      }),
    );
    return;
  }
  if (command === "enable") {
    output(await setEnabled(records, true));
    return;
  }
  if (["github-start", "github-stop", "github-adopt", "github-remove"].includes(command)) {
    const resourceId = z.string().uuid().parse(target);
    if (command === "github-remove" && !options.confirm)
      throw new LocalRefusal(
        "LOCAL_DELETE_CONFIRM",
        "Pass --confirm to permanently delete this GitHub workspace.",
      );
    const relay = new LocalRelay(records),
      connection = await relay.confirmed();
    const binding = await new ControllerState(records).githubBinding(resourceId, connection);
    const assignment = binding ?? (await relay.githubAssignment(resourceId));
    const requestId = controllerRequestIdSchema.parse(
      options["request-id"] ?? createWorkspaceRequestId(),
    );
    output({ requestId, resourceId });
    output(
      await controllerRequest(
        join((await state.ipcDirectory()).root, "controller.sock"),
        "POST",
        `/v1/controller/github/resources/${resourceId}`,
        {
          requestId,
          expectedGeneration: assignment.resourceGeneration,
          action: command === "github-remove" ? "delete" : command.slice("github-".length),
        },
      ),
    );
    return;
  }
  if (["create", "start", "resume-setup", "stop", "remove", "collect"].includes(command)) {
    const socketPath = join((await state.ipcDirectory()).root, "controller.sock");
    if (command === "collect") {
      const maintenance = await collectServiceMaintenance(state, target);
      if (maintenance) {
        output(maintenance);
        return;
      }
      const credential = await new LocalRelay(records).collectGitCredentialRequest(target);
      if (credential) {
        output(credential);
        return;
      }
      output(await controllerRequest(socketPath, "GET", `/v1/controller/operations/${target}`));
      return;
    }
    const connection = await state.read("connection.json", (value) =>
      controllerIdentitySchema.parse(value),
    );
    if (!connection)
      throw new LocalRefusal("LOCAL_NOT_ENROLLED", "Pair the running controller first.");
    let resourceId: string;
    let input: Record<string, unknown>;
    const requestId = options["request-id"] ?? createWorkspaceRequestId();
    if (command === "create") {
      const policy = await records.policy();
      const repository = policy.repositories.find(
        (repository) => repository.fullName === target || repository.id === target,
      );
      if (!repository || !options.ref)
        throw new LocalRefusal(
          "LOCAL_REQUEST_INVALID",
          "Create requires an approved repository and explicit --ref.",
        );
      resourceId = randomUUID();
      input = {
        requestId,
        expectedGeneration: 1,
        action: "create",
        repositoryId: repository.id,
        ref: options.ref,
        operationMarker: `moira-${randomBytes(12).toString("hex")}`,
      };
    } else {
      const space = await records.get(z.string().uuid().parse(target));
      if (!space)
        throw new LocalRefusal(
          "LOCAL_SANDBOX_ABSENT",
          "This device does not own that native space.",
        );
      const binding = await new ControllerState(records).forSpace(space, connection);
      resourceId = binding.resourceId;
      if (command === "remove" && !options.confirm)
        throw new LocalRefusal(
          "LOCAL_DELETE_CONFIRM",
          "Pass --confirm to permanently remove this sandbox.",
        );
      input = {
        requestId,
        expectedGeneration: binding.resourceGeneration,
        action:
          command === "remove" ? "delete" : command === "resume-setup" ? "resume_setup" : command,
        ...(command === "remove" ? { ownerConfirmed: true } : {}),
      };
    }
    // Print recovery identity before observation; transport loss never invites a fresh mutation.
    process.stderr.write(`${JSON.stringify({ requestId, resourceId })}\n`);
    output(
      await controllerRequest(socketPath, "POST", `/v1/resources/${resourceId}/lifecycle`, input),
    );
    return;
  }
  if (command === "recover" && target === undefined) {
    await recoverLocalDevice(records, options.confirm === true);
    output({ recovered: true, enabled: false, priorJobsRetained: true, dataPreserved: true });
    return;
  }
  if (command === "enroll") {
    if (!options.server || !options["pairing-id"])
      throw new LocalRefusal(
        "LOCAL_PAIRING_INCOMPLETE",
        "Supply --server and --pairing-id from the Moira browser.",
      );
    output(
      await new LocalRelay(records).enroll(
        options.server,
        options["pairing-id"],
        (await input(4096)).toString("utf8").trim(),
        options.label,
      ),
    );
    return;
  }
  if (command === "service") {
    const bundle = await serviceBundleIdentity(dirname(fileURLToPath(import.meta.url)));
    await runLocalService(records, bundle.release);
    return;
  }
  if (command === "install" || command === "run" || command === "service-status") {
    if (command === "install")
      await stageLocalService(state, dirname(fileURLToPath(import.meta.url)));
    let status: unknown;
    try {
      status = await serviceRequest(state);
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      if (command === "service-status") {
        output({
          running: false,
          installation: await serviceInstallation(state),
          failure: await serviceFailure(state),
        });
        return;
      }
      if (!(await serviceInstallation(state)).active && command === "run")
        await stageLocalService(state, dirname(fileURLToPath(import.meta.url)));
      await ensureLocalServiceStarted(state);
      output({
        state: "starting",
        installation: await serviceInstallation(state),
        lastFailure: await serviceFailure(state),
      });
      return;
    }
    const protocol = z.object({ protocol: z.number().int() }).passthrough().parse(status);
    if (protocol.protocol !== LOCAL_SERVICE_PROTOCOL)
      throw new LocalRefusal(
        "LOCAL_SERVICE_MAINTENANCE_REQUIRED",
        "The running owner requires explicit maintenance before this client can connect.",
      );
    output(status);
    return;
  }
  if (command === "maintenance") {
    if (options.pause && options.resume)
      throw new LocalRefusal("LOCAL_OPTION_INVALID", "Choose either pause or resume.");
    if (options.resume && !options["request-id"])
      throw new LocalRefusal(
        "LOCAL_REQUEST_INVALID",
        "Resume requires the original maintenance request ID.",
      );
    if (!options.confirm)
      throw new LocalRefusal(
        "LOCAL_MAINTENANCE_CONFIRM",
        "Pass --confirm to interrupt the physical owner and update its executable.",
      );
    const requestId = controllerRequestIdSchema.parse(
      options["request-id"] ?? createWorkspaceRequestId(),
    );
    const retained = await collectServiceMaintenance(state, requestId);
    const installed = await serviceInstallation(state);
    const release = retained?.release ?? (options.pause ? installed.active : installed.staged);
    if (!release)
      throw new LocalRefusal(
        "LOCAL_SERVICE_UPDATE_MISSING",
        "Install the new release before explicit maintenance.",
      );
    process.stderr.write(`${JSON.stringify({ requestId, interruption: true })}\n`);
    output(
      await serviceRequest(state, "POST", "/v1/service/maintenance", {
        requestId,
        release,
        action: options.resume ? "resume" : options.pause ? "pause" : "update",
      }),
    );
    return;
  }
  if (command === "web-control") {
    const policy = await records.policy();
    if (!options.confirm)
      throw new LocalRefusal(
        "LOCAL_CONTROL_CONFIRM",
        "Confirm web control and its finite ceiling on this computer.",
      );
    const relay = new LocalRelay(records);
    const identity = await relay.confirmed();
    const control = new LocalWebControl(records);
    const previous = await control.report(identity);
    const defaults = previous?.ceiling ?? {
      cpuCores: policy.runtime.cpuCores,
      memoryBytes: policy.runtime.memoryBytes,
      storageBytes: policy.runtime.maxStorageBytes,
      dockerBytes: policy.runtime.dockerBytes,
    };
    await control.optIn(
      identity,
      localControlCeilingSchema.parse({
        cpuCores: number(options.cpus) ?? defaults.cpuCores,
        memoryBytes:
          (number(options["memory-gib"]) ?? defaults.memoryBytes / 1024 ** 3) * 1024 ** 3,
        storageBytes:
          (number(options["storage-gib"]) ?? defaults.storageBytes / 1024 ** 3) * 1024 ** 3,
        dockerBytes:
          (number(options["docker-gib"]) ?? defaults.dockerBytes / 1024 ** 3) * 1024 ** 3,
      }),
      options.confirm === true,
    );
    await relay.confirmed();
    output({ webControlApproved: true, server: identity.origin });
    return;
  }
  if (command === "status") {
    const policy = await records.policyOrNull();
    let service: unknown;
    try {
      service = await serviceRequest(state);
    } catch {
      service = {
        state: "unavailable",
        installation: await serviceInstallation(state),
        failure: await serviceFailure(state),
      };
    }
    output({
      service,
      ...(policy ? publicPolicy(policy) : {}),
      device: await records.deviceIdentity(),
      localCapability: policy ? "configured" : "unconfigured",
      spaces: (await records.list()).map(({ id, phase, repositoryId, generation, failure }) => ({
        id,
        phase,
        repositoryId,
        generation,
        failure,
      })),
      credentialRequests: await new LocalRelay(records).pendingGitCredentialRequests(),
    });
    return;
  }
  if (command === "setup") {
    const policy = await records.policy();
    await admitStorage(policy);
    await withLocalRuntimeOwner(records, "setup");
    output({ configured: true });
    return;
  }
  if (command === "doctor") {
    const policy = await records.policy();
    await admitStorage(policy);
    await withLocalRuntimeOwner(records, "doctor");
    output({ ready: true, liveVmIsolationVerified: false });
    return;
  }
  if (command === "login") {
    const release = await state.lock();
    try {
      const loginPolicy = await records.policy();
      const runtime = new SbxRuntime(loginPolicy);
      await admitStorage(loginPolicy);
      if (options["new-store"]) await prepareLocalCredentialRecovery(records);
      await mkdir(join(runtime.home, "tmp"), { recursive: true, mode: 0o700 });
      await runtime.prepareCredentials({ newStore: options["new-store"] });
      await runtime.validateExecutable();
      await runtime.prepareCredentials();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(loginPolicy.runtime.binary, ["login"], {
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
    } finally {
      await release();
    }
    return;
  }
  if (command === "disable") {
    await setEnabled(records, false);
    await stopLocalDevice(records);
    output({ enabled: false });
    return;
  }
  await runManagerCommand(command, target, options, records, output);
}

async function runManagerCommand(
  command: string,
  target: string,
  options: { confirm?: boolean },
  records: LocalRecords,
  output: (value: unknown) => void,
): Promise<void> {
  const manager = new LocalManager(records);
  await manager.open();
  try {
    z.string().uuid().parse(target);
    if (command === "recover") {
      const recovered = await manager.recover(target, options.confirm === true);
      output({
        recovered: true,
        spaceId: recovered.id,
        generation: recovered.generation,
        priorJobsRetained: true,
      });
      return;
    }
    throw new LocalRefusal("LOCAL_COMMAND_UNKNOWN", "Unknown command; run moira-local --help.");
  } finally {
    await manager.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  void main(process.argv.slice(2), { ...process.env }).catch((error: unknown) => {
    const code = error instanceof LocalRefusal ? error.code : "LOCAL_COMMAND_FAILED";
    const message =
      error instanceof LocalRefusal
        ? error.message
        : "Local command failed; check its arguments and prerequisites.";
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    process.exitCode = 1;
  });
