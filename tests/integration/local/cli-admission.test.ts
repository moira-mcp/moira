import { expect, test } from "@jest/globals";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../../../packages/local/src/process.js";

test.each([
  { command: "create", target: "owner/project", request: undefined },
  { command: "start", target: "00000000-0000-4000-8000-000000000001", request: undefined },
  { command: "request", target: undefined, request: { action: "create" } },
  { command: "request", target: undefined, request: { action: "start" } },
  { command: "request", target: undefined, request: { action: "snapshot" } },
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
