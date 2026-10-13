import type { IncomingMessage } from "node:http";
import type { Readable, Writable } from "node:stream";

export function workspaceRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: string | Buffer | Readable,
  headers?: Record<string, string>,
): Promise<IncomingMessage>;
export function runWorkspaceCli(
  args: string[],
  options?: {
    socketPath?: string;
    stdout?: Writable;
  },
): Promise<void>;
