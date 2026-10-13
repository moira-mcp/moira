import { beforeAll, describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { previewImageBytes } from "../../../packages/mcp-server/src/tools/codespace-image-preview.js";

let png: Buffer;
let jpeg: Buffer;
beforeAll(async () => {
  const pixel = { create: { width: 3, height: 2, channels: 3 as const, background: "#aabbcc" } };
  png = await sharp(pixel).png().toBuffer();
  jpeg = await sharp(pixel).jpeg().toBuffer();
});

function changedPngDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

describe("workspace image preview projection", () => {
  test.each(["png", "jpeg"] as const)(
    "complete %s bytes return a native image with detected dimensions and safe metadata",
    (format) => {
      const bytes = format === "png" ? png : jpeg;
      const projected = previewImageBytes(bytes);
      expect(projected.isError).toBeUndefined();
      expect(projected.structuredContent).toEqual({
        mime_type: `image/${format}`,
        width: 3,
        height: 2,
        size_bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const block = projected.content[1];
      expect(block.type).toBe("image");
      if (block.type !== "image") throw new Error("Expected native ImageContent");
      expect(Buffer.from(block.data, "base64")).toEqual(bytes);
      expect(JSON.stringify(projected.structuredContent)).not.toContain("secret-");
      expect(JSON.stringify(projected.structuredContent)).not.toContain(block.data);
    },
  );

  test.each([
    [0, 2],
    [8193, 1],
    [1, 8193],
    [4001, 4000],
  ])("declared dimensions %i×%i exceed the trusted preview bounds", (width, height) => {
    expect(previewImageBytes(changedPngDimensions(width, height)).isError).toBe(true);
  });

  test("full finite image bounds reject large bytes before projection", () => {
    expect(previewImageBytes(Buffer.alloc(4 * 1024 * 1024 + 1)).isError).toBe(true);
  });

  test.each([
    "svg",
    "binary",
    "png-header",
    "png-truncated",
    "png-crc",
    "jpeg-header",
    "jpeg-truncated",
    "jpeg-segment",
  ] as const)("%s is refused rather than embedded as native image data", (failure) => {
    let bytes: Buffer;
    switch (failure) {
      case "svg":
        bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
        break;
      case "binary":
        bytes = Buffer.from([0, 1, 255, 20]);
        break;
      case "png-header":
        bytes = png.subarray(0, 33);
        break;
      case "png-truncated":
        bytes = png.subarray(0, png.length - 1);
        break;
      case "png-crc":
        bytes = Buffer.from(png);
        bytes[29] ^= 1;
        break;
      case "jpeg-header":
        bytes = jpeg.subarray(0, 4);
        break;
      case "jpeg-truncated":
        bytes = jpeg.subarray(0, jpeg.length - 1);
        break;
      case "jpeg-segment":
        bytes = Buffer.from([255, 216, 255, 224, 255, 255, 255, 217]);
        break;
    }
    const projected = previewImageBytes(bytes);
    expect(projected.isError).toBe(true);
    expect(projected.content.every((block) => block.type === "text")).toBe(true);
  });
});
