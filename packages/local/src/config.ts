import { access, mkdir, realpath, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PrivateState } from "./private-state.js";
import { LocalRecords } from "./space-record.js";
import {
  GiB,
  LocalRefusal,
  localPolicySchema,
  legacyLocalPolicySchema,
  localRepositorySchema,
  repositoryName,
} from "./policy.js";
import { initializeStorage } from "./storage.js";
import { controlApprovalSchema } from "./control-approval.js";
import type { LocalPolicy } from "./policy.js";

// Docker's multi-platform shell-docker image, resolved and inspected on 2026-10-02.
export const DEFAULT_TEMPLATE =
  "docker.io/docker/sandbox-templates@sha256:1560168ac5fb9ce23d413c878349334c5845c07e264cd675d7867f0c78ad1761";

export async function openLocalState(directory?: string): Promise<PrivateState> {
  const path = resolve(directory ?? join(homedir(), ".moira-local"));
  await mkdir(path, { recursive: true, mode: 0o700 });
  return PrivateState.open(await realpath(path));
}

export async function findRuntime(binary: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const candidates = isAbsolute(binary)
    ? [binary]
    : (environment.PATH ?? "/usr/local/bin:/usr/bin:/bin")
        .split(":")
        .filter(Boolean)
        .map((directory) => join(directory, binary));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      if ((await lstat(path)).isFile()) return path;
    } catch (error) {
      if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new LocalRefusal(
    "LOCAL_RUNTIME_MISSING",
    "Install Docker Sandboxes and provide its sbx executable with --sbx.",
  );
}

export async function initializeLocal(
  state: PrivateState,
  options: {
    binary: string;
    template?: string;
    label?: string;
    storageGiB?: number;
    storageRoot?: string;
    cpuCores?: number;
    memoryGiB?: number;
  },
  environment: NodeJS.ProcessEnv,
) {
  if (await state.read("policy.json", localPolicySchema.parse))
    throw new LocalRefusal(
      "LOCAL_ALREADY_INITIALIZED",
      "This local device is already initialized.",
    );
  const binary = await findRuntime(options.binary, environment);
  const identity = await new LocalRecords(state).deviceIdentity();
  const deviceId = identity?.deviceId ?? randomUUID();
  const capacity = (options.storageGiB ?? 32) * GiB;
  const storageRoot = options.storageRoot ?? join(state.root, "storage");
  const policy = localPolicySchema.parse({
    version: 2,
    deviceId,
    label: options.label ?? identity?.label ?? hostname(),
    enabled: false,
    runtime: {
      binary,
      template: options.template ?? DEFAULT_TEMPLATE,
      storageRoot,
      maxStorageBytes: capacity,
      cpuCores: options.cpuCores ?? 2,
      memoryBytes: (options.memoryGiB ?? 4) * GiB,
      dockerBytes: 4 * GiB,
    },
    repositories: [],
  });
  policy.runtime.storageRoot = await initializeStorage(
    state,
    deviceId,
    capacity,
    options.storageRoot,
  );
  await state.write("policy.json", policy);
  return policy;
}

export async function approveRepository(
  records: LocalRecords,
  input: {
    fullName: string;
    private: boolean;
    allowPush: boolean;
    allowDelete: boolean;
    allowPullRequests?: boolean;
  },
) {
  repositoryName.parse(input.fullName);
  return records.withSettingsChange(async () => {
    const policy = await records.policy();
    const revision = await nextPolicyRevision(records, policy);
    const previous = policy.repositories.find(
      (entry) => entry.fullName.toLowerCase() === input.fullName.toLowerCase(),
    );
    const grant = localRepositorySchema.parse({
      ...input,
      id: previous?.id ?? randomUUID(),
    });
    policy.repositories = policy.repositories
      .filter((entry) => entry.id !== grant.id)
      .concat(grant);
    policy.appliedRevision = revision;
    await records.state.write("policy.json", localPolicySchema.parse(policy));
    return grant;
  });
}

export async function setEnabled(records: LocalRecords, enabled: boolean) {
  return records.withSettingsChange(async () => {
    const raw = await records.state.read("policy.json", (value) => value);
    const current = localPolicySchema.safeParse(raw);
    if (!current.success) {
      const previous = legacyLocalPolicySchema.parse(raw);
      if (enabled)
        throw new LocalRefusal(
          "LOCAL_SERVICE_MAINTENANCE_REQUIRED",
          "Complete the explicit owner update before enabling persistent work.",
        );
      await records.state.write("policy.json", { ...previous, enabled: false });
      return { enabled: false };
    }
    const policy = current.data;
    policy.appliedRevision = await nextPolicyRevision(records, policy, !enabled);
    policy.enabled = enabled;
    await records.state.write("policy.json", localPolicySchema.parse(policy));
    return { enabled: policy.enabled };
  });
}

/** Caller holds the settings gate; state and its applied revision publish in one document. */
async function nextPolicyRevision(
  records: LocalRecords,
  policy: LocalPolicy,
  disabling = false,
): Promise<number> {
  const approval = await records.state.read("web-control.json", controlApprovalSchema.parse);
  const intent = await records.state.read("control-intent.json", (value) =>
    z.object({ revision: z.number().int().positive() }).passthrough().parse(value),
  );
  if (
    (intent && intent.revision > policy.appliedRevision) ||
    (await records.state.read("policy-transition.json", (value) => value)) !== null
  ) {
    // Emergency denial does not certify another operation's uncertain effects.
    if (disabling) return policy.appliedRevision;
    throw new LocalRefusal(
      "LOCAL_CONTROL_PENDING",
      "Collect the original settings effect before changing local approval.",
    );
  }
  const latest = await records.state.read("controller-settings-current.json", (value) =>
    z
      .object({ requestId: z.string(), revision: z.number().int().nonnegative() })
      .strict()
      .parse(value),
  );
  return (
    Math.max(policy.appliedRevision, approval?.rejectedRevision ?? 0, latest?.revision ?? 0) + 1
  );
}
