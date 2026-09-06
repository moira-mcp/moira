#!/usr/bin/env node
/**
 * Entry point of the extension runner service.
 *
 * The repository ships TypeScript sources and runs them through tsx, exactly as the other
 * long-running processes do, so this wrapper only starts the server module under that loader.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "main.ts");
const tsx = path.join(here, "..", "..", "..", "node_modules", ".bin", "tsx");

const child = spawn(tsx, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
