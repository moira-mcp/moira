import { describe, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import {
  OpenAINativeReferenceFetcher,
  trustedNativeFileHost,
} from "../../../packages/web-backend/src/services/workspace-native-reference-fetcher.js";

const reference = {
  fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
  downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/container/file?sig=secret",
  fileName: "input.bin",
  mimeType: "application/octet-stream",
  declaredSize: 3,
};

function response(status: number, headers: Record<string, string>, peer = "8.8.8.8") {
  const value = Readable.from([Buffer.from([1, 2, 3])]) as IncomingMessage;
  value.statusCode = status;
  value.headers = headers;
  Object.defineProperty(value, "socket", { value: { remoteAddress: peer } });
  return value;
}

function requestHarness(values: IncomingMessage[]) {
  const calls: RequestOptions[] = [];
  const request = ((options: RequestOptions, callback: (value: IncomingMessage) => void) => {
    calls.push(options);
    const result = new EventEmitter() as ClientRequest;
    Object.assign(result, {
      setTimeout: jest.fn(),
      destroy: (error?: Error) => queueMicrotask(() => result.emit("error", error)),
      end: () => queueMicrotask(() => callback(values.shift()!)),
    });
    return result;
  }) as unknown as typeof import("node:https").request;
  return { request, calls };
}

describe("OpenAI native file reference fetcher", () => {
  test("accepts the two-field native reference with absent MIME as bounded binary metadata", async () => {
    const incoming = response(200, { "content-length": "3" });
    const harness = requestHarness([incoming]);
    const fetcher = new OpenAINativeReferenceFetcher(
      harness.request,
      jest.fn(async () => [{ address: "8.8.8.8", family: 4 }]) as never,
    );
    const result = await fetcher.fetch({
      fileId: reference.fileId,
      downloadUrl: reference.downloadUrl,
    });
    expect(result).toMatchObject({ contentLength: 3, mimeType: "application/octet-stream" });
    result.cancel!();
    expect(incoming.destroyed).toBe(true);
  });

  test.each(["", "not-a-mime", "application/x-executable", "x".repeat(257)])(
    "rejects a present invalid MIME header %s",
    async (mimeType) => {
      const incoming = response(200, { "content-type": mimeType });
      const harness = requestHarness([incoming]);
      const fetcher = new OpenAINativeReferenceFetcher(
        harness.request,
        jest.fn(async () => [{ address: "8.8.8.8", family: 4 }]) as never,
      );
      await expect(fetcher.fetch(reference)).rejects.toThrow(/content type/);
      expect(incoming.destroyed).toBe(true);
    },
  );

  test("accepts only the narrow observed OpenAI issuer families", () => {
    expect(trustedNativeFileHost("files.oaiusercontent.com")).toBe(true);
    expect(trustedNativeFileHost("oaisdmntprdenmarkeast.blob.core.windows.net")).toBe(true);
    expect(trustedNativeFileHost("attacker.blob.core.windows.net")).toBe(false);
    expect(trustedNativeFileHost("oaisdmntpr.example.com")).toBe(false);
  });

  test("pins a public DNS answer into the HTTPS request and returns bounded metadata", async () => {
    const harness = requestHarness([
      response(200, { "content-length": "3", "content-type": "application/octet-stream" }),
    ]);
    const fetcher = new OpenAINativeReferenceFetcher(
      harness.request,
      jest.fn(async () => [{ address: "8.8.8.8", family: 4 }]) as never,
    );
    const result = await fetcher.fetch(reference);
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(result).toMatchObject({ contentLength: 3, mimeType: "application/octet-stream" });
    expect(harness.calls[0]).toMatchObject({
      hostname: reference.downloadUrl.split("/")[2],
      port: 443,
    });
  });

  test("rejects private or mixed DNS answers before opening a request", async () => {
    const harness = requestHarness([]);
    const fetcher = new OpenAINativeReferenceFetcher(
      harness.request,
      jest.fn(async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]) as never,
    );
    await expect(fetcher.fetch(reference)).rejects.toThrow(/unsafe address/);
    expect(harness.calls).toHaveLength(0);
  });

  test("revalidates redirect destinations and rejects a changed connected peer", async () => {
    const redirectHarness = requestHarness([
      response(302, { location: "https://127.0.0.1/latest/meta-data" }),
    ]);
    const redirectFetcher = new OpenAINativeReferenceFetcher(
      redirectHarness.request,
      jest.fn(async () => [{ address: "8.8.8.8", family: 4 }]) as never,
    );
    await expect(redirectFetcher.fetch(reference)).rejects.toThrow(/not trusted/);
    expect(redirectHarness.calls).toHaveLength(1);

    const peerHarness = requestHarness([
      response(
        200,
        { "content-length": "3", "content-type": "application/octet-stream" },
        "8.8.4.4",
      ),
    ]);
    const peerFetcher = new OpenAINativeReferenceFetcher(
      peerHarness.request,
      jest.fn(async () => [{ address: "8.8.8.8", family: 4 }]) as never,
    );
    await expect(peerFetcher.fetch(reference)).rejects.toThrow(/peer address changed/);
  });
});
