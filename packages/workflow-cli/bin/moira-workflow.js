#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "..", "src", "workflow-tool.ts");

// Find tsx in node_modules
const tsxPath = join(__dirname, "..", "..", "..", "node_modules", ".bin", "tsx");

const args = process.argv.slice(2);
const child = spawn(tsxPath, [scriptPath, ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
