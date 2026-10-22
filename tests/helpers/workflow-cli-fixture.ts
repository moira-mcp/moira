import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_TOOL = fileURLToPath(
  new URL("../../packages/workflow-cli/bin/moira-workflow.js", import.meta.url),
);

/** A CLI caller whose inputs, auxiliary files and backups share one disposable directory. */
export function createWorkflowCliFixture(prefix = "workflow-cli-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory,
    path: (name: string) => path.join(directory, name),
    run: (args: string[], env: NodeJS.ProcessEnv = process.env): string =>
      execFileSync(process.execPath, [WORKFLOW_TOOL, ...args], {
        cwd: directory,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
