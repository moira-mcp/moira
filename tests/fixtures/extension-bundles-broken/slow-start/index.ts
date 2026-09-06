import { defineExtension, defineNode } from "@mcp-moira/extension-sdk";
import * as fs from "fs";
import { fileURLToPath } from "url";

fs.appendFileSync(fileURLToPath(new URL(".startup-observed", import.meta.url)), "started\n");
await new Promise((resolve) => setTimeout(resolve, 400));

export default defineExtension({
  nodes: [
    defineNode({
      type: "slow-start.go",
      async handler() {
        return { observed: "started" };
      },
    }),
  ],
});
