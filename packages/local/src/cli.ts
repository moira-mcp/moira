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
import {
  controllerIdentitySchema,
  controllerRequestIdSchema,
  controllerOperationSchema,
  controllerOperationKindSchema,
  controllerOperationFindResultSchema,
} from "../../shared/src/codespaces/local-controller-protocol.js";
import {
  encodeReference,
  decodeReference,
} from "../../shared/src/codespaces/workspace-references.mjs";
import { createWorkspaceRequestId } from "../../shared/src/codespaces/workspace-request-id.js";
import { operationState } from "../../shared/src/codespaces/workspace-operation-state.mjs";
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
  workspaces | observe WORKSPACE_REF
               Return selected workspace observations and meaningful references
  stop WORKSPACE_REF | remove WORKSPACE_REF --confirm
  create OWNER/REPO --ref BRANCH | start WORKSPACE_REF
               Mutations retain the observation captured in the returned reference
               Create requires cloud route registration and initial Git credential authority
  resume-setup WORKSPACE_REF
               Resume preparation of the same known VM; preserve files and original create outcome
  collect OPERATION_REF | operations CONTROLLER_REF [--kind KIND] [--query TEXT] [--cursor CURSOR]
               Inspect or discover original controller work without repeating it
  collect MAINTENANCE_OR_SECURITY_REQUEST_ID
               Collect original privileged maintenance or security custody; never submit work
  adopt WORKSPACE_REF
               Explicitly prepare an existing assigned GitHub VM; no Local SDK is needed
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
         --request-id ws1-<lowercase UUID> for explicit human maintenance only
         --label NAME --json --help

Lifecycle commands return an original operation reference, including an unconfirmed reply.
After a lost first reply, discover its original controller work; do not submit a replacement mutation.
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
      kind: { type: "string" },
      query: { type: "string" },
      cursor: { type: "string" },
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
  const controllerSocket = async () => join((await state.ipcDirectory()).root, "controller.sock");
  const currentController = async () => {
    const connection = await state.read("connection.json", controllerIdentitySchema.parse);
    if (!connection)
      throw new LocalRefusal("LOCAL_NOT_ENROLLED", "Pair the running controller first.");
    return connection;
  };
  const controllerResult = (value: unknown, operation: string) => {
    const original = controllerOperationSchema.strip().parse(value);
    const { requestId: _requestId, state: _phase, ...rest } = original;
    return { operation, state: operationState(original), ...rest };
  };
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
  if (command === "workspaces" || command === "observe") {
    const connection = await currentController();
    const selected = command === "observe" ? decodeReference(target, "workspace") : undefined;
    if (selected && selected.deviceId !== connection.deviceId)
      throw new LocalRefusal("LOCAL_UNAUTHORIZED", "Select a workspace of this paired controller.");
    const snapshot = (await controllerRequest(
      await controllerSocket(),
      "GET",
      "/v1/controller",
    )) as {
      local: {
        state: string;
        resources?: Array<{
          resourceId: string;
          resourceGeneration: number;
          space: Record<string, unknown> | null;
        }>;
      };
      github: {
        resources: Array<{
          resourceId: string;
          resourceGeneration: number;
          repositoryFullName: string;
          requestedRef: string;
          state: string;
          desiredState: string;
        }>;
      };
    };
    const local = (snapshot.local.resources ?? []).map((row) => ({
      ...(row.space && row.space.state !== "unknown"
        ? {
            workspace: encodeReference("workspace", {
              resourceId: row.resourceId,
              provider: "local-sandboxes",
              deviceId: connection.deviceId,
              generation: row.resourceGeneration,
            }),
          }
        : {}),
      resourceId: row.resourceId,
      provider: "local-sandboxes",
      name: row.space?.name,
      state: row.space?.state ?? "unavailable",
      phase: row.space?.phase,
      machine: row.space?.machine,
      remote: row.space?.remote,
      setupFailure: row.space?.setupFailure,
    }));
    const github = snapshot.github.resources.map((row) => ({
      workspace: encodeReference("workspace", {
        resourceId: row.resourceId,
        provider: "github-codespaces",
        deviceId: connection.deviceId,
        generation: row.resourceGeneration,
      }),
      resourceId: row.resourceId,
      provider: "github-codespaces",
      repository: row.repositoryFullName,
      branch: row.requestedRef,
      state: row.state,
      desiredState: row.desiredState,
    }));
    const rows = [...local, ...github]
      .filter(
        (row) =>
          !selected ||
          (row.resourceId === selected.resourceId && row.provider === selected.provider),
      )
      .map(({ resourceId: _resourceId, ...row }) => row);
    output({
      controller: encodeReference("controller", {
        deviceId: connection.deviceId,
        connectionId: connection.connectionId,
      }),
      workspaces: rows,
    });
    return;
  }
  if (command === "operations") {
    const owner = decodeReference(target, "controller"),
      current = await currentController();
    if (owner.deviceId !== current.deviceId || owner.connectionId !== current.connectionId)
      throw new LocalRefusal("LOCAL_UNAUTHORIZED", "Select this currently paired controller.");
    const found = controllerOperationFindResultSchema.parse(
      await controllerRequest(await controllerSocket(), "POST", "/v1/controller/operations/find", {
        ...(options.kind ? { kind: controllerOperationKindSchema.parse(options.kind) } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
      }),
    );
    output({
      ...found,
      operations: found.operations.map((row) => ({
        operation: encodeReference("operation", {
          owner: { kind: "controller", ...owner },
          requestId: row.requestId,
          kind: row.kind,
        }),
        state: operationState(row),
        kind: row.kind,
        descriptor: row.descriptor,
      })),
    });
    return;
  }
  if (["create", "start", "resume-setup", "stop", "remove", "adopt", "collect"].includes(command)) {
    if (command === "collect") {
      const privileged = controllerRequestIdSchema.safeParse(target);
      if (privileged.success) {
        output(
          (await collectServiceMaintenance(state, privileged.data)) ??
            (await new LocalRelay(records).collectGitCredentialRequest(privileged.data)) ?? {
              requestId: privileged.data,
              state: "absent",
            },
        );
        return;
      }
      const reference = decodeReference(target, "operation"),
        current = await currentController();
      if (reference.owner.kind !== "controller")
        throw new LocalRefusal(
          "LOCAL_GUEST_COLLECTION_REQUIRED",
          "Collect this exact reference with the guest moira-workspace CLI or cloud operation_get; no replacement work was submitted.",
        );
      if (
        reference.owner.deviceId !== current.deviceId ||
        reference.owner.connectionId !== current.connectionId
      )
        throw new LocalRefusal(
          "LOCAL_UNAUTHORIZED",
          "The original operation belongs to another controller authority.",
        );
      output(
        controllerResult(
          await controllerRequest(
            await controllerSocket(),
            "GET",
            reference.kind === "delivery"
              ? `/v1/communication/operations/${reference.requestId}`
              : `/v1/controller/operations/${reference.requestId}`,
          ),
          target,
        ),
      );
      return;
    }
    const connection = await currentController();
    let resourceId: string;
    let input: Record<string, unknown>;
    if (options["request-id"])
      throw new LocalRefusal(
        "LOCAL_OPTION_INVALID",
        "Ordinary lifecycle calls are fresh intent; use collect or operations after uncertainty.",
      );
    const requestId = createWorkspaceRequestId();
    const operation = encodeReference("operation", {
      owner: {
        kind: "controller",
        deviceId: connection.deviceId,
        connectionId: connection.connectionId,
      },
      requestId,
      kind: "lifecycle",
    });
    let provider = "local-sandboxes";
    if (command === "create") {
      const policy = await records.policy();
      const repository = policy.repositories.find((repository) => repository.fullName === target);
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
      const workspace = decodeReference(target, "workspace");
      if (workspace.deviceId !== connection.deviceId)
        throw new LocalRefusal(
          "LOCAL_UNAUTHORIZED",
          "Select a workspace of this paired controller.",
        );
      resourceId = workspace.resourceId;
      provider = workspace.provider;
      if (command === "adopt" && provider !== "github-codespaces")
        throw new LocalRefusal(
          "LOCAL_REQUEST_INVALID",
          "External adoption applies only to the selected GitHub workspace.",
        );
      if (command === "remove" && !options.confirm)
        throw new LocalRefusal(
          "LOCAL_DELETE_CONFIRM",
          "Pass --confirm to permanently remove this sandbox.",
        );
      input = {
        requestId,
        expectedGeneration: workspace.generation,
        action:
          command === "remove" ? "delete" : command === "resume-setup" ? "resume_setup" : command,
        ...(command === "remove" && provider === "local-sandboxes" ? { ownerConfirmed: true } : {}),
      };
    }
    process.stderr.write(`${JSON.stringify({ operation })}\n`);
    try {
      output(
        controllerResult(
          await controllerRequest(
            await controllerSocket(),
            "POST",
            provider === "github-codespaces"
              ? `/v1/controller/github/resources/${resourceId}`
              : `/v1/resources/${resourceId}/lifecycle`,
            input,
          ),
          operation,
        ),
      );
    } catch (error) {
      if (error instanceof LocalRefusal) throw error;
      output({
        operation,
        state: "unconfirmed",
        error: {
          code: "LOCAL_OBSERVATION_UNKNOWN",
          message:
            "The original response was lost; collect this operation or discover it, without replacement submission.",
        },
      });
    }
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
