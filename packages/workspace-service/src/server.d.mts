import type { Server } from "node:http";

export type WorkspaceRepositoryBinding = {
  repositoryFullName: string;
  root: string;
  origin: string;
  dev: number;
  ino: number;
};

export function startWorkspaceService(options: {
  socketPath: string;
  stateRoot: string;
  binding: WorkspaceRepositoryBinding;
  releaseIdentity?: string;
  searchExecutable?: string;
}): Promise<{ server: Server; socketPath: string; close(): Promise<void> }>;
