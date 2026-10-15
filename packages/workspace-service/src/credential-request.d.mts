import type { ScopedCredentialAction } from "../../shared/src/codespaces/scoped-credential-types.js";
export type CredentialRequestState =
  "prepared" | "unconfirmed" | "live" | "refused" | "dispose_pending" | "disposed" | "absent";
export interface CredentialRequestRecord {
  requestId: string;
  resourceId: string;
  resourceGeneration: number;
  action: ScopedCredentialAction;
  state: CredentialRequestState;
  credentialId?: string;
}
export interface CredentialRequestStore {
  read(requestId: string): Promise<unknown | null>;
  write(requestId: string, record: CredentialRequestRecord): Promise<void>;
}
export function prepareCredentialRequest(
  store: CredentialRequestStore,
  binding: { resourceId: string; resourceGeneration: number; action: ScopedCredentialAction },
): Promise<CredentialRequestRecord>;
export function inspectCredentialRequest(
  store: CredentialRequestStore,
  requestId: string,
): Promise<CredentialRequestRecord | null>;
export function updateCredentialRequest(
  store: CredentialRequestStore,
  requestId: string,
  state: CredentialRequestState,
  credentialId?: string,
): Promise<CredentialRequestRecord>;
