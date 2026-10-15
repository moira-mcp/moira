import { request } from "node:http";
import process from "node:process";
import { SourceRefusal } from "../../packages/workspace-service/src/native-source.mjs";

/** Controlled source transport, injected only by the private owner process factory. */
export function createSourceOpener({ socketPath }) {
  return async (reference, { signal } = {}) => {
    const incoming = await new Promise((resolve, reject) => {
      const outgoing = request(
        {
          socketPath,
          method: "GET",
          signal,
          path: `/source/${encodeURIComponent(reference.fileId)}`,
          headers: {
            "x-fixture-owner-pid": String(process.pid),
            "x-fixture-source-url": reference.downloadUrl,
          },
        },
        resolve,
      );
      outgoing.once("error", () => reject(new SourceRefusal()));
      outgoing.end();
    });
    if (incoming.statusCode !== 200) {
      incoming.destroy();
      throw new SourceRefusal();
    }
    return {
      body: (async function* () {
        try {
          yield* incoming;
        } catch {
          throw new SourceRefusal();
        }
      })(),
      contentLength: Number(incoming.headers["content-length"]),
      mimeType: incoming.headers["content-type"],
      cancel: () => incoming.destroy(),
      close: async () => {
        incoming.destroy();
      },
    };
  };
}
