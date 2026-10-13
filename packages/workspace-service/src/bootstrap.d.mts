export interface WorkspacePayload {
  version: 1;
  architecture: "x64" | "arm64";
  libc: "glibc";
  release: string;
  archiveSha256: string;
  fileName: string;
  size: number;
  path: string;
  identity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
}
export const WORKSPACE_INSTALL_SCRIPT: string;
export const WORKSPACE_PROBE_SCRIPT: string;
export const WORKSPACE_CONFIGURE_SCRIPT: string;
export const WORKSPACE_LOCAL_BOOTSTRAP_SCRIPT: string;
export const WORKSPACE_HEALTH_SCRIPT: string;
export const WORKSPACE_START_SCRIPT: string;
export function loadWorkspacePayload(
  directory: string,
  architecture: string,
): Promise<WorkspacePayload>;
export function workspaceInstallInput(payload: WorkspacePayload): AsyncIterable<Uint8Array>;
export const WORKSPACE_PAYLOAD_DIRECTORY: URL;
