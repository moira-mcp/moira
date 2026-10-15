import type { PublicationSource } from "./publications.mjs";
import type { NativeFileOpener } from "./native-source.mjs";
export type WorkspaceRepositoryBinding = {
  repositoryFullName: string;
  root: string;
  origin: string;
  canonicalOrigin?: string;
  dev: number;
  ino: number;
};

export type WorkspaceOwnerOptions = {
  stateRoot: string;
  binding: WorkspaceRepositoryBinding;
  releaseIdentity?: string;
  searchExecutable?: string;
  sourceProxy?: string;
  sourceOpener?: NativeFileOpener;
  communicationTransport?: import("./owner-communication.mjs").OwnerCommunicationTransport & {
    artifact: NonNullable<
      Parameters<
        typeof import("./owner-communication.mjs").createOwnerCommunication
      >[0]["extensionArtifact"]
    >;
  };
  ownerRuntimeDirectory?: string;
  renderProgress?: NonNullable<
    Parameters<
      typeof import("./owner-communication.mjs").createOwnerCommunication
    >[0]["renderProgress"]
  >;
  renderMaterialize?: NonNullable<
    Parameters<
      typeof import("./owner-communication.mjs").createOwnerCommunication
    >[0]["renderMaterialize"]
  >;
  collectCredentialRequest?: (requestId: string) => Promise<Record<string, unknown> | null>;
  pullRequest?: (
    action: "pull_request_create" | "pull_request_get" | "pull_request_find",
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  publicationScope?: {
    resourceId: string;
    resourceGeneration: number;
    authorizationGeneration: number;
    publicOrigin: string;
  };
};

type Value = Record<string, unknown>;
type Bytes = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
type Consume<T> = (range: {
  body: AsyncIterable<Uint8Array>;
  total: number;
  size: number;
}) => Promise<T>;
export interface WorkspaceOwner {
  execute(body: Value): Promise<Value>;
  nativeUpload(body: Value): Promise<Value>;
  write(input: {
    requestId: string;
    path: string;
    expected: Value;
    source: Bytes;
    expectedSize?: number | null;
  }): Promise<Value>;
  patch(body: Value): Promise<Value>;
  pullRequestAction(body: Value): Promise<Value>;
  inspect(requestId: string): Promise<Value>;
  observe(requestId: string, waitMs: number, signal?: AbortSignal): Promise<Value>;
  input(requestId: string, source: Bytes, declaredSize?: number | null): Promise<Value>;
  cancel(requestId: string): Promise<Value>;
  file(body: Value, signal?: AbortSignal): Promise<Value>;
  publish(body: Value): Promise<Value>;
  fileRange<T>(
    path: string,
    offset: number,
    length: number | null,
    consume: Consume<T>,
  ): Promise<T>;
  outputRange<T>(
    requestId: string,
    stream: string,
    offset: number,
    length: number | null,
    consume: Consume<T>,
  ): Promise<T>;
  health(): Promise<Value>;
  submitCommunication(
    input: unknown,
    options?: { stream?: AsyncIterable<Uint8Array> },
  ): Promise<Value>;
  inspectCommunication(requestId: string): Promise<Value>;
  openPublication(token: string, signal?: AbortSignal): Promise<PublicationSource>;
  close(): Promise<void>;
}
export function createWorkspaceOwner(options: WorkspaceOwnerOptions): Promise<WorkspaceOwner>;
