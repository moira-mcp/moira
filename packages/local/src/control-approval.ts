import { z } from "zod";
import {
  agentRepositoryManagementSchema,
  localControlCeilingSchema,
} from "../../shared/src/codespaces/local-management-types.js";

/** Private owner approval; wire clients cannot select or replace this envelope. */
export const controlApprovalSchema = z
  .object({
    origin: z.string().url(),
    userId: z.string().min(1),
    deviceId: z.string().uuid(),
    deviceGeneration: z.number().int().positive(),
    connectionId: z.string().uuid(),
    ceiling: localControlCeilingSchema,
    repositoryRequests: z.array(z.string().uuid()).default([]),
    rejectedRevision: z.number().int().positive().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();

const legacyApprovalSchema = controlApprovalSchema.extend({
  appliedRevision: z.number().int().nonnegative(),
  agentRepositoryManagement: agentRepositoryManagementSchema.nullable().default(null),
  ceiling: localControlCeilingSchema.extend({
    maxLeaseMs: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60 * 60_000),
  }),
});

/** One-way private import, called only at the protected new-owner admission boundary. */
export function prepareControlApprovalUpgrade(value: unknown): {
  approval: z.infer<typeof controlApprovalSchema>;
  changed: boolean;
  legacySettings?: {
    appliedRevision: number;
    agentRepositoryManagement: z.infer<typeof agentRepositoryManagementSchema> | null;
  };
} {
  const current = controlApprovalSchema.safeParse(value);
  if (current.success) return { approval: current.data, changed: false };
  const previous = legacyApprovalSchema.parse(value);
  const { appliedRevision, agentRepositoryManagement, ...envelope } = previous;
  const { maxLeaseMs: _duration, ...ceiling } = envelope.ceiling;
  return {
    approval: controlApprovalSchema.parse({ ...envelope, ceiling }),
    changed: true,
    legacySettings: { appliedRevision, agentRepositoryManagement },
  };
}
