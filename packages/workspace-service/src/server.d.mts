import type { Server } from "node:http";
import type { openNativeFile } from "./native-source.mjs";

export type WorkspaceRepositoryBinding = {
  repositoryFullName: string;
  root: string;
  origin: string;
  canonicalOrigin?: string;
  dev: number;
  ino: number;
};

export function startWorkspaceService(options: {
  socketPath: string;
  stateRoot: string;
  binding: WorkspaceRepositoryBinding;
  releaseIdentity?: string;
  searchExecutable?: string;
  sourceProxy?: string;
  sourceOpener?: typeof openNativeFile;
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
}): Promise<{ server: Server; socketPath: string; close(): Promise<void> }>;
