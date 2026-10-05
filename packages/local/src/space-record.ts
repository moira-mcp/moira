import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { localPolicySchema, requireLocalGrant, type LocalPolicy } from "./policy.js";
import { PrivateState } from "./private-state.js";
import type { BrokerGrant } from "./broker.js";

export const spaceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().regex(/^moira-[a-f0-9]{32}$/),
    runtimeId: z.string().min(1).max(255).nullable(),
    repositoryId: z.string().uuid(),
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

export class LocalRecords {
  constructor(readonly state: PrivateState) {}
  async policy(): Promise<LocalPolicy> {
    const policy = await this.state.read("policy.json", localPolicySchema.parse);
    if (!policy) throw new Error("Run moira-local init first.");
    return policy;
  }
  async list(): Promise<LocalSpace[]> {
    const keys = await this.state.keys("space-");
    if (keys.length > 128) throw new Error("Local inventory capacity exceeded");
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
  async authorize(header: string, now = Date.now()): Promise<BrokerGrant | null> {
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
      (space.phase !== "creating" && space.phase !== "usable") ||
      !timingSafeEqual(Buffer.from(space.brokerToken), Buffer.from(credentials[2]))
    )
      return null;
    const policy = await this.policy();
    try {
      const repository = requireLocalGrant(policy, space.repositoryId, now);
      const secret = await this.state.read(
        `git-${repository.id}.json`,
        z
          .object({
            token: z
              .string()
              .min(1)
              .max(4096)
              .regex(/^[A-Za-z0-9_]+$/),
          })
          .strict().parse,
      );
      return { policy, repository, gitCredential: secret?.token ?? null };
    } catch {
      return null;
    }
  }
}
