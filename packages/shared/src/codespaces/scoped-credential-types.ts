import { z } from "zod";
import { WORKSPACE_REQUEST_ID_PATTERN } from "./workspace-request-id.mjs";

export const scopedCredentialActionSchema = z.enum([
  "fetch",
  "push",
  "pull_request_read",
  "pull_request_create",
  "codespaces_provision",
]);
export type ScopedCredentialAction = z.infer<typeof scopedCredentialActionSchema>;
const generation = z.number().int().positive().safe();
export const scopedCredentialAcquireSchema = z
  .object({
    resourceId: z.string().uuid(),
    resourceGeneration: generation,
    action: scopedCredentialActionSchema,
    requestId: z.string().regex(WORKSPACE_REQUEST_ID_PATTERN),
  })
  .strict();
export const scopedCredentialReleaseSchema = z
  .object({
    resourceId: z.string().uuid(),
    resourceGeneration: generation,
  })
  .strict();
export const scopedCredentialViewSchema = z
  .object({
    credentialId: z.string().uuid(),
    token: z.string().regex(/^[A-Za-z0-9_]+$/),
    expiresAt: z.number().int().positive().safe(),
    useUntil: z.number().int().positive().safe(),
    repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  })
  .strict();
export type ScopedCredentialAcquire = z.infer<typeof scopedCredentialAcquireSchema>;
export type ScopedCredentialRelease = z.infer<typeof scopedCredentialReleaseSchema>;
export type ScopedCredentialView = z.infer<typeof scopedCredentialViewSchema>;
export const scopedCredentialCollectionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("live"), credential: scopedCredentialViewSchema }).strict(),
  z.object({ state: z.enum(["absent", "unconfirmed", "disposed", "refused"]) }).strict(),
]);
export type ScopedCredentialCollection = z.infer<typeof scopedCredentialCollectionSchema>;
export type ScopedCredentialPermissions = Partial<
  Record<
    "contents" | "metadata" | "pull_requests" | "codespaces" | "codespaces_lifecycle_admin",
    "read" | "write"
  >
>;
export const SCOPED_CREDENTIAL_PERMISSIONS: Readonly<
  Record<ScopedCredentialAction, ScopedCredentialPermissions>
> = {
  fetch: { contents: "read", metadata: "read" },
  push: { contents: "write", metadata: "read" },
  pull_request_read: { pull_requests: "read", metadata: "read" },
  pull_request_create: { pull_requests: "write", metadata: "read" },
  codespaces_provision: {
    metadata: "read",
    codespaces: "read",
    codespaces_lifecycle_admin: "write",
  },
};

/** Private provider candidate: retained before interpreting its untrusted scope metadata. */
export interface ScopedCredentialCandidate {
  token: string;
  expiresAt: number | null;
  metadata: unknown;
}

export interface GitHubScopedCredentialClient {
  createScopedToken(
    parentToken: string,
    input: { repositoryId: number; target: string; permissions: ScopedCredentialPermissions },
  ): Promise<ScopedCredentialCandidate>;
  revokeScopedToken(token: string): Promise<void>;
}
export interface ScopedCredentialPayload {
  token: string | null;
  expiresAt: number | null;
}
export type ScopedCredentialState =
  "issuing" | "unconfirmed" | "live" | "dispose_pending" | "disposed" | "refused";
const failureOutcomes = {
  SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED: "unconfirmed",
  SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED: "unconfirmed",
  SCOPED_CREDENTIAL_DISPOSAL_PENDING: "unconfirmed",
  SCOPED_CREDENTIAL_AUTHORITY_REFUSED: "refused",
  SCOPED_CREDENTIAL_CONFLICT: "refused",
  SCOPED_CREDENTIAL_CUSTODY_REFUSED: "refused",
  SCOPED_CREDENTIAL_INVALID: "refused",
  SCOPED_CREDENTIAL_ISSUANCE_REFUSED: "refused",
  SCOPED_CREDENTIAL_NOT_FOUND: "refused",
  SCOPED_CREDENTIAL_SCOPE_REFUSED: "refused",
  SCOPED_CREDENTIAL_UNAVAILABLE: "refused",
} as const;
export type ScopedCredentialErrorCode = keyof typeof failureOutcomes;
function knownFailureCode(code: unknown): code is ScopedCredentialErrorCode {
  return typeof code === "string" && Object.hasOwn(failureOutcomes, code);
}
/** Unknown wire failures cannot establish a confirmed refusal. */
export function scopedCredentialFailureOutcome(code: unknown): "unconfirmed" | "refused" | null {
  return knownFailureCode(code) ? failureOutcomes[code] : null;
}
export class ScopedCredentialError extends Error {
  requestId?: string;
  deviceId?: string;
  resourceId?: string;
  securityRequestId?: string;
  readonly code: ScopedCredentialErrorCode;
  readonly status: number;
  constructor(code: ScopedCredentialErrorCode, status = 409) {
    super(
      scopedCredentialFailureOutcome(code) === "unconfirmed"
        ? "Scoped credential operation outcome is unconfirmed"
        : "Scoped credential operation refused",
    );
    this.name = "ScopedCredentialError";
    this.code = code;
    this.status = status;
  }
}

/** A documented provider refusal proves this submission did not return a child. */
export class ScopedCredentialIssuanceRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Scoped credential issuance refused");
    this.name = "ScopedCredentialIssuanceRefused";
    this.status = status;
  }
}
