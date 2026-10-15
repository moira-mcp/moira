import type { Server } from "node:http";
import type { WorkspaceOwner, WorkspaceOwnerOptions } from "./owner.mjs";
export type { WorkspaceRepositoryBinding } from "./owner.mjs";
export function startWorkspaceService(
  options: WorkspaceOwnerOptions & { socketPath: string },
): Promise<{
  server: Server;
  owner: WorkspaceOwner;
  socketPath: string;
  close(): Promise<void>;
}>;
