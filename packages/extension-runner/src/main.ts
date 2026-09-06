/**
 * Process entry point of the runner service.
 *
 * Configuration is intentionally small and explicit: where bundles live and where to listen. The
 * service never reads Moira's database or secrets, so nothing else is needed here.
 */

import { startExtensionRunner } from "./server.js";

const extensionsDir = process.env.MOIRA_EXTENSIONS_DIR ?? "/app/extensions";
const port = Number(process.env.MOIRA_EXTENSION_RUNNER_PORT ?? 9110);

const runner = await startExtensionRunner({
  extensionsDir,
  port,
  log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
});

console.log(
  JSON.stringify({
    message: "extension runner listening",
    port: runner.port,
    extensionsDir,
    loaded: runner.scan.bundles.map((bundle) => bundle.manifest.name),
    rejected: runner.scan.rejected,
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void runner.close().then(() => process.exit(0));
  });
}
