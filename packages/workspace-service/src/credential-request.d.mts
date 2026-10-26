import type { ScopedCredentialAction } from "../../shared/src/codespaces/scoped-credential-types.js";
import type { LocalSetupContext } from "../../shared/src/codespaces/local-setup-types.js";
export type CredentialRequestState =
  "prepared" | "unconfirmed" | "live" | "refused" | "dispose_pending" | "disposed" | "absent";
interface CredentialRequestTarget {
  resourceId: string;
  resourceGeneration: number;
  action: ScopedCredentialAction;
}
type CredentialRequestParent =
  | { parentRequestId: string; localSetup: LocalSetupContext }
  | { parentRequestId?: never; localSetup?: never };
export type CredentialRequestRecord = CredentialRequestTarget &
  CredentialRequestParent & {
    requestId: string;
    state: CredentialRequestState;
    credentialId?: string;
  };
export interface CredentialRequestStore {
  read(requestId: string): Promise<unknown | null>;
  write(requestId: string, record: CredentialRequestRecord): Promise<void>;
  requestIds?(): Promise<string[]>;
}
export function prepareCredentialRequest(
  store: CredentialRequestStore,
  binding: CredentialRequestTarget & CredentialRequestParent,
): Promise<CredentialRequestRecord>;
export function inspectCredentialRequest(
  store: CredentialRequestStore,
  requestId: string,
): Promise<CredentialRequestRecord | null>;
export function findCredentialRequests(
  store: CredentialRequestStore,
  parentRequestId: string,
): Promise<CredentialRequestRecord[]>;
export function updateCredentialRequest(
  store: CredentialRequestStore,
  requestId: string,
  state: CredentialRequestState,
  credentialId?: string,
): Promise<CredentialRequestRecord>;
