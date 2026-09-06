/**
 * A bundle whose code restates a schema differently from its manifest. Both declarations look
 * reasonable on their own; only comparing them shows that the author is reading one and the system
 * enforcing the other.
 */

import { defineExtension, defineNode } from "@mcp-moira/extension-sdk";

const go = defineNode({
  type: "disagreeing.go",
  // The manifest requires `count` and types it as a number; this says something else entirely.
  configSchema: { type: "object", properties: { count: { type: "string" } } },
  async handler() {
    return { observed: "went" };
  },
});

export default defineExtension({ nodes: [go] });
