/**
 * Minimal extension bundle used to exercise the runner protocol and its isolation guarantees.
 *
 * Its single node performs whatever behaviour its configuration names, so one bundle can produce
 * every situation the runner must survive: a normal result, a thrown error, a hang past the
 * deadline, a result that violates the declared schema, and an outright process crash.
 */

import { defineExtension, defineNode } from "@mcp-moira/extension-sdk";

const behave = defineNode({
  type: "probe.behave",
  // Schemas live in the manifest; restating them here would be checked against it.
  async handler({ config, signal, services }) {
    const behaviour = String(config.behaviour ?? "succeed");

    switch (behaviour) {
      case "throw":
        throw new Error("probe failed on purpose");

      case "crash":
        // Not an exception: the process disappears, which is the case a try/catch cannot cover.
        process.exit(7);
        break;

      case "hang":
        return await new Promise((resolve) => {
          // Observes cancellation instead of ignoring it, so the caller can tell whether the
          // deadline actually reached the handler.
          signal.addEventListener("abort", () => {
            services.log("probe observed cancellation");
            resolve({ observed: "cancelled", cancelled: true });
          });
        });

      case "bad-output":
        return { unexpected: "no messageId here" } as never;

      case "network": {
        const host = String(config.host ?? "allowed.example");
        try {
          await services.fetch(`https://${host}/probe`);
          return { observed: "network-allowed" };
        } catch (error) {
          return { observed: `network-refused: ${(error as Error).message}` };
        }
      }

      case "secret": {
        try {
          const value = await services.secret(String(config.alias ?? "probe.token"));
          return { observed: `secret:${value ?? "unset"}` };
        } catch (error) {
          return { observed: `secret-refused: ${(error as Error).message}` };
        }
      }

      case "artifact":
        try {
          await services.writeArtifact("probe.txt", "content");
          return { observed: "artifact-allowed" };
        } catch (error) {
          return { observed: `artifact-refused: ${(error as Error).message}` };
        }

      default:
        return { observed: "succeeded" };
    }

    return { observed: "unreachable" };
  },
});

export default defineExtension({ nodes: [behave] });
