import type { CodespaceVerifiedByteStream } from "@mcp-moira/shared";

/** An in-memory fixture with the same explicit ownership as a checked file descriptor. */
export function ownedByteStream(input: AsyncIterable<Uint8Array>): CodespaceVerifiedByteStream {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const stream = (async function* () {
    try {
      yield* input;
    } finally {
      settle();
    }
  })();
  return Object.assign(stream, {
    settled,
    async close() {
      await stream.return(undefined);
      settle();
    },
  });
}
