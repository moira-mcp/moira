import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess } from "../../../packages/local/src/process.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moira-local-process-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = () => ({
  binary: process.execPath,
  cwd: root,
  env: { PATH: "/usr/bin:/bin", ONLY_ALLOWED: "yes" },
  timeoutMs: 3000,
  maxBytes: 1024,
});

describe("bounded local subprocess boundary", () => {
  test("arguments are literal, stdin is separate and the host environment is not inherited", async () => {
    const result = await runProcess({
      ...request(),
      argv: [
        "-e",
        "process.stdout.write(JSON.stringify({arg:process.argv[1],env:process.env,input:require('node:fs').readFileSync(0,'utf8')}))",
        "$(echo unexpected); & literal",
      ],
      stdin: Buffer.from("payload"),
    });
    expect(result.exitCode).toBe(0);
    const value = JSON.parse(result.stdout.toString());
    expect(value.arg).toBe("$(echo unexpected); & literal");
    expect(value.input).toBe("payload");
    expect(value.env).toEqual({ PATH: "/usr/bin:/bin", ONLY_ALLOWED: "yes" });
  });
  test("output and lifetime are bounded independently of child cooperation", async () => {
    await expect(
      runProcess({
        ...request(),
        argv: ["-e", "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)"],
      }),
    ).rejects.toMatchObject({ code: "LOCAL_OUTPUT_LIMIT" });
    await expect(
      runProcess({ ...request(), timeoutMs: 100, argv: ["-e", "setInterval(()=>{},1000)"] }),
    ).rejects.toMatchObject({ code: "LOCAL_COMMAND_TIMEOUT" });
  });
  test("a local abort kills the runtime command instead of waiting for its normal deadline", async () => {
    const controller = new AbortController();
    const work = runProcess({
      ...request(),
      signal: controller.signal,
      argv: ["-e", "setInterval(()=>{},1000)"],
    });
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "LOCAL_CANCELLED" });
  });
});
