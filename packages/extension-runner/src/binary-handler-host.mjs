import { createReadStream } from "node:fs";
import process from "node:process";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

let controller;
let opened = false;
let sequence = 0;
const requests = new Map();
process.on("message", async (message) => {
  if (message.kind === "abort") {
    controller?.abort();
    return;
  }
  if (message.kind === "send-result") {
    const pending = requests.get(message.id);
    requests.delete(message.id);
    if (message.ok) pending?.resolve(message.result);
    else pending?.reject(new Error("Authorized binary transport did not confirm delivery"));
    return;
  }
  if (message.kind !== "invoke" || controller) return;
  controller = new globalThis.AbortController();
  try {
    const module = await import(pathToFileURL(process.env.MOIRA_EXTENSION_ENTRYPOINT).href);
    const channel = module.default?.communicationChannels?.find(
      (value) => value.id === message.channelId,
    );
    if (typeof channel?.binaryHandler !== "function")
      throw new Error("Installed channel has no owner binary handler");
    await channel.binaryHandler({
      message: {
        ...message.message,
        attachment: {
          ...message.metadata,
          open() {
            if (opened) throw new Error("Invocation source is already open");
            opened = true;
            process.send({ kind: "source-open" });
            return Readable.toWeb(createReadStream("", { fd: 7, autoClose: false }));
          },
        },
      },
      settings: message.settings,
      signal: controller.signal,
      services: {
        send(operationId, controls = {}) {
          const id = String(++sequence);
          return new Promise((resolve, reject) => {
            requests.set(id, { resolve, reject });
            process.send({ kind: "send", id, operationId, controls });
          });
        },
      },
    });
    process.send({ kind: "result", ok: true });
  } catch {
    process.send({ kind: "result", ok: false });
  }
});
process.on("disconnect", () => {
  controller?.abort();
  process.exit(1);
});
