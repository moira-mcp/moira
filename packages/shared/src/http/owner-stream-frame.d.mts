import type { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
export const OWNER_STREAM_CONTENT_TYPE: "application/vnd.moira.owner-stream";
export function encodeOwnerFrame(
  control: unknown,
  source: AsyncIterable<Uint8Array>,
): {
  prefixLength: number;
  body: AsyncIterable<Uint8Array>;
};
export function readOwnerFrame(request: Readable): Promise<{
  control: unknown;
  body: Readable;
  prefixLength: number;
}>;
export function settleOwnerFrame(
  request: IncomingMessage,
  response: ServerResponse,
  frame?: { body: Readable },
): void;
