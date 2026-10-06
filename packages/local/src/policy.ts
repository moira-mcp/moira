import { isAbsolute } from "node:path";
import { z } from "zod";
import { gitFetchRefSchema } from "../../shared/src/codespaces/git-ref.js";
import {
  MAX_LOCAL_WORK_LEASE_MS,
  localGitAuthorSchema,
} from "../../shared/src/codespaces/local-management-types.js";

export const LOCAL_PROTOCOL_VERSION = 1 as const;
export const LOCAL_PROVIDER = "local-sandboxes" as const;
export const SUPPORTED_SBX_VERSION = "0.46.0";
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_LEASE_MS = MAX_LOCAL_WORK_LEASE_MS;
export const GiB = 1024 ** 3;

const integer = (minimum: number, maximum: number) => z.number().int().min(minimum).max(maximum);
const hasControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
export const repositoryName = z
  .string()
  .max(201)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
  .refine((name) => !name.endsWith(".git"), "Use the repository name without .git");
export const domainName = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  .refine(
    (name) => !/\.(?:localhost|local|internal|test|invalid)$/.test(name),
    "Public DNS name required",
  );
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !hasControl(value), "An absolute local path is required");
export const localRepositorySchema = z
  .object({
    id: z.string().uuid(),
    fullName: repositoryName,
    private: z.boolean(),
    allowPush: z.boolean(),
    allowDelete: z.boolean().default(false),
    allowPullRequests: z.boolean().optional(),
    domains: z.array(domainName).max(64),
  })
  .strict();
export type LocalRepository = z.infer<typeof localRepositorySchema>;

export const localPolicySchema = z
  .object({
    version: z.literal(1),
    deviceId: z.string().uuid(),
    label: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => !hasControl(value)),
    enabled: z.boolean(),
    leaseUntil: integer(0, Number.MAX_SAFE_INTEGER),
    gitAuthor: localGitAuthorSchema.nullable().optional(),
    runtime: z
      .object({
        binary: absolutePath,
        template: z
          .string()
          .max(512)
          .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
        storageRoot: absolutePath,
        maxStorageBytes: integer(4 * GiB, 1024 * GiB),
        cpuCores: integer(1, 32),
        memoryBytes: integer(GiB, 64 * GiB),
        dockerBytes: integer(GiB, 128 * GiB),
      })
      .strict(),
    limits: z
      .object({
        maxSandboxes: integer(1, 8),
        maxOperationMs: integer(1000, 4 * 60 * 60_000),
        maxOutputBytes: integer(1024, 256 * 1024 * 1024),
        maxConcurrent: integer(1, 16),
        maxNetworkBytes: integer(1024, 16 * GiB),
        maxNetworkConnections: integer(1, 64),
      })
      .strict(),
    repositories: z.array(localRepositorySchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.repositories.map((repository) => repository.id));
    const names = new Set(
      value.repositories.map((repository) => repository.fullName.toLowerCase()),
    );
    if (ids.size !== value.repositories.length || names.size !== value.repositories.length) {
      context.addIssue({ code: "custom", message: "Duplicate local repository grants" });
    }
    if (value.runtime.dockerBytes >= value.runtime.maxStorageBytes) {
      context.addIssue({
        code: "custom",
        message: "Storage must also hold the guest root filesystem",
      });
    }
  });
export type LocalPolicy = z.infer<typeof localPolicySchema>;

export class LocalRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalRefusal";
  }
}

/** Base64 prefixes plus the fixed worker/result metadata must fit one guest JSON reply. */
export function requireOperationOutputBudget(stdout: unknown, stderr: unknown): void {
  const prefix = integer(1, MAX_MESSAGE_BYTES / 2);
  const encoded = (value: unknown) => 4 * Math.ceil(prefix.parse(value) / 3);
  // The installed supervisor publishes two prefixes and fixed terminal/counter fields,
  // not argv or session environment. Reserve room for that envelope independently of data.
  if (encoded(stdout) + encoded(stderr) > MAX_MESSAGE_BYTES - 1024)
    throw new LocalRefusal(
      "LOCAL_OUTPUT_LIMIT",
      "Combined encoded output prefixes exceed the local response budget.",
    );
}

export function requireLocalGrant(
  policy: LocalPolicy,
  repositoryId: string,
  now: number,
): LocalRepository {
  if (!policy.enabled)
    throw new LocalRefusal("LOCAL_DISABLED", "Enable work on this computer locally.");
  if (policy.leaseUntil <= now || policy.leaseUntil > now + MAX_LEASE_MS) {
    throw new LocalRefusal("LOCAL_LEASE_EXPIRED", "Renew the work lease on this computer.");
  }
  const repository = policy.repositories.find((item) => item.id === repositoryId);
  if (!repository)
    throw new LocalRefusal("LOCAL_REPOSITORY_DENIED", "Approve this repository locally.");
  return repository;
}

export function requireRef(value: unknown): string {
  const ref = z.string().min(1).max(255).parse(value);
  if (!gitFetchRefSchema.safeParse(ref).success) {
    throw new LocalRefusal("LOCAL_REF_INVALID", "Invalid Git ref.");
  }
  return ref;
}

export function publicPolicy(policy: LocalPolicy) {
  return {
    version: LOCAL_PROTOCOL_VERSION,
    deviceId: policy.deviceId,
    label: policy.label,
    enabled: policy.enabled,
    leaseUntil: policy.leaseUntil,
    repositories: policy.repositories,
    machine: {
      name: "local-approved",
      displayName: policy.label,
      operatingSystem: "linux",
      cpuCores: policy.runtime.cpuCores,
      memoryBytes: policy.runtime.memoryBytes,
      storageBytes: policy.runtime.maxStorageBytes,
    },
    maxSandboxes: policy.limits.maxSandboxes,
  };
}
