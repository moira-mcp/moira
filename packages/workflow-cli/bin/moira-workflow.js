#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "..", "src", "workflow-tool.ts");

const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve("tsx");

const args = process.argv.slice(2);
const child = spawn(process.execPath, ["--import", tsxLoaderPath, scriptPath, ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("error", (error) => {
  console.error(`Failed to start moira-workflow: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
