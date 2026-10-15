import { expect, test } from "@jest/globals";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../../../packages/local/src/process.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { localFixture } from "./fixtures.js";

test.each([
  { command: "request", target: undefined, request: { action: "create" } },
  { command: "request", target: undefined, request: { action: "start" } },
  { command: "request", target: undefined, request: { action: "snapshot" } },
  { command: "git-token", target: "owner/project", request: { token: "ignored-legacy-token" } },
])(
  "packaged host CLI refuses unsupported $command/$request before creating private state",
  async ({ command, target, request }) => {
    const root = await mkdtemp(join(tmpdir(), "moira-cli-admission-"));
    try {
      const result = await runProcess({
        binary: process.execPath,
        argv: [
          resolve("packages/local/dist/cli.js"),
          command,
          ...(target ? [target] : []),
          "--state",
          join(root, "state"),
        ],
        cwd: root,
        env: {},
        stdin: Buffer.from(JSON.stringify(request ?? {})),
        timeoutMs: 15_000,
        maxBytes: 8192,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.toString())).toMatchObject({
        error: { code: "LOCAL_COMMAND_UNSUPPORTED" },
      });
      expect(result.stdout.length).toBe(0);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["create", "start"] as const)(
  "packaged supported %s refuses before dispatch when the initialized owner has no paired controller",
  async (command) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "moira-cli-owner-")));
    try {
      const state = await PrivateState.open(root);
      const local = await localFixture(state);
      const names = (await readdir(root)).sort();
      const original = await Promise.all(names.map((name) => readFile(join(root, name))));
      const result = await runProcess({
        binary: process.execPath,
        argv: [
          resolve("packages/local/dist/cli.js"),
          command,
          command === "create" ? local.policy.repositories[0].fullName : local.space.id,
          ...(command === "create" ? ["--ref", "main"] : []),
          "--state",
          root,
        ],
        cwd: root,
        env: {},
        timeoutMs: 15_000,
        maxBytes: 8192,
      });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.toString())).toMatchObject({
        error: { code: "LOCAL_NOT_ENROLLED" },
      });
      expect(result.stdout.length).toBe(0);
      expect((await readdir(root)).sort()).toEqual(names);
      expect(await Promise.all(names.map((name) => readFile(join(root, name))))).toEqual(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
