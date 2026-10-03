import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { localFixture } from "./fixtures.js";

let root: string;
let state: PrivateState;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moira-local-runtime-"));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const name = `moira-${"a".repeat(32)}`;
const result = (stdout: unknown = "") => ({
  exitCode: 0,
  stdout: Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)),
  stderr: Buffer.alloc(0),
});

describe("Docker Sandboxes lifecycle boundary", () => {
  test("creation uses only the fixed mountless shell profile and locally bounded resources", async () => {
    const fixture = await localFixture(state);
    const calls: string[][] = [];
    let listed = 0;
    const runtime = new SbxRuntime(fixture.policy, async (request) => {
      calls.push([...request.argv]);
      if (request.argv[0] === "ls") {
        listed++;
        return result({
          sandboxes:
            listed === 1
              ? []
              : [
                  {
                    id: "runtime-1",
                    name,
                    agent: "shell",
                    status: "created",
                    workspaces: [],
                    ports: [],
                  },
                ],
        });
      }
      return result();
    });
    runtime.verifySettings = async () => undefined;

    await expect(runtime.create(name)).resolves.toEqual({ name, runtimeId: "runtime-1" });
    const create = calls.find((argv) => argv[0] === "create");
    expect(create).toEqual([
      "create",
      "--name",
      name,
      "--cpus",
      String(fixture.policy.runtime.cpuCores),
      "--memory",
      `${fixture.policy.runtime.memoryBytes / 1024 ** 2}m`,
      "--skills",
      "off",
      "--template",
      fixture.policy.runtime.template,
      "--deny-network",
      "**",
      "shell",
    ]);
    expect(create).not.toContain("--workspace");
    expect(create).not.toContain("--mount");
  });

  test("unsafe host-integration settings are refused instead of being reported ready", async () => {
    const fixture = await localFixture(state);
    const runtime = new SbxRuntime(fixture.policy, async (request) => {
      if (request.argv[0] === "settings")
        return result([{ key: "clipboard.imagePaste", value: true }]);
      return result();
    });
    runtime.validateExecutable = async () => undefined;
    await expect(runtime.verifySettings()).rejects.toMatchObject({ code: "LOCAL_RUNTIME_UNSAFE" });
  });

  test("identity mismatch fails closed before stop or removal can target the observed sandbox", async () => {
    const fixture = await localFixture(state);
    const calls: string[][] = [];
    const runtime = new SbxRuntime(fixture.policy, async (request) => {
      calls.push([...request.argv]);
      if (request.argv[0] === "ls")
        return result({
          sandboxes: [
            {
              id: "attacker-id",
              name,
              agent: "shell",
              status: "running",
              workspaces: [],
              ports: [],
            },
          ],
        });
      return result();
    });

    await expect(runtime.stop({ name, runtimeId: "owned-id" })).rejects.toMatchObject({
      code: "LOCAL_IDENTITY_CHANGED",
    });
    await expect(runtime.remove({ name, runtimeId: "owned-id" })).rejects.toMatchObject({
      code: "LOCAL_IDENTITY_CHANGED",
    });
    expect(calls.every((argv) => argv[0] === "ls")).toBe(true);
  });
});
