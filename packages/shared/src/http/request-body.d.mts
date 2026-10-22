import type { Readable } from "node:stream";
export function readJsonBody(request: Readable): Promise<unknown>;
export function readOwnerJsonBody(request: Readable): Promise<Record<string, unknown>>;
