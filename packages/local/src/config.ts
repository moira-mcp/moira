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
  localRepositorySchema,
  repositoryName,
  MAX_LEASE_MS,
} from "./policy.js";
import { initializeStorage } from "./storage.js";

// Docker's multi-platform shell-docker image, resolved and inspected on 2026-10-02.
export const DEFAULT_TEMPLATE =
  "docker.io/docker/sandbox-templates@sha256:1560168ac5fb9ce23d413c878349334c5845c07e264cd675d7867f0c78ad1761";
export const DEFAULT_DOMAINS = [
  "registry.npmjs.org",
  "nodejs.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
  "production.cloudfront.docker.com",
];

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
    maxSandboxes?: number;
  },
  environment: NodeJS.ProcessEnv,
) {
  if (await state.read("policy.json", localPolicySchema.parse))
    throw new LocalRefusal(
      "LOCAL_ALREADY_INITIALIZED",
      "This local device is already initialized.",
    );
  const binary = await findRuntime(options.binary, environment);
  const deviceId = randomUUID();
  const capacity = (options.storageGiB ?? 32) * GiB;
  const storageRoot = options.storageRoot ?? join(state.root, "storage");
  const policy = localPolicySchema.parse({
    version: 1,
    deviceId,
    label: options.label ?? hostname(),
    enabled: false,
    leaseUntil: 0,
    runtime: {
      binary,
      template: options.template ?? DEFAULT_TEMPLATE,
      storageRoot,
      maxStorageBytes: capacity,
      cpuCores: options.cpuCores ?? 2,
      memoryBytes: (options.memoryGiB ?? 4) * GiB,
      dockerBytes: 4 * GiB,
    },
    limits: {
      maxSandboxes: options.maxSandboxes ?? 2,
      maxOperationMs: 60 * 60_000,
      maxOutputBytes: 64 * 1024 * 1024,
      maxConcurrent: 4,
      maxNetworkBytes: 8 * GiB,
      maxNetworkConnections: 16,
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
    domains?: string[];
  },
) {
  repositoryName.parse(input.fullName);
  const policy = await records.policy();
  const previous = policy.repositories.find(
    (entry) => entry.fullName.toLowerCase() === input.fullName.toLowerCase(),
  );
  const grant = localRepositorySchema.parse({
    ...input,
    id: previous?.id ?? randomUUID(),
    domains: input.domains ?? DEFAULT_DOMAINS,
  });
  policy.repositories = policy.repositories.filter((entry) => entry.id !== grant.id).concat(grant);
  await records.state.write("policy.json", localPolicySchema.parse(policy));
  return grant;
}

export async function setEnabled(records: LocalRecords, enabled: boolean, hours = 8) {
  const policy = await records.policy();
  z.number()
    .positive()
    .max(MAX_LEASE_MS / 3_600_000)
    .parse(hours);
  policy.enabled = enabled;
  policy.leaseUntil = enabled ? Date.now() + Math.floor(hours * 3_600_000) : 0;
  await records.state.write("policy.json", policy);
  return { enabled: policy.enabled, leaseUntil: policy.leaseUntil };
}
