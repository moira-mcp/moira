import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
export function workspaceRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Uint8Array | Readable,
  headers?: Record<string, string>,
): Promise<IncomingMessage>;
export function workspaceJson(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>>;
