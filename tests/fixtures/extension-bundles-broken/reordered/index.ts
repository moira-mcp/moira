import { defineExtension, defineNode } from "@mcp-moira/extension-sdk";

export default defineExtension({
  nodes: [
    defineNode({
      type: "reordered.go",
      outputSchema: { required: ["observed"], type: "object" },
      configSchema: { additionalProperties: false, type: "object" },
      async handler() {
        return { observed: "same schema" };
      },
    }),
  ],
});
