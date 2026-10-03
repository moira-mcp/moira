import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runRequest } from "../../web-backend/src/services/github-codespaces-remote-supervisor.mjs";
import { bootstrap, type GuestBootstrap } from "./guest-bootstrap.js";

/** This entry runs only inside a sandbox. Its stdin is data, never JavaScript source. */
let size = 0;
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  size += bytes.length;
  if (size > 8 * 1024 * 1024) throw new Error("Guest input exceeds its bound");
  chunks.push(bytes);
}
try {
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof input !== "object" || input === null || !("kind" in input) || !("request" in input)) {
    throw new Error("Invalid guest request");
  }
  if (input.kind === "operation") {
    const environment = JSON.parse(
      await readFile(join(homedir(), ".local/share/moira-local/environment.json"), "utf8"),
    );
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      if (typeof environment[key] !== "string" || environment[key].length > 512)
        throw new Error("Invalid guest network configuration");
      // This process is the guest boundary itself: the validated proxy variables must reach the imported supervisor and its child processes.
      // eslint-disable-next-line no-restricted-syntax
      process.env[key] = environment[key];
    }
  }
  const result =
    input.kind === "bootstrap"
      ? await bootstrap(input.request as GuestBootstrap)
      : input.kind === "operation"
        ? await runRequest(input.request)
        : (() => {
            throw new Error("Unknown guest request kind");
          })();
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: "Guest operation was refused" }));
  process.exitCode = 1;
}
