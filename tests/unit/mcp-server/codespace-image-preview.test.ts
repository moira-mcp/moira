import { beforeAll, describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import type { CodespaceFileOperationResponse, CodespaceOperationRecord } from "@mcp-moira/shared";
import { previewImageResult } from "../../../packages/mcp-server/src/tools/codespace-image-preview.js";

let png: Buffer;
let jpeg: Buffer;
beforeAll(async () => {
  const pixel = { create: { width: 3, height: 2, channels: 3 as const, background: "#aabbcc" } };
  png = await sharp(pixel).png().toBuffer();
  jpeg = await sharp(pixel).jpeg().toBuffer();
});

function operation(
  state: CodespaceOperationRecord["state"] = "succeeded",
): CodespaceOperationRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "secret-user",
    resourceId: "00000000-0000-4000-8000-000000000002",
    resourceGeneration: 3,
    authorizationGeneration: 7,
    provider: "local-sandboxes",
    providerResourceName: "secret-runtime",
    remoteMarker: "secret-marker",
    kind: "download",
    state,
    inputBytes: 0,
    stdoutLimitBytes: 4 * 1024 * 1024,
    stderrLimitBytes: 1,
    outputBytes: 0,
    exitCode: null,
    remoteCleanupPending: 0,
    resultExpiresAt: 500,
    deadlineAt: 400,
    claimId: "secret-claim",
    claimExpiresAt: 300,
    lastOutcome: "secret-internal-outcome",
    createdAt: 100,
    updatedAt: 200,
  };
}

function response(bytes: Buffer): CodespaceFileOperationResponse {
  return {
    operation: { ...operation(), outputBytes: bytes.length },
    result: {
      action: "download",
      path: "screenshot.untrusted-extension",
      offset: 0,
      totalSize: bytes.length,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function changedPngDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

describe("codespace image preview projection", () => {
  test.each(["reserved", "running", "cancel_pending", "reconcile_pending"] as const)(
    "%s download reports an unconfirmed outcome with recovery identity and no image",
    (state) => {
      const projected = previewImageResult({ operation: operation(state), result: null });
      expect(projected.isError).toBe(true);
      expect(projected.structuredContent).toEqual({
        operation_id: operation(state).id,
        error: {
          code: "CODESPACE_PROVIDER_UNAVAILABLE",
          message:
            "The image download could not be confirmed; recover this operation without repeating it.",
        },
      });
      expect(projected.content).toHaveLength(1);
      expect(JSON.stringify(projected)).not.toContain("secret-");
    },
  );

  test.each(["png", "jpeg"] as const)(
    "complete %s bytes return a native image with detected dimensions and safe metadata",
    (format) => {
      const bytes = format === "png" ? png : jpeg;
      const projected = previewImageResult(response(bytes));
      expect(projected.isError).toBeUndefined();
      expect(projected.structuredContent).toEqual({
        mime_type: `image/${format}`,
        width: 3,
        height: 2,
        size_bytes: bytes.length,
      });
      const block = projected.content[1];
      expect(block.type).toBe("image");
      if (block.type !== "image") throw new Error("Expected native ImageContent");
      expect(Buffer.from(block.data, "base64")).toEqual(bytes);
      expect(JSON.stringify(projected.structuredContent)).not.toContain("secret-");
      expect(JSON.stringify(projected.structuredContent)).not.toContain(block.data);
    },
  );

  test.each(["failed", "cancelled", "timed_out"] as const)(
    "%s operation cannot publish otherwise valid image bytes",
    (state) => {
      const input = response(png);
      input.operation.state = state;
      const projected = previewImageResult(input);
      expect(projected.isError).toBe(true);
      expect(projected.content.every((block) => block.type === "text")).toBe(true);
      expect(projected.structuredContent).toMatchObject({
        operation_id: operation(state).id,
        error: {
          code:
            state === "failed"
              ? "CODESPACE_FILE_REJECTED"
              : state === "cancelled"
                ? "CODESPACE_OPERATION_CANCELLED"
                : "CODESPACE_OPERATION_TIMED_OUT",
        },
      });
    },
  );

  test.each([
    [0, 2],
    [8193, 1],
    [1, 8193],
    [4001, 4000],
  ])("declared dimensions %i×%i exceed the trusted preview bounds", (width, height) => {
    expect(previewImageResult(response(changedPngDimensions(width, height))).isError).toBe(true);
  });

  test("full finite image bounds reject large bytes before projection", () => {
    const input = response(Buffer.alloc(4 * 1024 * 1024 + 1));
    expect(previewImageResult(input).isError).toBe(true);
  });

  test.each(["digest", "partial-offset", "partial-size", "operation-limit"] as const)(
    "%s mismatch cannot turn file bytes into an image",
    (failure) => {
      const input = response(png);
      if (!input.result || "state" in input.result || input.result.action !== "download")
        throw new Error("Expected download fixture");
      if (failure === "digest") input.result.sha256 = "0".repeat(64);
      if (failure === "partial-offset") input.result.offset = 1;
      if (failure === "partial-size") input.result.totalSize++;
      if (failure === "operation-limit") input.operation.stdoutLimitBytes = png.length - 1;
      expect(previewImageResult(input).isError).toBe(true);
    },
  );

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
    const projected = previewImageResult(response(bytes));
    expect(projected.isError).toBe(true);
    expect(projected.content.every((block) => block.type === "text")).toBe(true);
  });

  test("wrong operation kind and missing terminal bytes are refused", () => {
    const input = response(png);
    input.operation.kind = "read";
    expect(previewImageResult(input).isError).toBe(true);
    expect(previewImageResult({ operation: operation(), result: null }).isError).toBe(true);
  });
});
