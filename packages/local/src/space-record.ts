import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  localPolicySchema,
  requireLocalGrant,
  repositoryName,
  LocalRefusal,
  type LocalPolicy,
} from "./policy.js";
import { PrivateState } from "./private-state.js";
import type { BrokerGrant } from "./broker.js";

export const spaceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().regex(/^moira-[a-f0-9]{32}$/),
    runtimeId: z.string().min(1).max(255).nullable(),
    admittedMachine: localPolicySchema
      .innerType()
      .shape.runtime.pick({ cpuCores: true, memoryBytes: true, dockerBytes: true })
      .optional(),
    repositoryId: z.string().uuid(),
    admittedRepositoryFullName: repositoryName.optional(),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    ref: z.string().min(1).max(255),
    createdAt: z.number().int(),
    lastStartedAt: z.number().int().nullable(),
    desiredState: z.enum(["running", "stopped", "deleted"]),
    phase: z.enum(["creating", "usable", "stopped", "deleting", "deleted", "failed"]),
    networkPolicy: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    brokerToken: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.number().int().positive(),
    recoveryGeneration: z.number().int().positive().optional(),
    failure: z.string().max(128).nullable(),
  })
  .strict()
  .superRefine((space, context) => {
    if (
      space.recoveryGeneration !== undefined &&
      (!space.runtimeId ||
        space.recoveryGeneration > space.generation ||
        (space.recoveryGeneration === space.generation &&
          (space.failure !== null || space.desiredState !== "stopped")))
    )
      context.addIssue({ code: "custom", message: "Invalid local recovery acknowledgement." });
  });
export type LocalSpace = z.infer<typeof spaceSchema>;

/** Defaults can change without pretending an existing VM was resized. */
export function policyForSpace(policy: LocalPolicy, space: LocalSpace): LocalPolicy {
  return { ...policy, runtime: { ...policy.runtime, ...space.admittedMachine } };
}
export function requireSpaceGrant(policy: LocalPolicy, space: LocalSpace) {
  const repository = requireLocalGrant(policy, space.repositoryId);
  if (space.admittedRepositoryFullName && space.admittedRepositoryFullName !== repository.fullName)
    throw new LocalRefusal(
      "LOCAL_REPOSITORY_DENIED",
      "The existing sandbox belongs to another repository name.",
    );
  return repository;
}

export class LocalRecords {
  constructor(readonly state: PrivateState) {}
  /** One private kernel gate excludes settings writers across CLI and owner processes. */
  async withSettingsChange<T>(action: () => Promise<T>): Promise<T> {
    const settings = await PrivateState.open(join(this.state.root, "settings-control"));
    const release = await settings.lock({ recoverStale: true }).catch((error: unknown) => {
      if (error instanceof LocalRefusal && error.code === "LOCAL_ALREADY_RUNNING")
        throw new LocalRefusal(
          error.code,
          "Another settings change is in progress; inspect its result before submitting a new change.",
        );
      throw error;
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }
  async policyOrNull(): Promise<LocalPolicy | null> {
    return this.state.read("policy.json", localPolicySchema.parse);
  }
  /** Pairing identity exists independently of a physical Local capability. */
  async deviceIdentity(): Promise<{ deviceId: string; label: string } | null> {
    const policy = await this.policyOrNull();
    const connection = await this.state.read("connection.json", (value) =>
      z
        .object({ deviceId: z.string().uuid(), label: z.string().min(1).optional() })
        .passthrough()
        .parse(value),
    );
    if (policy && connection && policy.deviceId !== connection.deviceId)
      throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "Pairing and Local device identity differ.");
    if (policy) return { deviceId: policy.deviceId, label: policy.label };
    if (!connection) return null;
    if (!connection.label)
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The paired controller has no retained label.",
      );
    return { deviceId: connection.deviceId, label: connection.label };
  }
  async policy(): Promise<LocalPolicy> {
    const policy = await this.policyOrNull();
    if (!policy)
      throw new LocalRefusal(
        "LOCAL_NOT_CONFIGURED",
        "Initialize the Local SDK capability before physical Local work.",
      );
    return policy;
  }
  async list(): Promise<LocalSpace[]> {
    const keys = await this.state.keys("space-");
    const values = await Promise.all(keys.map((key) => this.state.read(key, spaceSchema.parse)));
    return values.filter((value): value is LocalSpace => value !== null);
  }
  async get(id: string): Promise<LocalSpace | null> {
    z.string().uuid().parse(id);
    return this.state.read(`space-${id}.json`, spaceSchema.parse);
  }
  async put(space: LocalSpace): Promise<void> {
    await this.state.write(`space-${space.id}.json`, spaceSchema.parse(space));
  }
  async authorize(header: string): Promise<BrokerGrant | null> {
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header);
    if (!match) return null;
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return null;
    const credentials = /^([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(decoded.toString("utf8"));
    if (!credentials || !z.string().uuid().safeParse(credentials[1]).success) return null;
    const space = await this.get(credentials[1]);
    if (
      !space ||
      space.desiredState !== "running" ||
      !space.runtimeId ||
      space.failure !== null ||
      (space.phase !== "creating" &&
        space.phase !== "usable" &&
        (space.phase !== "stopped" || space.lastStartedAt === null)) ||
      !timingSafeEqual(Buffer.from(space.brokerToken), Buffer.from(credentials[2]))
    )
      return null;
    const policy = await this.policy();
    try {
      const repository = requireLocalGrant(policy, space.repositoryId);
      if (
        space.admittedRepositoryFullName &&
        space.admittedRepositoryFullName !== repository.fullName
      )
        return null;
      return {
        policy,
        repository,
        spaceId: space.id,
        generation: space.generation,
      };
    } catch {
      return null;
    }
  }
}
