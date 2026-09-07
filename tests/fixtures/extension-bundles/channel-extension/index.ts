import { defineChannel, defineExtension } from "@mcp-moira/extension-sdk";

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
    if (
      message.attachment?.kind !== "document" ||
      message.attachment.filename !== "report.txt" ||
      message.attachment.mimeType !== "text/plain" ||
      new TextDecoder().decode(message.attachment.bytes) !== "report"
    ) {
      throw new Error("the portable attachment did not reach the channel");
    }
  },
});

export default defineExtension({ communicationChannels: [notifications] });
