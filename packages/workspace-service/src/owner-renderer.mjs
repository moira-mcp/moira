import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { materializeTextFilesSchema } from "../../shared/src/communication-owner-protocol.ts";

/** A private owned source; archive construction never runs in the cloud resolver. */
export async function renderOwnerMaterialize(input, { signal } = {}) {
  signal?.throwIfAborted();
  const files = materializeTextFilesSchema.parse(input);
  const pack = tar.pack();
  // The producer can fail before capture attaches its iterator. The iterator
  // still observes that error; this listener prevents an unhandled stream event.
  pack.on("error", () => {});
  const aborted = () => pack.destroy(signal.reason);
  signal?.addEventListener("abort", aborted, { once: true });
  let closing;
  const settled = (async () => {
    for (const file of files) {
      signal?.throwIfAborted();
      const entry = pack.entry({
        name: file.path,
        type: "file",
        mode: 0o644,
        size: Buffer.byteLength(file.content, "utf8"),
        mtime: new Date(0),
      });
      await pipeline(
        Readable.from(
          (async function* () {
            for (let offset = 0; offset < file.content.length;) {
              let end = Math.min(offset + 16384, file.content.length);
              // Keep a UTF-16 surrogate pair in the same UTF-8 encoding chunk.
              if (end < file.content.length && /[\uD800-\uDBFF]/.test(file.content[end - 1])) end--;
              yield Buffer.from(file.content.slice(offset, end), "utf8");
              offset = end;
            }
          })(),
        ),
        entry,
        ...(signal ? [{ signal }] : []),
      );
    }
    pack.finalize();
  })()
    .catch((error) => {
      // tar-stream's entry closes synchronously on cancellation, before the
      // pipeline abort listener can report the original signal reason.
      const failure = signal?.aborted ? signal.reason : error;
      pack.destroy(failure);
      throw failure;
    })
    .finally(() => signal?.removeEventListener("abort", aborted));
  void settled.catch(() => undefined);
  const close = () =>
    (closing ??= (async () => {
      pack.destroy();
      await settled;
    })());
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const bytes of pack) yield bytes;
        await settled;
      } finally {
        await close();
      }
    },
    close,
    settled,
  };
}

/** Loaded as a private release asset, before importing the native rasterizer. */
export async function renderOwnerProgress(descriptor, { signal, cacheRoot } = {}) {
  signal?.throwIfAborted();
  const root = dirname(fileURLToPath(import.meta.url));
  process.env.FONTCONFIG_FILE = join(root, "fonts", "fonts.conf");
  if (cacheRoot) {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    process.env.XDG_CACHE_HOME = cacheRoot;
  }
  if (
    !descriptor ||
    !["steps", "map"].includes(descriptor.kind) ||
    !Array.isArray(descriptor.graph?.nodes) ||
    typeof descriptor.run?.executionId !== "string"
  )
    throw Object.assign(new Error("Invalid progress descriptor"), {
      publicCode: "PROGRESS_DESCRIPTOR_INVALID",
      status: 400,
    });
  const rendered =
    descriptor.kind === "steps"
      ? await (
          await import("../../workflow-engine/src/utils/execution-progress-steps.ts")
        ).renderExecutionProgressStepsImage(
          descriptor.graph,
          descriptor.run,
          descriptor.renderContext,
        )
      : await (
          await import("../../workflow-engine/src/utils/execution-progress-image.ts")
        ).renderExecutionProgressImage(
          descriptor.graph,
          descriptor.run,
          descriptor.options,
          descriptor.statistics,
          descriptor.renderContext,
        );
  signal?.throwIfAborted();
  if (!rendered)
    throw Object.assign(new Error("Progress is unavailable"), {
      publicCode: "PROGRESS_UNAVAILABLE",
      status: 409,
    });
  return rendered.buffer;
}
