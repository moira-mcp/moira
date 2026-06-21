#!/usr/bin/env node
/**
 * Workflow Test Runner
 * Wrapper script for running Jest workflow tests with proper output handling
 *
 * Usage:
 *   npm run test:workflow                         # Run all tests
 *   npm run test:workflow test-file.test.ts       # Run specific test
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../..");

// Clean and prepare artifacts directory
import { mkdirSync, existsSync, rmSync } from "fs";
const artifactsDir = join(projectRoot, "test-results/artifacts");
const categoryArtifacts = [
  join(artifactsDir, "workflow.json"),
  join(artifactsDir, "workflow.log"),
  join(artifactsDir, "failures/workflow"),
];

// Remove old artifacts for this category
categoryArtifacts.forEach((path) => {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
});

// Ensure artifacts directory exists
if (!existsSync(artifactsDir)) {
  mkdirSync(artifactsDir, { recursive: true });
}

// Parse arguments
const args = process.argv.slice(2);
let testFile = args[0]; // optional test file

// If test file provided, resolve to correct path
if (testFile && !testFile.startsWith("tests/")) {
  // Just filename provided, search in tests/workflow/ recursively
  const { globSync } = await import("glob");
  const matches = globSync(`tests/workflow/**/${testFile}`, { cwd: projectRoot });
  if (matches.length === 1) {
    testFile = matches[0];
    console.log(`🔍 Resolved test file to: ${testFile}`);
  } else if (matches.length > 1) {
    console.log(`⚠️ Multiple matches found for ${testFile}:`);
    matches.forEach((m) => console.log(`   - ${m}`));
    testFile = matches[0];
    console.log(`🔍 Using first match: ${testFile}`);
  } else {
    // No match found, use as-is (Jest will handle the error)
    console.log(`⚠️ No match found for ${testFile} in tests/workflow/`);
  }
}

// Build jest command
const jestArgs = [
  "jest",
  "--config=tests/config/jest.workflow.config.js",
  "--json",
  "--outputFile=test-results/artifacts/workflow.json",
];

if (testFile) {
  jestArgs.push(testFile);
}

console.log(`🧪 Running Workflow tests: ${testFile || "all tests"}`);
console.log(`🔍 Command: npx ${jestArgs.join(" ")}`);
console.log(`📂 Working directory: ${projectRoot}`);

// Spawn jest process
const jest = spawn("npx", jestArgs, {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_ENV: "test",
    NODE_OPTIONS: "--experimental-vm-modules",
  },
  stdio: ["inherit", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

jest.stdout.on("data", (data) => {
  stdout += data.toString();
});

jest.stderr.on("data", (data) => {
  stderr += data.toString();
});

jest.on("close", async (code) => {
  // Write combined output to log file
  const fs = await import("fs");
  const logPath = join(projectRoot, "test-results/artifacts/workflow.log");
  const combinedOutput = stdout + "\n" + stderr;

  fs.mkdirSync(join(projectRoot, "test-results/artifacts"), { recursive: true });
  fs.writeFileSync(logPath, combinedOutput);

  // Parse results and create failure reports
  const parserScript = join(__dirname, "parse-jest-results.js");
  const parserArgs = [
    parserScript,
    "test-results/artifacts/workflow.json",
    "test-results/artifacts/workflow.log",
    "test-results/artifacts/failures/workflow",
  ];

  const parser = spawn("node", parserArgs, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  parser.on("close", (parserCode) => {
    process.exit(code || parserCode);
  });
});

jest.on("error", (err) => {
  console.error("Failed to start Jest:", err);
  process.exit(1);
});
