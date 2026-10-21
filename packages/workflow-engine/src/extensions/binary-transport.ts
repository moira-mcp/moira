import { z } from "zod";
import type { ExtensionCommunicationChannelDeclaration } from "./extension-contract.js";

const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
const alias = z.string().min(1);
const https = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  });
export const binaryControlsSchema = z
  .object({
    caption: z.string().optional(),
    format: z.enum(["plain", "markdown", "html"]).optional(),
    silent: z.boolean().optional(),
  })
  .strict();
export const binaryTransportSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            id: field,
            endpoint: z.union([
              z.object({ url: https }).strict(),
              z
                .object({ baseUrlSetting: alias, path: z.string().regex(/^\/(?!\/)[^?#]*$/) })
                .strict(),
            ]),
            method: z.enum(["POST", "PUT"]),
            credential: z
              .object({
                header: z.enum(["authorization", "x-api-key"]),
                secret: alias,
                scheme: z
                  .string()
                  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
                  .optional(),
              })
              .strict(),
            recipient: z.object({ field, setting: alias }).strict(),
            body: z.discriminatedUnion("mode", [
              z.object({ mode: z.literal("raw") }).strict(),
              z
                .object({
                  mode: z.literal("multipart"),
                  fileField: field,
                  controls: z
                    .object({
                      caption: field.optional(),
                      format: field.optional(),
                      silent: field.optional(),
                    })
                    .strict()
                    .optional(),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .min(1),
    assets: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.operations.map((operation) => operation.id)).size !== value.operations.length)
      context.addIssue({ code: "custom", message: "Binary operation IDs must be unique" });
    for (const operation of value.operations) {
      if (
        operation.body.mode === "raw" &&
        [
          "authorization",
          "x-api-key",
          "content-type",
          "content-length",
          "host",
          "connection",
          "transfer-encoding",
          "cookie",
        ].includes(operation.recipient.field.toLowerCase())
      )
        context.addIssue({
          code: "custom",
          message: "Raw recipient header cannot override transport authority",
        });
      const fields = [
        operation.recipient.field,
        ...(operation.body.mode === "multipart"
          ? [operation.body.fileField, ...Object.values(operation.body.controls ?? {})]
          : []),
      ];
      if (new Set(fields).size !== fields.length)
        context.addIssue({ code: "custom", message: "Binary multipart fields must not collide" });
    }
  });
export type BinaryTransport = z.infer<typeof binaryTransportSchema>;
export type BinaryControls = z.infer<typeof binaryControlsSchema>;

/** Runtime handler data excludes all fixed transport destinations and secret aliases. */
export function binaryHandlerSettings(
  channel: ExtensionCommunicationChannelDeclaration,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const excluded = new Set(channel.permissions?.secrets ?? []);
  for (const operation of channel.binaryTransport?.operations ?? []) {
    excluded.add(operation.recipient.setting);
    if ("baseUrlSetting" in operation.endpoint) excluded.add(operation.endpoint.baseUrlSetting);
  }
  return Object.fromEntries(
    (channel.settings ?? []).flatMap((key) =>
      !excluded.has(key) && Object.hasOwn(settings, key) ? [[key, settings[key]]] : [],
    ),
  );
}

/** A declaration grants a fixed transport, never an owner-selected URL or credential. */
export function binaryTransportProblems(
  channel: ExtensionCommunicationChannelDeclaration,
): string[] {
  if (channel.binaryTransport === undefined) return [];
  const parsed = binaryTransportSchema.safeParse(channel.binaryTransport);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message);
  const problems: string[] = [];
  const secrets = Array.isArray(channel.permissions?.secrets) ? channel.permissions.secrets : [];
  const settings = Array.isArray(channel.settings) ? channel.settings : [];
  const network = Array.isArray(channel.permissions?.network) ? channel.permissions.network : [];
  for (const operation of parsed.data.operations) {
    if (!secrets.includes(operation.credential.secret))
      problems.push("Binary credential must name a granted secret alias");
    for (const setting of [
      operation.recipient.setting,
      ...("baseUrlSetting" in operation.endpoint ? [operation.endpoint.baseUrlSetting] : []),
    ])
      if (!settings.includes(setting))
        problems.push("Binary transport must use declared nonsecret settings");
    if ("url" in operation.endpoint && !network.includes(new URL(operation.endpoint.url).host))
      problems.push("Binary endpoint must be granted by channel network permissions");
  }
  return problems;
}
