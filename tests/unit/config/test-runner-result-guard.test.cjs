"use strict";

const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { describe, expect, test } = require("@jest/globals");

const runnerPackage = resolve("node_modules/testfold");
const runnerMain = JSON.parse(readFileSync(join(runnerPackage, "package.json"), "utf8")).main;
const runnerUrl = pathToFileURL(join(runnerPackage, runnerMain)).href;
const configUrl = pathToFileURL(resolve("test-runner.config.mjs")).href;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runFixture({ passed = 1, failed = 0, skipped = 0, errors = [], exit = 0, log }) {
  const workspace = await mkdtemp(join(tmpdir(), "moira-runner-guard-"));
  try {
    const artifacts = join(workspace, "artifacts");
    const resultFile = join(artifacts, "fixture.json");
    const framework = join(workspace, "framework.mjs");
    const driver = join(workspace, "runner.mjs");
    const stats = { expected: passed, unexpected: failed, skipped, flaky: 0, duration: 1 };
    const tests = [
      ...Array.from({ length: passed }, () => ({ status: "passed" })),
      ...Array.from({ length: failed }, () => ({
        status: "failed",
        error: { message: "fixture assertion failed" },
      })),
      ...Array.from({ length: skipped }, () => ({ status: "skipped" })),
    ];
    const report = {
      errors,
      stats,
      suites: [
        {
          title: "fixture",
          file: "fixture.spec.ts",
          specs: tests.map((result, index) => ({
            title: `case ${index}`,
            ok: result.status !== "failed",
            tests: [{ results: [{ ...result, duration: 1 }] }],
          })),
        },
      ],
    };
    await writeFile(
      framework,
      `import { mkdir, writeFile } from "node:fs/promises";
await mkdir(${JSON.stringify(artifacts)}, { recursive: true });
await writeFile(${JSON.stringify(resultFile)}, ${JSON.stringify(JSON.stringify(report))});
console.log("Exit Code: 1");
process.exitCode = ${exit};
`,
    );
    await writeFile(
      driver,
      `import { TestRunner } from ${JSON.stringify(runnerUrl)};
import sourceConfig from ${JSON.stringify(configUrl)};
import { writeFile, unlink } from "node:fs/promises";
const logMutation = ${JSON.stringify(log ?? null)};
const runner = new TestRunner({
  ...sourceConfig,
  artifactsDir: ${JSON.stringify(artifacts)},
  testsDir: ${JSON.stringify(workspace)},
  parallel: false,
  reporters: ["json"],
  suites: [{ name: "fixture", type: "playwright", resultFile: "fixture.json",
    command: ${JSON.stringify(`${shellQuote(process.execPath)} ${shellQuote(framework)}`)} }],
  hooks: {
    afterSuite: async (suite, result) => {
      if (logMutation === "missing") await unlink(result.logFile);
      else if (logMutation !== null) await writeFile(result.logFile, logMutation);
      return sourceConfig.hooks?.afterSuite?.(suite, result);
    }
  }
}, ${JSON.stringify(workspace)});
const result = await runner.run(["fixture"]);
await writeFile(${JSON.stringify(join(workspace, "outcome.json"))}, JSON.stringify(result));
process.exitCode = result.exitCode;
`,
    );
    const child = spawnSync(process.execPath, [driver], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (child.error) throw child.error;
    const summary = JSON.parse(await readFile(join(workspace, "outcome.json"), "utf8"));
    return { status: child.status, summary, stderr: child.stderr };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("root test runner rejects unsupported success", () => {
  test("one executed passing test exits successfully despite an exit-code-looking stdout line", async () => {
    const { status, summary } = await runFixture({});
    expect(status).toBe(0);
    expect(summary.success).toBe(true);
    expect(summary.totals).toMatchObject({ passed: 1, failed: 0, skipped: 0 });
  });

  test.each([
    [
      "global setup failure before any tests",
      { passed: 0, exit: 1, errors: [{ message: "setup failed" }] },
      "setup failed",
    ],
    ["nonzero exit after passing tests", { exit: 1 }, "exited with code 1"],
    [
      "global teardown error despite exit zero",
      { errors: [{ message: "teardown failed" }] },
      "teardown failed",
    ],
    ["empty successful report", { passed: 0 }, "no executed passing tests"],
    ["skipped-only report", { passed: 0, skipped: 3 }, "no executed passing tests"],
    ["missing executor log", { log: "missing" }, "log is unavailable"],
    [
      "exit code only in stdout",
      { log: "=== STDOUT ===\nExit Code: 0\n" },
      "no valid exit-code header",
    ],
    [
      "unparseable executor exit",
      { log: "Command: fixture\nExit Code: null\nDuration: 1ms\n" },
      "no valid exit-code header",
    ],
  ])(
    "%s produces an infrastructure failure through the real runner",
    async (_name, fixture, message) => {
      const { status, summary } = await runFixture(fixture);
      expect(status).toBe(2);
      expect(summary.success).toBe(false);
      expect(summary.totals.failed).toBe(1);
      expect(summary.suites[0].errorCategory).toBe("infra_error");
      expect(summary.suites[0].failures[0].error).toContain(message);
    },
  );

  test("a real failed assertion retains its parsed failure and test-failure exit", async () => {
    const { status, summary } = await runFixture({ passed: 0, failed: 1, exit: 1 });
    expect(status).toBe(1);
    expect(summary.success).toBe(false);
    expect(summary.totals.failed).toBe(1);
    expect(summary.suites[0].errorCategory).toBe("test_failure");
    expect(summary.suites[0].failures).toHaveLength(1);
    expect(summary.suites[0].failures[0].error).toBe("fixture assertion failed");
  });
});
