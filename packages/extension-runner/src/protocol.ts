/**
 * Wire shapes shared by the runner service, its handler processes and Moira's client.
 *
 * Everything here is JSON: the boundary exists so that extension code never shares objects with
 * Moira, and a shape that could not survive serialisation would quietly break that guarantee.
 */

import type { ExtensionNodeDeclaration } from "@mcp-moira/workflow-engine/extensions/contract";

/** Contract version this runner speaks; mismatches are refused rather than adapted. */
export { EXTENSION_API_VERSION } from "@mcp-moira/workflow-engine/extensions/contract";

/** GET /health */
export interface RunnerHealthResponse {
  apiVersion: string;
  ready: boolean;
  extensions: Array<{ name: string; version: string; nodeTypes: string[]; healthy: boolean }>;
  rejected: Array<{ directory: string; reasons: string[] }>;
}

/** GET /nodes — metadata and schemas only, never code. */
export interface RunnerNodesResponse {
  apiVersion: string;
  extensions: Array<{
    name: string;
    version: string;
    entrypoint: string;
    nodes: ExtensionNodeDeclaration[];
    settings?: unknown[];
    permissions?: unknown;
  }>;
}

/** POST /invoke */
export interface RunnerInvokeRequest {
  nodeType: string;
  nodeId: string;
  executionId: string;
  workflowId: string;
  config: Record<string, unknown>;
  input?: Record<string, unknown>;
  timeoutMs: number;
  /** Secret values Moira resolved for the aliases the manifest was granted. */
  secrets?: Record<string, string | null>;
}

/** Failure classes; identical to the ones Moira's handler routes to `error`. */
export type RunnerFailureKind =
  "handler-error" | "timeout" | "runner-unavailable" | "invalid-output";

/**
 * Size limits for artifacts. They exist because the return path is the one direction that had no
 * bound: the request body is capped, but a handler could otherwise put unlimited content into the
 * response, the service's memory and — through the node result — the stored execution.
 */
export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_ARTIFACT_BYTES_PER_CALL = 1_000_000;

/** An artifact a handler wrote during the call; it travels with the result, not out of band. */
export interface RunnerArtifact {
  name: string;
  content: string;
}

export interface RunnerInvokeSuccess {
  ok: true;
  output: Record<string, unknown>;
  artifacts?: RunnerArtifact[];
}

export interface RunnerInvokeFailure {
  ok: false;
  kind: RunnerFailureKind;
  message: string;
}

export type RunnerInvokeResponse = RunnerInvokeSuccess | RunnerInvokeFailure;

/** Messages between the service process and a handler process. */
export type HostRequest =
  { kind: "invoke"; id: string; request: RunnerInvokeRequest } | { kind: "cancel"; id: string };

export type HostResponse =
  | { kind: "ready"; nodeTypes: string[] }
  | { kind: "load-failed"; message: string }
  | { kind: "result"; id: string; response: RunnerInvokeResponse }
  | { kind: "log"; id: string; message: string; fields?: Record<string, unknown> }
  | { kind: "artifact"; id: string; name: string; content: string };
