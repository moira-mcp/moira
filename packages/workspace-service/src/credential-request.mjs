import { z } from "zod";
import {
  createWorkspaceRequestId,
  WORKSPACE_REQUEST_ID_PATTERN,
} from "../../shared/src/codespaces/workspace-request-id.ts";
import { scopedCredentialActionSchema } from "../../shared/src/codespaces/scoped-credential-types.ts";

const recordSchema = z
  .object({
    requestId: z.string().regex(WORKSPACE_REQUEST_ID_PATTERN),
    resourceId: z.string().uuid(),
    resourceGeneration: z.number().int().positive().safe(),
    action: scopedCredentialActionSchema,
    state: z.enum([
      "prepared",
      "unconfirmed",
      "live",
      "refused",
      "dispose_pending",
      "disposed",
      "absent",
    ]),
    credentialId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (["live", "dispose_pending"].includes(record.state) && !record.credentialId)
      context.addIssue({
        code: "custom",
        message: "Known credential custody requires its disposal identity",
      });
  });

/** Token-free security receipts compose with each owner's existing guarded private state. */
export async function prepareCredentialRequest(store, binding) {
  const record = recordSchema.parse({
    ...binding,
    requestId: createWorkspaceRequestId(),
    state: "prepared",
  });
  await store.write(record.requestId, record);
  return record;
}
export async function inspectCredentialRequest(store, requestId) {
  if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId))
    throw new Error("Invalid security request identity");
  const record = await store.read(requestId);
  if (record === null) return null;
  const parsed = recordSchema.parse(record);
  if (parsed.requestId !== requestId) throw new Error("Security request identity changed");
  return parsed;
}
export async function updateCredentialRequest(store, requestId, state, credentialId) {
  const previous = await inspectCredentialRequest(store, requestId);
  if (!previous) throw new Error("Security request not found");
  if (credentialId && previous.credentialId && credentialId !== previous.credentialId)
    throw new Error("Security disposal identity changed");
  const next = recordSchema.parse({
    ...previous,
    state,
    ...(credentialId ? { credentialId } : {}),
  });
  await store.write(requestId, next);
  return next;
}
