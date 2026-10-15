import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { Buffer } from "node:buffer";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function dimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
}

/** Validate the bounded PNG container and declared dimensions, not decoded pixels. */
function png(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let header = null;
  let data = false;
  let dataEnded = false;
  let palette = false;
  let indexed = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      type[2] !== type[2].toUpperCase() ||
      ["acTL", "fcTL", "fdAT"].includes(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      return null;
    if (!header) {
      if (type !== "IHDR" || length !== 13) return null;
      const width = bytes.readUInt32BE(offset + 8),
        height = bytes.readUInt32BE(offset + 12);
      const depth = bytes[offset + 16],
        color = bytes[offset + 17];
      indexed = color === 3;
      const depths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !dimensions(width, height) ||
        !depths[color]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] > 1
      )
        return null;
      header = { mime_type: "image/png", width, height };
    } else if (type === "IHDR") return null;
    else if (type === "IDAT") {
      if (dataEnded || (indexed && !palette)) return null;
      data ||= length > 0;
    } else if (type === "IEND") {
      return length === 0 && data && end === bytes.length ? header : null;
    } else {
      if (data) dataEnded = true;
      // Unknown critical chunks cannot be interpreted safely; ancillary chunks are bounded data.
      if (type[0] === type[0].toUpperCase() && type !== "PLTE") return null;
      if (type === "PLTE" && (data || length === 0 || length > 768 || length % 3 !== 0))
        return null;
      if (type === "PLTE") {
        if (palette) return null;
        palette = true;
      }
    }
    offset = end;
  }
  return null;
}

/** Walk JPEG markers and scan framing; never decompress attacker-controlled pixels. */
function jpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let header = null;
  let components = 0;
  let scanned = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return header && scanned && offset === bytes.length ? header : null;
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > bytes.length
    )
      return null;
    const length = bytes.readUInt16BE(offset),
      end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (header || length < 8) return null;
      const height = bytes.readUInt16BE(offset + 3),
        width = bytes.readUInt16BE(offset + 5);
      components = bytes[offset + 7];
      if (
        bytes[offset + 2] !== 8 ||
        ![1, 3, 4].includes(components) ||
        length !== 8 + 3 * components ||
        !dimensions(width, height)
      )
        return null;
      header = { mime_type: "image/jpeg", width, height };
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return null;
    offset = end;
    if (marker === 0xda) {
      const count = bytes[end - length + 2];
      if (!header || count < 1 || count > components || length !== 6 + 2 * count) return null;
      scanned = true;
      // Stuffed FF00 and restart markers belong to entropy data, not new segments.
      let found = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        const code = bytes[next];
        if (code === 0 || (code >= 0xd0 && code <= 0xd7)) {
          offset = next + 1;
          continue;
        }
        found = true;
        break;
      }
      if (!found) return null;
    }
  }
  return null;
}

/** The owner supplies complete bytes; explicit caller bounds are checked before projection. */
export function previewImageBytes(bytes) {
  const reject = (message) => ({
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: { code: "CODESPACE_IMAGE_REJECTED", message } }),
      },
    ],
  });
  if (bytes.length === 0) return reject("Image preview requires a complete PNG or JPEG.");
  const header = png(bytes) ?? jpeg(bytes);
  if (!header) return reject("The image framing or dimensions are invalid for preview.");
  const metadata = {
    ...header,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return {
    structuredContent: metadata,
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      { type: "image", mimeType: header.mime_type, data: bytes.toString("base64") },
    ],
  };
}
