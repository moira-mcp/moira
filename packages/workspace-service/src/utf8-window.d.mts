export function utf8Window(
  bytes: Uint8Array,
  maximum: number,
  options?: { terminal?: boolean },
): {
  text?: string;
  bytes?: number;
  binary?: boolean;
  minimum_bytes?: number;
  pending_utf8?: boolean;
};
