import type { Readable } from "node:stream";
export class RequestBodyLimitError extends Error {
  publicCode: "BODY_TOO_LARGE";
  status: 413;
  limitBytes: number;
  receivedBytes: number;
  constructor(limitBytes: number, receivedBytes: number);
}
export function readJsonBody(request: Readable, options?: { maxBytes?: number }): Promise<unknown>;
export function readOwnerJsonBody(request: Readable): Promise<Record<string, unknown>>;
