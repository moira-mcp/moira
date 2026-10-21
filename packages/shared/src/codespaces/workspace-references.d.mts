export type OwnerSelector =
  | { kind: "local"; deviceId: string; spaceId: string; operationMarker: string }
  | { kind: "github"; resourceId: string }
  | { kind: "controller"; deviceId: string; connectionId: string };
export const OPERATION_KINDS: readonly [
  "command",
  "file-change",
  "lifecycle",
  "repository",
  "pull-request",
  "delivery",
  "session",
  "unknown",
];
export type OperationKind = (typeof OPERATION_KINDS)[number];
export interface ControllerReference {
  deviceId: string;
  connectionId: string;
}
export interface WorkspaceReference {
  resourceId: string;
  provider: "local-sandboxes" | "github-codespaces";
  deviceId?: string;
  generation: number;
}
export interface OperationReference {
  owner: OwnerSelector;
  requestId: string;
  kind: OperationKind;
  journal?: "repository-create";
}
export interface ProcessReference {
  owner: OwnerSelector;
  requestId: string;
}
export interface FileReference {
  owner: OwnerSelector;
  binding: string;
  path: string;
  version: { size: number; sha256: string };
  identity: {
    dev: string;
    ino: string;
    nlink: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
    birthtimeNs?: string;
  };
}
export interface ReferencePayloads {
  "workspace-identity": Omit<WorkspaceReference, "generation">;
  workspace: WorkspaceReference;
  controller: ControllerReference;
  target: {
    provider: WorkspaceReference["provider"];
    repositoryId: string;
    controller?: ControllerReference;
  };
  installation: { controller: ControllerReference; installationId: string };
  operation: OperationReference;
  process: ProcessReference;
  file: FileReference;
  "file-cursor": { file: string; offset: number; line: number };
  "output-cursor": { process: string; stream: "stdout" | "stderr"; offset: number };
}
export type ReferenceKind = keyof ReferencePayloads;
export function isOwnerSelector(value: unknown): value is OwnerSelector;
export function encodeReference<K extends ReferenceKind>(
  kind: K,
  value: ReferencePayloads[K],
): string;
export function decodeReference<K extends ReferenceKind>(
  reference: string,
  expectedKind: K,
): ReferencePayloads[K];
export function decodeReference(reference: string): ReferencePayloads[ReferenceKind];
export function isReference(reference: unknown, expectedKind?: ReferenceKind): reference is string;
