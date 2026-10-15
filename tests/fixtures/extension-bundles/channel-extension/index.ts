import { defineChannel, defineExtension } from "@mcp-moira/extension-sdk";
import { spawn } from "node:child_process";
import { once } from "node:events";

const notifications = defineChannel({
  id: "channel-probe.notifications",
  async handler({ message, settings, services, signal }) {
    if (
      Object.keys(settings).some(
        (key) => key !== "channel-probe.enabled" && key !== "channel-probe.destination",
      )
    ) {
      throw new Error("undeclared channel configuration crossed the runner boundary");
    }
    if (message.text === "forbidden-network") {
      await services.fetch("https://blocked.example/messages");
      return;
    }
    if (message.text === "forbidden-secret") {
      await services.secret("channel-probe.unrelated");
      return;
    }
    if (message.text === "hang") {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return;
    }
    const token = await services.secret("channel-probe.token");
    if (settings["channel-probe.destination"] !== "configured" || token !== "channel-secret") {
      throw new Error("channel configuration did not cross its declared boundary");
    }
    if (message.text !== "portable text") {
      throw new Error("the portable message did not reach the channel");
    }
  },
  async binaryHandler({ message, settings, services }) {
    if (message.text === "descendant") {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "require('net').createServer(socket=>socket.end('owned')).listen(0,'127.0.0.1',function(){process.send(this.address().port)})",
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const [port] = await once(child, "message");
      await services.send("upload", { caption: String(port) });
      return;
    }
    if ("secret" in services || "fetch" in services || "channel-probe.token" in settings)
      throw new Error("Cloud authority crossed into owner context");
    const reader = message.attachment.open().getReader();
    let size = 0;
    let completed = false;
    try {
      if (message.text === "incremental") {
        const first = await reader.read();
        size += first.value?.byteLength ?? 0;
        await services.send("upload", { caption: "first chunk received" });
      }
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          completed = true;
          break;
        }
        size += next.value.byteLength;
      }
    } finally {
      try {
        if (!completed) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    if (size !== message.attachment.size) throw new Error("Source was truncated");
    if (message.text !== "incremental") await services.send("upload", { caption: message.text });
  },
});

export default defineExtension({ communicationChannels: [notifications] });
