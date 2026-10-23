import { bootstrap } from "./guest-bootstrap.js";
import process from "node:process";
import { Buffer } from "node:buffer";
import { workspaceSetupFailureSchema } from "../../shared/src/codespaces/local-protocol.ts";
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
} catch (error) {
  const observed = workspaceSetupFailureSchema.safeParse(error?.setupReason);
  // A completed fixed program can report a logical setup refusal without
  // confusing it with an unconfirmed native exec or leaking Git diagnostics.
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      reason: observed.success ? observed.data : "configuration_failed",
    })}\n`,
  );
}
