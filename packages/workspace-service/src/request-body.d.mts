import type { IncomingMessage } from "node:http";
export function readOwnerJsonBody(request: IncomingMessage): Promise<Record<string, unknown>>;
