/**
 * The contributor container script and its optional extra workflow catalogs
 * (`EXTRA_WORKFLOWS_DIRS`): an entry that does not exist is reported and skipped, and the run goes
 * on with the entries that do. Driven through the script's own `--dry-run`, which prints the Docker
 * commands instead of running them.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

const script = path.resolve("scripts/docker-build-and-run.sh");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-extra-workflows-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function dryRun(extraWorkflowsDirs: string, bindAddress?: string) {
  const envFile = path.join(dir, "test.env");
  fs.writeFileSync(
    envFile,
    [
      "DOCKER_IMAGE_NAME=moira-dry-run-probe",
      "DOCKER_CONTAINER_NAME=moira-dry-run-probe",
      "DOCKER_PORT=39999",
      ...(bindAddress ? [`DOCKER_BIND_ADDRESS=${bindAddress}`] : []),
      `EXTRA_WORKFLOWS_DIRS=${extraWorkflowsDirs}`,
      "",
    ].join("\n"),
  );
  const env = { ...process.env };
  delete env.EXTRA_WORKFLOWS_DIRS;
  delete env.DOCKER_BIND_ADDRESS;
  return spawnSync("bash", [script, "--local", "--dry-run", "--env-file", envFile], {
    cwd: path.resolve("."),
    env,
    encoding: "utf8",
  });
}

describe("docker-build-and-run.sh extra workflow catalogs", () => {
  test("local fixtures bind loopback unless the operator explicitly selects another address", () => {
    const local = dryRun("");
    expect(local.status).toBe(0);
    expect(local.stdout).toContain("-p 127.0.0.1:39999:80");

    const selected = dryRun("", "192.0.2.1");
    expect(selected.status).toBe(0);
    expect(selected.stdout).toContain("-p 192.0.2.1:39999:80");
  });

  test("a missing catalog directory is reported and skipped while an existing one is still mounted", () => {
    const missing = path.join(dir, "no-such-catalog");
    const existing = fs.mkdtempSync(path.join(dir, "catalog-"));

    const run = dryRun(`${missing}:${existing}`);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`EXTRA_WORKFLOWS_DIRS entry not found, skipping: ${missing}`);
    // The run went on past the missing entry to the Docker command it would start.
    expect(run.stdout).toContain(`-v ${existing}:/app/extra-workflows-0`);
    expect(run.stdout).toContain("WORKFLOWS_DIRS=./workflows/production:./extra-workflows-0");
    expect(run.stdout).not.toContain(`${missing}:/app/extra-workflows`);
  });

  test("with only missing catalog directories the run goes on with the bundled catalog alone", () => {
    const run = dryRun(path.join(dir, "gone"));

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("EXTRA_WORKFLOWS_DIRS entry not found, skipping:");
    expect(run.stdout).toContain("[DRY-RUN] docker run");
    expect(run.stdout).not.toContain("WORKFLOWS_DIRS=./workflows/production");
  });
});
