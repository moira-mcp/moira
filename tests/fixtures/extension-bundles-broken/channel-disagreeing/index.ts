import { defineChannel, defineExtension } from "@mcp-moira/extension-sdk";

const notifications = defineChannel({
  id: "channel-disagreeing.notifications",
  configurationSchema: { type: "object", additionalProperties: false },
  async handler() {},
});

export default defineExtension({ communicationChannels: [notifications] });
