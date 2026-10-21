import { TextDecoder } from "node:util";

/** Decode a bounded prefix without consuming a partial UTF-8 scalar. Offsets are bytes. */
export function utf8Window(bytes, maximum, { terminal = true } = {}) {
  const limit = Math.min(bytes.length, maximum);
  let offset = 0;
  while (offset < limit) {
    const first = bytes[offset];
    const width =
      first < 0x80
        ? 1
        : first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
    if (!width) return { binary: true };
    if (offset + width > bytes.length) {
      if (terminal) return { binary: true };
      return {
        text: new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, offset)),
        bytes: offset,
        pending_utf8: true,
      };
    }
    try {
      new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(offset, offset + width));
    } catch {
      return { binary: true };
    }
    if (offset + width > limit) {
      if (!offset) return { minimum_bytes: width };
      break;
    }
    offset += width;
  }
  return {
    text: new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, offset)),
    bytes: offset,
  };
}
