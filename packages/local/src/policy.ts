import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { gitFetchRefSchema } from "../../shared/src/codespaces/git-ref.js";
import type { LocalManagementOutcome } from "../../shared/src/codespaces/local-protocol.js";
import {
  localGitAuthorSchema,
  agentRepositoryManagementSchema,
} from "../../shared/src/codespaces/local-management-types.js";

export const LOCAL_PROTOCOL_VERSION = 1 as const;
export const LOCAL_PROVIDER = "local-sandboxes" as const;
export const SUPPORTED_SBX_VERSION = "0.46.0";
export const GiB = 1024 ** 3;

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
  })
  .strict();
export type LocalRepository = z.infer<typeof localRepositorySchema>;

const policyFields = z
  .object({
    version: z.literal(2),
    deviceId: z.string().uuid(),
    label: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => !hasControl(value)),
    enabled: z.boolean(),
    appliedRevision: z.number().int().safe().nonnegative().default(0),
    agentRepositoryManagement: agentRepositoryManagementSchema.nullable().default(null),
    gitAuthor: localGitAuthorSchema.nullable().optional(),
    runtime: z
      .object({
        binary: absolutePath,
        template: z
          .string()
          .max(512)
          .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
        storageRoot: absolutePath,
        maxStorageBytes: z.number().int().safe().positive(),
        cpuCores: z.number().int().safe().positive(),
        memoryBytes: z.number().int().safe().positive(),
        dockerBytes: z.number().int().safe().positive(),
      })
      .strict(),
    repositories: z.array(localRepositorySchema),
  })
  .strict();
function validatePolicy(value: z.infer<typeof policyFields>, context: z.RefinementCtx): void {
  const ids = new Set(value.repositories.map((repository) => repository.id));
  const names = new Set(value.repositories.map((repository) => repository.fullName.toLowerCase()));
  if (ids.size !== value.repositories.length || names.size !== value.repositories.length) {
    context.addIssue({ code: "custom", message: "Duplicate local repository grants" });
  }
  if (value.runtime.dockerBytes >= value.runtime.maxStorageBytes) {
    context.addIssue({
      code: "custom",
      message: "Storage must also hold the guest root filesystem",
    });
  }
}
export const localPolicySchema = policyFields.superRefine(validatePolicy);
/** Exact former private storage shape; never accepted as a current wire request. */
export const legacyLocalPolicySchema = policyFields
  .omit({ appliedRevision: true, agentRepositoryManagement: true })
  .extend({ version: z.literal(1), leaseUntil: z.number().int().safe().nonnegative() })
  .superRefine((value, context) =>
    validatePolicy(
      { ...value, version: 2, appliedRevision: 0, agentRepositoryManagement: null },
      context,
    ),
  );
export type LocalPolicy = z.infer<typeof localPolicySchema>;

/** Machine defaults are not physical custody; admitted VMs retain their own machine. */
export function physicalRuntimeProfile(policy: Pick<LocalPolicy, "deviceId" | "runtime">) {
  const { binary, template, storageRoot, maxStorageBytes } = policy.runtime;
  return { deviceId: policy.deviceId, runtime: { binary, template, storageRoot, maxStorageBytes } };
}

export function localRuntimeProfileHash(policy: Pick<LocalPolicy, "deviceId" | "runtime">): string {
  return createHash("sha256")
    .update(JSON.stringify(physicalRuntimeProfile(policy)))
    .digest("hex");
}

export class LocalRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly management?: LocalManagementOutcome,
  ) {
    super(message);
    this.name = "LocalRefusal";
  }
}

export function requireLocalGrant(policy: LocalPolicy, repositoryId: string): LocalRepository {
  if (!policy.enabled)
    throw new LocalRefusal("LOCAL_DISABLED", "Enable work on this computer locally.");
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
    repositories: policy.repositories,
    machine: {
      name: "local-approved",
      displayName: policy.label,
      operatingSystem: "linux",
      cpuCores: policy.runtime.cpuCores,
      memoryBytes: policy.runtime.memoryBytes,
      storageBytes: policy.runtime.maxStorageBytes,
    },
  };
}
