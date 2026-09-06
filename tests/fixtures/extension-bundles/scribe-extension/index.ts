/**
 * Second test bundle. It exists for the observations the single-bundle case cannot make: that a
 * granted capability produces a visible result (the artifact reaches Moira with the call result),
 * that a call to a *different* extension succeeds after the first one has failed, and that an
 * oversized artifact is refused by the service rather than carried.
 */

import { defineExtension, defineNode } from "@mcp-moira/extension-sdk";

const write = defineNode({
  type: "scribe.write",
  async handler({ config, services }) {
    if (config.malformedArtifact === true) {
      await services.writeArtifact("malformed.txt", 1 as never);
      return { observed: "unreachable" };
    }
    const size = Number(config.size ?? 0);
    const count = Number(config.count ?? 1);
    const nested = config.nested as { content?: string } | undefined;
    const content = size > 0 ? "x".repeat(size) : String(nested?.content ?? config.content ?? "hi");

    for (let index = 0; index < count; index += 1) {
      const name =
        count > 1 ? `${index}-${config.name ?? "note.txt"}` : String(config.name ?? "note.txt");
      await services.writeArtifact(name, content);
    }
    return { observed: "written" };
  },
});

export default defineExtension({ nodes: [write] });
