import { z } from "zod";
import { WORKSPACE_REQUEST_ID_PATTERN } from "./codespaces/workspace-request-id.mjs";

const generation = z.number().int().positive().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestId = z.string().regex(WORKSPACE_REQUEST_ID_PATTERN);
export const communicationOwnerReferenceSchema = z
  .string()
  .regex(
    /^owner-file:\/\/(workspace|controller)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[A-Za-z0-9_-]{43}$/i,
  );
export function parseCommunicationOwnerReference(value: unknown): {
  kind: "workspace" | "controller";
  id: string;
  token: string;
} {
  const parsed = communicationOwnerReferenceSchema
    .parse(value)
    .slice("owner-file://".length)
    .split("/");
  return { kind: parsed[0] as "workspace" | "controller", id: parsed[1], token: parsed[2] };
}
export const communicationOwnerScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workspace"),
      resourceId: z.string().uuid(),
      resourceGeneration: generation,
      authorizationGeneration: generation,
      environmentIdentity: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("controller"),
      userId: z.string().min(1),
      deviceId: z.string().uuid(),
      deviceGeneration: generation,
      connectionId: z.string().uuid(),
    })
    .strict(),
]);
export const communicationFileMetadataSchema = z
  .object({
    fileName: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !/[\0\r\n/\\]/.test(value) &&
          value !== "." &&
          value !== ".." &&
          !/\p{Surrogate}/u.test(value),
      ),
    mimeType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
    size: z.number().int().nonnegative().safe(),
  })
  .strict();
const presentation = {
  kind: z.enum(["image", "document"]),
  text: z.string(),
  format: z.enum(["plain", "markdown", "html"]).optional(),
  silent: z.boolean().optional(),
  workflowFrame: z
    .object({
      executionId: z.string().min(1),
      workflowId: z.string().min(1),
      revision: z.number().int().nonnegative().safe(),
      taskIdentityRevision: z.string().min(1),
    })
    .strict()
    .optional(),
};
export const communicationOwnerPrepareSchema = z
  .object({
    scope: communicationOwnerScopeSchema,
    requestId,
    channelIds: z.array(z.string().min(1)).optional(),
    file: communicationFileMetadataSchema,
    ...presentation,
  })
  .strict();
export const communicationOwnerSendSchema = communicationOwnerPrepareSchema
  .omit({ channelIds: true })
  .extend({
    channelId: z.string().min(1),
    authorityDigest: digest,
    operationId: z.string().min(1).optional(),
    bundleDigest: digest.optional(),
    controls: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const communicationOwnerChannelSchema = z
  .object({
    channelId: z.string().min(1),
    authorityDigest: digest,
    provider: z.enum(["telegram", "extension"]),
    bundleDigest: digest.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const communicationOwnerPreparationSchema = z
  .object({
    channels: z.array(communicationOwnerChannelSchema),
  })
  .strict();
export const communicationVendorResultSchema = z
  .object({
    status: z.enum(["delivered", "refused", "unconfirmed"]),
    reason: z.string().optional(),
  })
  .strict();
export type CommunicationOwnerScope = z.infer<typeof communicationOwnerScopeSchema>;
export type CommunicationOwnerPrepare = z.infer<typeof communicationOwnerPrepareSchema>;
export type CommunicationOwnerSend = z.infer<typeof communicationOwnerSendSchema>;
export type CommunicationOwnerChannel = z.infer<typeof communicationOwnerChannelSchema>;
export type CommunicationVendorResult = z.infer<typeof communicationVendorResultSchema>;

export const materializeTextFilesSchema = z
  .array(
    z
      .object({
        path: z
          .string()
          .min(1)
          .refine(
            (value) =>
              !/[\0\p{Surrogate}]/u.test(value) &&
              !/^(?:[\\/]|[a-z]:)/i.test(value) &&
              value
                .replaceAll("\\", "/")
                .split("/")
                .every((part) => part !== "" && part !== "." && part !== ".."),
            "Materialize file paths must be safe relative paths",
          )
          .transform((value) => value.replaceAll("\\", "/")),
        content: z.string().refine((value) => !/\p{Surrogate}/u.test(value)),
      })
      .strict(),
  )
  .min(1)
  .superRefine((files, context) => {
    const paths = new Set<string>();
    for (const [index, file] of files.entries()) {
      if (paths.has(file.path))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "path"],
          message: "Materialize file paths must be unique",
        });
      paths.add(file.path);
    }
    for (const [index, file] of files.entries()) {
      const parts = file.path.split("/");
      while (parts.length > 1) {
        parts.pop();
        if (paths.has(parts.join("/")))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "path"],
            message: "Materialize files cannot replace a parent directory",
          });
      }
    }
  });
export type MaterializeTextFile = z.infer<typeof materializeTextFilesSchema>[number];

export const communicationSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("materialize-text-set"), files: materializeTextFilesSchema }).strict(),
  z.object({ type: z.literal("publication"), referenceId: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("native"),
      file: z
        .object({
          fileId: z.string().min(1),
          downloadUrl: z.string().min(1),
          fileName: z.string().optional(),
          mimeType: z.string().optional(),
          declaredSize: z.number().int().nonnegative().safe().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("inline"),
      data: z.string(),
      fileName: communicationFileMetadataSchema.shape.fileName,
      mimeType: communicationFileMetadataSchema.shape.mimeType,
    })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      descriptor: z
        .object({
          kind: z.enum(["steps", "map"]),
          graph: z.record(z.string(), z.unknown()),
          run: z.record(z.string(), z.unknown()),
          options: z.record(z.string(), z.unknown()).optional(),
          statistics: z.record(z.string(), z.unknown()).nullable().optional(),
          renderContext: z.object({ runUrl: z.string().url() }).strict().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("stream"), file: communicationFileMetadataSchema }).strict(),
]);
export const communicationOwnerSubmitSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("publish"),
      requestId,
      expectedScope: communicationOwnerScopeSchema.optional(),
      source: communicationSourceSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("deliver"),
      requestId,
      expectedScope: communicationOwnerScopeSchema.optional(),
      source: communicationSourceSchema,
      channelIds: z.array(z.string().min(1)).optional(),
      ...presentation,
    })
    .strict(),
]);
export type CommunicationOwnerSubmit = z.infer<typeof communicationOwnerSubmitSchema>;
export const communicationPublicationSchema = communicationFileMetadataSchema
  .extend({
    referenceId: communicationOwnerReferenceSchema,
    uri: z.string().url(),
    sha256: digest,
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export const communicationDeliveryStageSchema = z
  .object({
    channelId: z.string().min(1),
    operationId: z.string().optional(),
    status: z.enum(["accepted", "delivered", "refused", "unconfirmed"]),
    result: communicationVendorResultSchema.optional(),
  })
  .strict();
export const communicationOwnerReceiptSchema = z
  .object({
    requestId,
    state: z.enum(["absent", "accepted", "completed", "unconfirmed"]),
    stages: z.array(communicationDeliveryStageSchema).optional(),
    outcome: z
      .discriminatedUnion("ok", [
        z
          .object({
            ok: z.literal(true),
            result: z
              .object({
                file: communicationPublicationSchema,
                status: z.enum(["delivered", "no_configured_channels"]).optional(),
                channels: z.array(communicationDeliveryStageSchema).optional(),
              })
              .strict(),
          })
          .strict(),
        z
          .object({
            ok: z.literal(false),
            error: z.object({ code: z.string().min(1), message: z.string() }).strict(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type CommunicationOwnerReceipt = z.infer<typeof communicationOwnerReceiptSchema>;
