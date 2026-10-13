import { bootstrap } from "../../local/src/guest-bootstrap.js";
import process from "node:process";
import { Buffer } from "node:buffer";
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("Invalid fixed bootstrap metadata");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(`${JSON.stringify({ ok: true, result: await bootstrap(input) })}\n`);
} catch {
  process.stderr.write("Workspace bootstrap could not be confirmed.\n");
  process.exitCode = 1;
}
