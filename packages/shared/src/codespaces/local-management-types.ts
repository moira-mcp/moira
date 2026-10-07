import { z } from "zod";

export const MAX_LOCAL_WORK_LEASE_MS = 7 * 24 * 60 * 60_000;
const GiB = 1024 ** 3;
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "Control characters are not permitted",
    );
export const localGitAuthorSchema = z
  .object({
    name: text(200),
    email: z.string().trim().email().max(254),
  })
  .strict();
export type LocalGitAuthor = z.infer<typeof localGitAuthorSchema>;
export const LOCAL_BROWSER_DEVELOPMENT_DOMAINS = [
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
  "cdn.playwright.dev",
  "playwright.download.prss.microsoft.com",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com",
] as const;
export const agentRepositoryManagementSchema = z
  .object({
    githubUserId: z.string().regex(/^[1-9][0-9]*$/),
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
    allowExistingPrivate: z.boolean(),
    allowNewPrivate: z.boolean(),
    allowPush: z.boolean(),
    maxRepositories: integer(1, 64),
    networkProfile: z.literal("node-react-playwright"),
  })
  .strict();
export type AgentRepositoryManagement = z.infer<typeof agentRepositoryManagementSchema>;
export const localManagementRepositorySchema = z
  .object({
    id: z.string().uuid(),
    fullName: z
      .string()
      .max(201)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
      .refine((value) => !value.endsWith(".git")),
    private: z.boolean(),
    allowPush: z.boolean(),
    allowDelete: z.boolean(),
    allowPullRequests: z.boolean().optional(),
    domains: z
      .array(
        z
          .string()
          .max(253)
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
          .refine((value) => !/\.(?:localhost|local|internal|test|invalid)$/.test(value)),
      )
      .max(64),
  })
  .strict();
export const localDeviceSettingsSchema = z
  .object({
    label: text(80),
    enabled: z.boolean(),
    leaseUntil: integer(0, Number.MAX_SAFE_INTEGER),
    cpuCores: integer(1, 32),
    memoryBytes: integer(GiB, 64 * GiB),
    storageBytes: integer(8 * GiB, 1024 * GiB),
    dockerBytes: integer(GiB, 128 * GiB),
    maxSandboxes: integer(1, 8),
    maxOperationMs: integer(1000, 4 * 60 * 60_000),
    maxOutputBytes: integer(1024, 256 * 1024 * 1024),
    maxConcurrent: integer(1, 16),
    maxNetworkBytes: integer(1024, 16 * GiB),
    maxNetworkConnections: integer(1, 64),
    repositories: z.array(localManagementRepositorySchema).max(64),
    gitAuthor: localGitAuthorSchema.nullable(),
    agentRepositoryManagement: agentRepositoryManagementSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dockerBytes + GiB > value.storageBytes)
      ctx.addIssue({ code: "custom", message: "Storage must also hold the guest root filesystem" });
    if (
      value.storageBytes % GiB !== 0 ||
      value.memoryBytes % GiB !== 0 ||
      value.dockerBytes % GiB !== 0
    )
      ctx.addIssue({ code: "custom", message: "Storage and memory sizes must be integral GiB" });
    if (
      new Set(value.repositories.map((r) => r.id)).size !== value.repositories.length ||
      new Set(value.repositories.map((r) => r.fullName.toLowerCase())).size !==
        value.repositories.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate repository grants" });
  });
export type LocalDeviceSettingsValue = z.infer<typeof localDeviceSettingsSchema>;
export const localControlCeilingSchema = z
  .object({
    cpuCores: integer(1, 32),
    memoryBytes: integer(GiB, 64 * GiB),
    storageBytes: integer(8 * GiB, 1024 * GiB),
    dockerBytes: integer(GiB, 128 * GiB),
    maxSandboxes: integer(1, 8),
    maxOperationMs: integer(1000, 4 * 60 * 60_000),
    maxOutputBytes: integer(1024, 256 * 1024 * 1024),
    maxConcurrent: integer(1, 16),
    maxNetworkBytes: integer(1024, 16 * GiB),
    maxNetworkConnections: integer(1, 64),
    maxLeaseMs: integer(1, MAX_LOCAL_WORK_LEASE_MS),
  })
  .strict();
export type LocalControlCeiling = z.infer<typeof localControlCeilingSchema>;
export const localControlErrorSchema = z
  .object({ code: z.string().regex(/^LOCAL_[A-Z0-9_]{1,80}$/), message: text(500) })
  .strict();
export const localRepositoryAdmissionReceiptSchema = z
  .object({
    requestId: z.string().uuid(),
    githubRepositoryId: z.string().regex(/^[1-9][0-9]*$/),
    localRepositoryId: z.string().uuid(),
    revision: integer(1, Number.MAX_SAFE_INTEGER),
    deviceGeneration: integer(1, Number.MAX_SAFE_INTEGER),
    connectionId: z.string().uuid(),
    repository: localManagementRepositorySchema,
    creationRequestId: z.string().uuid().optional(),
  })
  .strict();
export type LocalRepositoryAdmissionReceipt = z.infer<typeof localRepositoryAdmissionReceiptSchema>;
export const localDeviceControlViewSchema = z
  .object({
    optedIn: z.boolean(),
    revision: integer(0, Number.MAX_SAFE_INTEGER),
    appliedRevision: integer(0, Number.MAX_SAFE_INTEGER),
    status: z.enum(["not-enabled", "applied", "pending", "rejected"]),
    settings: localDeviceSettingsSchema,
    ceiling: localControlCeilingSchema.nullable(),
    error: localControlErrorSchema.nullable(),
    repositoryAdmissions: z.array(localRepositoryAdmissionReceiptSchema).max(64).optional(),
    appliedAgentRepositoryManagement: agentRepositoryManagementSchema.nullable().optional(),
  })
  .strict();
export type LocalDeviceControlView = z.infer<typeof localDeviceControlViewSchema>;
export const localControlRequestSchema = z
  .object({
    expectedRevision: integer(0, Number.MAX_SAFE_INTEGER),
    expectedGeneration: integer(1, Number.MAX_SAFE_INTEGER),
    settings: localDeviceSettingsSchema,
  })
  .strict();
export const localControlReportSchema = z
  .object({
    ceiling: localControlCeilingSchema,
    settings: localDeviceSettingsSchema,
    appliedRevision: integer(0, Number.MAX_SAFE_INTEGER),
    rejectedRevision: integer(1, Number.MAX_SAFE_INTEGER).optional(),
    error: localControlErrorSchema.optional(),
  })
  .strict();
export type LocalControlReport = z.infer<typeof localControlReportSchema>;

/** A delegated addition cannot replace a grant or supply its own network authority. */
export function assertAgentRepositoryAdmission(
  delegation: AgentRepositoryManagement | null | undefined,
  repository: z.infer<typeof localManagementRepositorySchema>,
  origin: "existing" | "created" = "existing",
): void {
  if (
    !delegation ||
    !(origin === "created" ? delegation.allowNewPrivate : delegation.allowExistingPrivate) ||
    !repository.private ||
    repository.fullName.split("/")[0].toLowerCase() !== delegation.owner.toLowerCase() ||
    repository.allowPush !== delegation.allowPush ||
    repository.allowDelete ||
    repository.allowPullRequests === true ||
    JSON.stringify(repository.domains) !== JSON.stringify(LOCAL_BROWSER_DEVELOPMENT_DOMAINS)
  )
    throw new Error("Repository addition exceeds the applied agent delegation.");
}

/** Compare parsed settings, preserving the exact order and content of every previous grant. */
export function isLiveLocalSettingsChange(
  previous: LocalDeviceSettingsValue,
  next: LocalDeviceSettingsValue,
): boolean {
  const stable = (settings: LocalDeviceSettingsValue) => ({
    ...settings,
    repositories: [],
    agentRepositoryManagement: null,
  });
  return (
    JSON.stringify(stable(previous)) === JSON.stringify(stable(next)) &&
    next.repositories.length >= previous.repositories.length &&
    previous.repositories.every(
      (repository, index) =>
        JSON.stringify(repository) === JSON.stringify(next.repositories[index]),
    )
  );
}

/** The local opt-in and server save use exactly the same finite upper-bound decision. */
export function assertLocalControlSettings(
  settings: LocalDeviceSettingsValue,
  ceiling: LocalControlCeiling,
  now: number,
): void {
  for (const key of Object.keys(ceiling) as (keyof LocalControlCeiling)[]) {
    if (key !== "maxLeaseMs" && settings[key] > ceiling[key])
      throw new Error(`Local control ceiling exceeded: ${key}`);
  }
  if (
    settings.enabled &&
    (settings.leaseUntil <= now || settings.leaseUntil > now + ceiling.maxLeaseMs)
  )
    throw new Error("Local work lease exceeds its finite approval");
}
