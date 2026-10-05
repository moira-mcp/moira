import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, realpath, mkdir, symlink, copyFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import {
  GUEST_WORKER_COMMAND,
  VERIFIED_GUEST_FAILURE_EXIT,
} from "../../../packages/local/src/assets.js";
import { localFixture } from "./fixtures.js";

let root: string;
let state: PrivateState;
let aliases: string[];
beforeEach(async () => {
  aliases = [];
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-runtime-")));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  for (const alias of aliases) await rm(alias, { force: true });
  await rm(root, { recursive: true, force: true });
});

const name = `moira-${"a".repeat(32)}`;
const result = (stdout: unknown = "") => ({
  exitCode: 0,
  stdout: Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)),
  stderr: Buffer.alloc(0),
});
// These fixtures isolate the SDK protocol; the real credential boundary has its own file.
const simulatedRuntime = (...args: ConstructorParameters<typeof SbxRuntime>) => {
  const runtime = new SbxRuntime(...args);
  runtime.prepareCredentials = async () => undefined;
  return runtime;
};
const baseline = {
  id: "default-deny-all",
  scope: "global",
  applies_to: "all",
  resource_type: "network",
  decision: "deny",
  resources: ["**"],
  status: "active",
  actions: ["net:connect:udp"],
};
// The pinned SDK exposes this virtual, noneditable rule only while no persistent rule exists.
const virtualDefault = {
  ...baseline,
  actions: ["net:connect:tcp", "net:connect:udp"],
  origin: "local",
  editable: false,
};
const safeSettings = {
  "feature.network-user-prompts": { enabled: false, variant: "", variantPayload: "" },
  "env.rememberHostCommands": false,
  "ssh.autoCreate": false,
  "ssh.workspaceRoot": "",
  "clipboard.imagePaste": false,
  "ssh.agentForwardingEnabled": false,
  "ssh.agentSocketPath": "",
  "skills.defaultMode": "off",
  "diagnostics.autoUpload": "no",
  "proxy.integratedAuth": false,
  "proxy.sandbox": "direct",
  "no_proxy.sandbox": "",
};

async function ownedSocket(runtime: SbxRuntime): Promise<string> {
  const directory = join(runtime.home, "sandboxd");
  const alias = join(
    "/tmp",
    `sboxd-${process.getuid?.() ?? 0}-sandboxes-${runtime.environment.DOCKER_SANDBOXES_APP_NAME}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await symlink(directory, alias);
  aliases.push(alias);
  return join(alias, "sandboxd.sock");
}

async function startupRuntime(
  replaceIdentity = false,
  restoreGateway = false,
  gatewayPresent = true,
) {
  const fixture = await localFixture(state);
  let started = false;
  let socket = "";
  const runtime = simulatedRuntime(fixture.policy, async (request) => {
    if (request.binary === process.execPath) {
      started = true;
      return result();
    }
    if (request.argv[0] === "daemon") return result({ status: "running", socket });
    if (request.argv[0] === "ls")
      return result({
        sandboxes: [
          {
            id: started && replaceIdentity ? "replacement" : "runtime-1",
            name,
            agent: "shell",
            status: started ? "running" : "stopped",
          },
        ],
      });
    return result({
      name,
      agent: "shell",
      image: fixture.policy.runtime.template,
      image_digest: fixture.policy.runtime.template.split("@")[1],
      cpus: fixture.policy.runtime.cpuCores,
      memory: `${fixture.policy.runtime.memoryBytes / 1024 ** 2}m`,
      network: name,
      network_policy: { scope: "sandbox" },
      runtime_mounts: [],
      kits: [],
      daemon_version: "v0.46.0",
      mcp_gateway: started ? restoreGateway : gatewayPresent,
    });
  });
  socket = await ownedSocket(runtime);
  return runtime;
}

describe("Docker Sandboxes lifecycle boundary", () => {
  test.each([false, true])(
    "broker-only admission preserves inherited global UDP denial (broker grant refused: %s)",
    async (grantRefused) => {
      const fixture = await localFixture(state);
      const globalDeny = {
        ...baseline,
        id: "0d642cb0-1111-4111-8111-111111111111",
        origin: "local",
        editable: true,
      };
      const rules: Record<string, unknown>[] = [structuredClone(globalDeny)];
      let socket = "";
      let removals = 0;
      const decisions: Record<string, boolean> = {};
      const runtime = simulatedRuntime(fixture.policy, async (request) => {
        const argv = request.argv;
        if (argv[0] === "daemon") return result({ status: "running", socket });
        if (argv[0] === "settings" && argv[1] === "get")
          return result({ value: safeSettings["feature.network-user-prompts"] });
        if (argv[0] === "settings")
          return result(
            Object.entries(safeSettings)
              .filter(([key]) => key !== "feature.network-user-prompts")
              .map(([key, value]) => ({ key, value })),
          );
        if (argv[0] === "policy" && argv[1] === "rm") {
          removals++;
          return {
            ...result(),
            exitCode: 1,
            stderr: Buffer.from(
              '"**" is covered by a rule in the global policy, not in this sandbox.',
            ),
          };
        }
        if (argv[0] === "policy" && argv[1] === "allow") {
          if (grantRefused)
            return { ...result(), exitCode: 1, stderr: Buffer.from("Broker grant was refused.") };
          rules.push({
            ...baseline,
            id: "broker-grant",
            scope: "sandbox",
            applies_to: name,
            decision: "allow",
            actions: ["net:connect:tcp"],
            resources: ["localhost:3072"],
          });
          return result();
        }
        if (argv[0] === "policy" && argv[1] === "check") {
          const protocol = argv[5],
            target = argv[8];
          const allowed =
            protocol === "tcp" &&
            rules.some((rule) => rule.id === "broker-grant") &&
            target === "localhost:3072";
          decisions[`${protocol}:${target}`] = allowed;
          return {
            ...result({
              type: "network",
              action: `net:connect:${protocol}`,
              target,
              context: `sandbox:${name}`,
              allowed,
              governance: { active: false },
            }),
            exitCode: allowed ? 0 : 1,
          };
        }
        return result({ rules });
      });
      socket = await ownedSocket(runtime);
      runtime.validateExecutable = async () => undefined;
      runtime.verifyBoundary = async () => undefined;
      runtime.exact = async () => ({ id: "runtime-1", name, agent: "shell", status: "running" });
      const admitted = runtime.configureBroker({ name, runtimeId: "runtime-1" }, 3072);
      if (grantRefused) {
        await expect(admitted).rejects.toMatchObject({ code: "LOCAL_RUNTIME_FAILED" });
        expect(rules).toEqual([globalDeny]);
        expect(decisions).toEqual({});
      } else {
        const observed = JSON.parse((await admitted).toString("utf8"));
        expect(observed.rules).toEqual(rules);
        expect(rules[0]).toEqual(globalDeny);
        expect(rules).toHaveLength(2);
        expect(decisions).toEqual({
          "tcp:localhost:3072": true,
          "tcp:localhost:22": false,
          "tcp:127.0.0.1:80": false,
          "tcp:[::1]:80": false,
          "tcp:10.0.0.1:443": false,
          "tcp:169.254.169.254:80": false,
          "tcp:192.168.1.1:443": false,
          "tcp:github.com:443": false,
          "tcp:example.org:443": false,
          "udp:localhost:3072": false,
          "udp:example.org:443": false,
        });
      }
      expect(removals).toBe(0);
    },
  );
  test.each([
    { label: "empty persistent rules", initialRules: [{ resource_type: "filesystem:read" }] },
    { label: "pinned readonly virtual default", initialRules: [virtualDefault] },
  ])(
    "fresh setup from $label persists UDP denial across repeat setup",
    async ({ initialRules }) => {
      const fixture = await localFixture(state);
      let socket = "";
      let rules: unknown[] = [...initialRules];
      let additions = 0;
      const settings = new Map<string, unknown>();
      const runtime = simulatedRuntime(fixture.policy, async (request) => {
        if (request.argv[0] === "daemon") return result({ status: "running", socket });
        if (request.argv[0] === "ls") return result({ sandboxes: [] });
        if (request.argv[0] === "settings") {
          if (request.argv[1] === "get") return result({ value: settings.get(request.argv[2]) });
          if (request.argv[1] === "set")
            settings.set(
              request.argv[2],
              JSON.parse(
                JSON.stringify(
                  request.argv[3].startsWith("{")
                    ? JSON.parse(request.argv[3])
                    : request.argv[3] === "false"
                      ? false
                      : request.argv[3],
                ),
              ),
            );
          return result([...settings].map(([key, value]) => ({ key, value })));
        }
        if (request.argv[0] === "policy" && request.argv[1] === "deny") {
          expect(request.argv).toEqual(["policy", "deny", "network", "--protocol", "udp", "**"]);
          rules = [
            ...rules.filter((rule) => rule !== virtualDefault),
            { ...baseline, id: "persisted-udp", origin: "local", editable: true },
          ];
          additions++;
        }
        return result({ rules });
      });
      socket = await ownedSocket(runtime);
      runtime.validateExecutable = async () => undefined;
      await runtime.initialize();
      await runtime.initialize();
      await expect(runtime.verifyGlobalNetworkPolicy()).resolves.toBeUndefined();
      expect(additions).toBe(1);
      expect(settings.get("feature.network-user-prompts")).toEqual(
        safeSettings["feature.network-user-prompts"],
      );
    },
  );

  test("virtual default does not admit initial setup with an existing stopped sandbox", async () => {
    const fixture = await localFixture(state);
    let socket = "";
    const settings = new Map<string, string>();
    let rules = [virtualDefault];
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
      if (request.argv[0] === "daemon") return result({ status: "running", socket });
      if (request.argv[0] === "ls")
        return result({
          sandboxes: [{ id: "runtime-1", name, agent: "shell", status: "stopped" }],
        });
      if (request.argv[0] === "settings" && request.argv[1] === "set")
        settings.set(request.argv[2], request.argv[3]);
      if (request.argv[0] === "policy" && request.argv[1] === "deny") rules = [];
      return result({ rules });
    });
    socket = await ownedSocket(runtime);
    runtime.validateExecutable = async () => undefined;
    await expect(runtime.initialize()).rejects.toMatchObject({ code: "LOCAL_RUNTIME_NOT_EMPTY" });
    expect([...settings]).toEqual([]);
    expect(rules).toEqual([virtualDefault]);
  });

  test("virtual default cannot admit setup through an unvalidated SDK version", async () => {
    const fixture = await localFixture(state);
    fixture.policy.runtime.binary = join(root, "owned-sdk");
    await copyFile(process.execPath, fixture.policy.runtime.binary);
    await chmod(fixture.policy.runtime.binary, 0o700);
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
      expect(request.binary).toBe(fixture.policy.runtime.binary);
      expect(request.argv).toEqual(["version"]);
      return result("sbx version: v0.47.0\n");
    });
    await expect(runtime.initialize()).rejects.toMatchObject({ code: "LOCAL_RUNTIME_VERSION" });
  });

  test.each([
    { label: "valid denied exit", change: {}, expected: true },
    { label: "denied but exit zero", change: { exitCode: 0 }, expected: false },
    { label: "denied but exit two", change: { exitCode: 2 }, expected: false },
    { label: "another target", change: { target: "different:443" }, expected: false },
    { label: "another sandbox", change: { context: "sandbox:foreign" }, expected: false },
    { label: "another protocol", change: { action: "net:connect:udp" }, expected: false },
    { label: "active governance", change: { governance: { active: true } }, expected: false },
    { label: "SDK error diagnostics", change: { stderr: "SDK error" }, expected: false },
  ])("broker checks distinguish $label from verified denial", async ({ change, expected }) => {
    const fixture = await localFixture(state);
    let socket = "";
    const grants: string[][] = [];
    const checks: string[][] = [];
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
      if (request.argv[0] === "daemon") return result({ status: "running", socket });
      if (request.argv[0] === "settings" && request.argv[1] === "get")
        return result({ value: safeSettings["feature.network-user-prompts"] });
      if (request.argv[0] === "settings")
        return result(Object.entries(safeSettings).map(([key, value]) => ({ key, value })));
      if (request.argv[1] === "check") {
        checks.push([...request.argv]);
        const protocol = request.argv[5];
        const target = request.argv[8];
        const allowed = protocol === "tcp" && target === "localhost:3072";
        const altered = protocol === "tcp" && target === "localhost:22";
        return {
          exitCode: altered && "exitCode" in change ? change.exitCode! : allowed ? 0 : 1,
          stdout: Buffer.from(
            JSON.stringify({
              type: "network",
              action: `net:connect:${protocol}`,
              context: `sandbox:${name}`,
              target,
              allowed,
              governance: { active: false },
              ...(altered ? change : {}),
            }),
          ),
          stderr: Buffer.from(altered && "stderr" in change ? change.stderr! : ""),
        };
      }
      if (request.argv[1] === "allow") grants.push([...request.argv]);
      return result({ rules: [baseline] });
    });
    socket = await ownedSocket(runtime);
    runtime.validateExecutable = async () => undefined;
    runtime.verifyBoundary = async () => undefined;
    runtime.exact = async () => ({ id: "runtime-1", name, agent: "shell", status: "running" });
    const outcome = runtime.configureBroker({ name, runtimeId: "runtime-1" }, 3072);
    if (expected) {
      await expect(outcome).resolves.toEqual(Buffer.from(JSON.stringify({ rules: [baseline] })));
      expect(checks.filter((argv) => argv[5] === "udp").map((argv) => argv[8])).toEqual([
        "localhost:3072",
        "example.org:443",
      ]);
      expect(grants).toEqual([
        ["policy", "allow", "network", "--protocol", "tcp", "--sandbox", name, "localhost:3072"],
      ]);
    } else await expect(outcome).rejects.toMatchObject({ code: "LOCAL_NETWORK_UNSAFE" });
  });

  test.each([
    true,
    false,
    undefined,
    null,
    { enabled: true, variant: "", variantPayload: "" },
    { enabled: false },
    { enabled: false, variant: "", variantPayload: "", extra: false },
  ])("network approval value %j is not the required typed disabled setting", async (value) => {
    const fixture = await localFixture(state);
    let socket = "";
    const runtime = simulatedRuntime(fixture.policy, async (request) =>
      request.argv[0] === "daemon"
        ? result({ status: "running", socket })
        : request.argv[1] === "get"
          ? result({ value })
          : result(
              Object.entries({ ...safeSettings, "feature.network-user-prompts": value }).map(
                ([key, value]) => ({ key, value }),
              ),
            ),
    );
    socket = await ownedSocket(runtime);
    runtime.validateExecutable = async () => undefined;
    await expect(runtime.verifySettings()).rejects.toMatchObject({
      code: "LOCAL_RUNTIME_UNSAFE",
    });
  });
  test("settings readiness reads a typed feature flag omitted from the ordinary settings list", async () => {
    const fixture = await localFixture(state);
    let socket = "";
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
      if (request.argv[0] === "daemon") return result({ status: "running", socket });
      if (request.argv[0] === "settings" && request.argv[1] === "get")
        return result({ value: safeSettings["feature.network-user-prompts"], source: "override" });
      return result(
        Object.entries(safeSettings)
          .filter(([key]) => key !== "feature.network-user-prompts")
          .map(([key, value]) => ({ key, value })),
      );
    });
    socket = await ownedSocket(runtime);
    runtime.validateExecutable = async () => undefined;
    await expect(runtime.verifySettings()).resolves.toBeUndefined();
  });
  test.each([
    {
      label: "duplicate flag rows",
      duplicateKey: "feature.network-user-prompts",
      key: "feature.network-user-prompts",
    },
    {
      label: "duplicate ordinary rows",
      duplicateKey: "ssh.autoCreate",
      key: "feature.network-user-prompts",
    },
    { label: "another flag envelope", duplicateKey: null, key: "foreign-feature" },
  ])(
    "settings readiness refuses $label despite a disabled feature value",
    async ({ duplicateKey, key }) => {
      const fixture = await localFixture(state);
      let socket = "";
      const entries = Object.entries(safeSettings).map(([key, value]) => ({ key, value }));
      if (duplicateKey)
        entries.push({
          key: duplicateKey,
          value: safeSettings[duplicateKey as keyof typeof safeSettings],
        });
      const runtime = simulatedRuntime(fixture.policy, async (request) => {
        if (request.argv[0] === "daemon") return result({ status: "running", socket });
        if (request.argv[1] === "get")
          return result({ key, value: safeSettings["feature.network-user-prompts"] });
        return result(entries);
      });
      socket = await ownedSocket(runtime);
      runtime.validateExecutable = async () => undefined;
      await expect(runtime.verifySettings()).rejects.toMatchObject({
        code: "LOCAL_RUNTIME_UNSAFE",
      });
    },
  );
  test("guest requests cannot choose a host or alternate guest command", async () => {
    const fixture = await localFixture(state);
    const runtime = simulatedRuntime(fixture.policy, async () => {
      throw new Error("Unsafe dispatch");
    });
    await expect(
      runtime.guest({ name, runtimeId: "runtime-1" }, ["sh", "-c", "anything"]),
    ).rejects.toMatchObject({ code: "LOCAL_GUEST_COMMAND_INVALID" });
  });
  test.each([
    { helperExit: 0, expected: "worker output" },
    { helperExit: VERIFIED_GUEST_FAILURE_EXIT, expected: "LOCAL_GUEST_FAILED" },
    { helperExit: 1, expected: "LOCAL_GUEST_SETTLEMENT_UNKNOWN" },
  ])(
    "guest outcome distinguishes verified completion from helper failure ($helperExit)",
    async ({ helperExit, expected }) => {
      const fixture = await localFixture(state);
      const runtime = simulatedRuntime(fixture.policy, async () => ({
        ...result("worker output"),
        exitCode: helperExit,
      }));
      runtime.exact = async () => ({ name, id: "runtime-1", agent: "shell", status: "running" });
      runtime.verifyBoundary = async () => undefined;
      const outcome = await runtime
        .guest({ name, runtimeId: "runtime-1" }, GUEST_WORKER_COMMAND)
        .then(
          (bytes) => bytes.toString(),
          (error: { code: string }) => error.code,
        );
      expect(outcome).toBe(expected);
    },
  );
  test("fixed container observation returns metadata without contacting SDK auto-start commands", async () => {
    const fixture = await localFixture(state);
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
      if (request.binary !== process.execPath) throw new Error("Unexpected SDK command");
      return result({ containerId: "c".repeat(64), name, state: "exited" });
    });
    await expect(runtime.containerIdentity(name)).resolves.toEqual({
      containerId: "c".repeat(64),
      name,
      state: "exited",
    });
  });
  test("fixed container observation refuses another name even with a valid CID", async () => {
    const fixture = await localFixture(state);
    const runtime = simulatedRuntime(fixture.policy, async () =>
      result({ containerId: "c".repeat(64), name: `moira-${"b".repeat(32)}`, state: "exited" }),
    );
    await expect(runtime.containerIdentity(name)).rejects.toThrow();
  });
  test.each(["created", "starting"])(
    "startup refuses unconfirmed stopped state %s before contacting the API",
    async (status) => {
      const fixture = await localFixture(state);
      const runtime = simulatedRuntime(fixture.policy, async () =>
        result({
          sandboxes: [{ id: "runtime-1", name, agent: "shell", status }],
        }),
      );
      await expect(runtime.start({ name, runtimeId: "runtime-1" })).rejects.toMatchObject({
        code: "LOCAL_START_FAILED",
      });
    },
  );
  test.each([true, false])(
    "startup with observed gateway %s confirms the same running sandbox without MCP",
    async (gatewayPresent) => {
      const runtime = await startupRuntime(false, false, gatewayPresent);
      await expect(runtime.start({ name, runtimeId: "runtime-1" })).resolves.toBeUndefined();
      await expect(runtime.exact({ name, runtimeId: "runtime-1" })).resolves.toMatchObject({
        status: "running",
      });
      await expect(
        runtime.verifyBoundary({ name, runtimeId: "runtime-1" }),
      ).resolves.toBeUndefined();
    },
  );
  test.each([
    {
      label: "identity replacement",
      replace: true,
      gateway: false,
      code: "LOCAL_IDENTITY_CHANGED",
    },
    { label: "gateway recreation", replace: false, gateway: true, code: "LOCAL_SANDBOX_UNSAFE" },
  ])(
    "startup refuses $label despite a successful local API response",
    async ({ replace, gateway, code }) => {
      const runtime = await startupRuntime(replace, gateway);
      await expect(runtime.start({ name, runtimeId: "runtime-1" })).rejects.toMatchObject({ code });
    },
  );
  test("native ls identity and state are usable without inspect-only security fields", async () => {
    const fixture = await localFixture(state);
    const runtime = simulatedRuntime(fixture.policy, async () =>
      result({
        sandboxes: [
          {
            name,
            id: "7c34dff2-c6a5-4859-be73-3a8914bc4ceb",
            agent: "shell",
            status: "stopped",
            last_used_at: "2026-10-04T16:00:00Z",
            cpus: 2,
            memory: "2048m",
            memory_mib: 2048,
            created_at: "2026-10-04T15:59:00Z",
          },
        ],
      }),
    );
    await expect(
      runtime.exact({ name, runtimeId: "7c34dff2-c6a5-4859-be73-3a8914bc4ceb" }),
    ).resolves.toMatchObject({ name, agent: "shell", status: "stopped" });
  });
  test.each([
    { label: "active MCP gateway", change: { mcp_gateway: true } },
    {
      label: "host mount",
      change: { runtime_mounts: [{ source: "/host", target: "/workspace" }] },
    },
    { label: "different image", change: { image: "unapproved:latest" } },
    { label: "different resources", change: { cpus: 99 } },
    { label: "missing actual mount observation", change: { runtime_mounts: undefined } },
    {
      label: "host secret",
      change: { secrets: [{ name: "host-secret" }] },
    },
    { label: "exposed port", change: { ports: ["8080:80"] } },
    { label: "authentication integration", change: { auth_mode: "host" } },
    { label: "missing gateway observation", change: { mcp_gateway: undefined } },
    { label: "missing kits observation", change: { kits: undefined } },
    {
      label: "unknown CLI version with omitted zero fields",
      change: {
        daemon_version: "v0.47.0",
        secrets: undefined,
        ports: undefined,
        auth_mode: undefined,
      },
    },
  ])("inspect refuses $label despite a valid identity-only ls row", async ({ change }) => {
    const fixture = await localFixture(state);
    const runtime = simulatedRuntime(fixture.policy, async (request) =>
      request.argv[0] === "ls"
        ? result({ sandboxes: [{ id: "runtime-1", name, agent: "shell", status: "stopped" }] })
        : result({
            name,
            agent: "shell",
            state: "stopped",
            image: fixture.policy.runtime.template,
            image_digest: fixture.policy.runtime.template.split("@")[1],
            cpus: fixture.policy.runtime.cpuCores,
            memory: `${fixture.policy.runtime.memoryBytes / 1024 ** 2}m`,
            network: name,
            network_policy: { scope: "sandbox" },
            proxy: "172.17.0.0:3128",
            mcp_gateway: false,
            runtime_mounts: [],
            sessions: 0,
            daemon_version: "v0.46.0",
            kits: [],
            secrets: [],
            ports: [],
            auth_mode: "",
            ...change,
          }),
    );
    await expect(runtime.verifyBoundary({ name, runtimeId: "runtime-1" })).rejects.toMatchObject({
      code: "LOCAL_SANDBOX_UNSAFE",
    });
  });
  test("pinned CLI omission of zero auth mode, secrets and ports preserves observed isolation", async () => {
    const fixture = await localFixture(state);
    const runtime = simulatedRuntime(fixture.policy, async (request) =>
      request.argv[0] === "ls"
        ? result({ sandboxes: [{ id: "runtime-1", name, agent: "shell", status: "stopped" }] })
        : result({
            name,
            agent: "shell",
            image: fixture.policy.runtime.template,
            image_digest: fixture.policy.runtime.template.split("@")[1],
            cpus: fixture.policy.runtime.cpuCores,
            memory: `${fixture.policy.runtime.memoryBytes / 1024 ** 2}m`,
            network: name,
            network_policy: { scope: "sandbox" },
            mcp_gateway: false,
            runtime_mounts: [],
            daemon_version: "v0.46.0",
            kits: [],
          }),
    );
    await expect(runtime.verifyBoundary({ name, runtimeId: "runtime-1" })).resolves.toBeUndefined();
  });
  test("the native direct device socket inside private HOME is accepted without a UID alias", async () => {
    const fixture = await localFixture(state);
    let socket = "";
    const runtime = simulatedRuntime(fixture.policy, async () =>
      result({ status: "stopped", socket }),
    );
    const directory = join(
      runtime.home,
      ".sbx",
      `run_${runtime.environment.DOCKER_SANDBOXES_APP_NAME}`,
      "d",
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    socket = join(directory, "sandboxd.sock");
    await expect(runtime.verifyDaemonOwnership(true)).resolves.toBeUndefined();
  });

  test.each(["other-control", ".sbx/run_other-device/d"])(
    "a private HOME socket at %s cannot substitute for the device's native control path",
    async (path) => {
      const fixture = await localFixture(state);
      let socket = "";
      const runtime = simulatedRuntime(fixture.policy, async () =>
        result({ status: "stopped", socket }),
      );
      const directory = join(runtime.home, path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      socket = join(directory, "sandboxd.sock");
      await expect(runtime.verifyDaemonOwnership(true)).rejects.toMatchObject({
        code: "LOCAL_DAEMON_UNOWNED",
      });
    },
  );
  test("native socket path refusal identifies the required shorter bounded mount", async () => {
    const fixture = await localFixture(state);
    const runtime = simulatedRuntime(fixture.policy, async () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        "no usable network socket dir: both exceed the platform's sun_path limit",
      ),
    }));
    await expect(runtime.call(["version"])).rejects.toMatchObject({
      code: "LOCAL_RUNTIME_PATH_TOO_LONG",
      message: expect.stringContaining("bounded storage"),
    });
  });
  test.each([
    { status: "running", targetExists: true },
    { status: "stopped", targetExists: true },
    { status: "stopped", targetExists: false },
  ])(
    "setup refuses foreign $status control aliases (target exists: $targetExists)",
    async ({ status, targetExists }) => {
      const fixture = await localFixture(state);
      const foreign = join(root, "foreign-runtime");
      let alias = "";
      if (targetExists) await mkdir(foreign, { mode: 0o700 });
      const settings = new Map<string, string>();
      let foreignDaemonStarted = false;
      const runtime = simulatedRuntime(fixture.policy, async (request) => {
        if (request.argv[0] === "daemon" && request.argv[1] === "status")
          return result({ status, socket: join(alias, "sandboxd.sock") });
        if (request.argv[0] === "daemon" && request.argv[1] === "start")
          foreignDaemonStarted = true;
        if (request.argv[0] === "ls") return result({ sandboxes: [] });
        if (request.argv[0] === "settings" && request.argv[1] === "set")
          settings.set(request.argv[2], request.argv[3]);
        if (request.argv[0] === "settings")
          return result(
            [...settings].map(([key, value]) => ({
              key,
              value: value === "false" ? false : value,
            })),
          );
        return result();
      });
      alias = join(
        "/tmp",
        `sboxd-${process.getuid?.() ?? 0}-sandboxes-${runtime.environment.DOCKER_SANDBOXES_APP_NAME}`,
      );
      await symlink(foreign, alias);
      aliases.push(alias);
      runtime.validateExecutable = async () => undefined;
      runtime.prepareCredentials = async () => undefined;
      await expect(runtime.initialize()).rejects.toMatchObject({ code: "LOCAL_DAEMON_UNOWNED" });
      expect(foreignDaemonStarted).toBe(false);
      expect([...settings]).toEqual([]);
    },
  );

  test("distinct local devices select separate native daemon namespaces", async () => {
    const first = await localFixture(state);
    first.policy.deviceId = "11111111-1111-4111-8111-111111111111";
    const second = { ...first.policy, deviceId: "22222222-2222-4222-8222-222222222222" };
    const observed: string[] = [];
    for (const policy of [first.policy, second]) {
      const runtime = simulatedRuntime(policy, async (request) => {
        observed.push(request.env.DOCKER_SANDBOXES_APP_NAME);
        return result();
      });
      await runtime.call(["version"]);
    }
    expect(observed).toEqual(["moira-11111111111141", "moira-22222222222242"]);
    expect(new Set(observed).size).toBe(2);
  });

  test("an owned empty runtime receives the disabled host integrations", async () => {
    const fixture = await localFixture(state);
    const settings = new Map<string, unknown>();
    let socket = "";
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
      if (request.argv[0] === "daemon" && request.argv[1] === "status")
        return result({ status: "running", socket });
      if (request.argv[0] === "ls") return result({ sandboxes: [] });
      if (request.argv[0] === "policy" && request.argv[1] === "init")
        return {
          exitCode: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("global network policy already initialized; reset it first"),
        };
      if (request.argv[0] === "policy")
        return result({ rules: [{ resource_type: "filesystem:read" }, baseline] });
      if (request.argv[0] === "settings" && request.argv[1] === "set")
        settings.set(
          request.argv[2],
          request.argv[3].startsWith("{")
            ? JSON.parse(request.argv[3])
            : request.argv[3] === "false"
              ? false
              : request.argv[3],
        );
      if (request.argv[0] === "settings" && request.argv[1] === "get")
        return result({ value: settings.get(request.argv[2]) });
      if (request.argv[0] === "settings")
        return result([...settings].map(([key, value]) => ({ key, value })));
      return result();
    });
    socket = await ownedSocket(runtime);
    runtime.validateExecutable = async () => undefined;
    runtime.prepareCredentials = async () => undefined;
    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(settings.get("ssh.agentForwardingEnabled")).toBe(false);
    expect(settings.get("env.rememberHostCommands")).toBe(false);
    expect(settings.get("ssh.autoCreate")).toBe(false);
    expect(settings.get("ssh.workspaceRoot")).toBe("");
    expect(settings.get("skills.defaultMode")).toBe("off");
    expect(settings.get("proxy.integratedAuth")).toBe(false);
    expect(settings.get("feature.network-user-prompts")).toEqual({
      enabled: false,
      variant: "",
      variantPayload: "",
    });
  });

  test.each([
    {
      label: "TCP denial blocks the broker",
      rules: [{ ...baseline, actions: ["net:connect:tcp", "net:connect:udp"] }],
    },
    { label: "denial lost after restart", rules: [], afterRestart: true },
    { label: "virtual fallback after restart", rules: [virtualDefault], afterRestart: true },
    { label: "editable manual dual denial", rules: [{ ...virtualDefault, editable: true }] },
    { label: "foreign virtual source", rules: [{ ...virtualDefault, origin: "remote" }] },
    { label: "missing virtual source", rules: [{ ...virtualDefault, origin: undefined }] },
    { label: "missing noneditable evidence", rules: [{ ...virtualDefault, editable: undefined }] },
    { label: "another virtual identity", rules: [{ ...virtualDefault, id: "manual-deny" }] },
    { label: "duplicate virtual defaults", rules: [virtualDefault, virtualDefault] },
    {
      label: "virtual default plus allow",
      rules: [virtualDefault, { ...virtualDefault, decision: "allow" }],
    },
    {
      label: "unexpected allow",
      rules: [baseline, { ...baseline, id: "allow-extra", decision: "allow" }],
    },
    {
      label: "preexisting sandbox broker grant",
      rules: [
        baseline,
        { ...baseline, scope: "sandbox", decision: "allow", resources: ["localhost:12345"] },
      ],
    },
    { label: "missing UDP denial", rules: [{ ...baseline, actions: ["net:connect:tcp"] }] },
    { label: "wrong resources", rules: [{ ...baseline, resources: ["example.org"] }] },
    { label: "inactive denial", rules: [{ ...baseline, status: "inactive" }] },
    {
      label: "sandbox-only denial",
      rules: [{ ...baseline, scope: "sandbox", applies_to: "other" }],
    },
  ])(
    "setup refuses $label global network baseline without resetting it",
    async ({ rules, ...scenario }) => {
      const fixture = await localFixture(state);
      let socket = "";
      let reset = false;
      let restarted = false;
      const settings = new Map<string, unknown>();
      const runtime = simulatedRuntime(fixture.policy, async (request) => {
        if (request.argv[0] === "daemon" && request.argv[1] === "status")
          return result({ status: "running", socket });
        if (request.argv[0] === "daemon" && request.argv[1] === "restart") restarted = true;
        if (request.argv[0] === "ls") return result({ sandboxes: [] });
        if (request.argv[0] === "policy") {
          if (request.argv[1] === "reset") reset = true;
          return result({
            rules:
              "afterRestart" in scenario && scenario.afterRestart && !restarted
                ? [baseline]
                : rules,
          });
        }
        if (request.argv[0] === "settings" && request.argv[1] === "set")
          settings.set(
            request.argv[2],
            request.argv[3].startsWith("{")
              ? JSON.parse(request.argv[3])
              : request.argv[3] === "false"
                ? false
                : request.argv[3],
          );
        if (request.argv[0] === "settings" && request.argv[1] === "get")
          return result({ value: settings.get(request.argv[2]) });
        if (request.argv[0] === "settings")
          return result([...settings].map(([key, value]) => ({ key, value })));
        return result();
      });
      socket = await ownedSocket(runtime);
      runtime.validateExecutable = async () => undefined;
      runtime.prepareCredentials = async () => undefined;
      await expect(runtime.initialize()).rejects.toMatchObject({ code: "LOCAL_NETWORK_UNSAFE" });
      expect(reset).toBe(false);
    },
  );

  test.each([
    { label: "legacy bare sandbox", scope: "sandbox", appliesTo: name, accepted: true },
    {
      label: "pinned native sandbox",
      scope: `sandbox:${name}`,
      appliesTo: `sandbox:${name}`,
      accepted: true,
    },
    {
      label: "foreign native sandbox",
      scope: "sandbox:foreign",
      appliesTo: "sandbox:foreign",
      accepted: false,
    },
    {
      label: "malformed native sandbox",
      scope: `sandbox:moira-${"a".repeat(31)}`,
      appliesTo: `sandbox:moira-${"a".repeat(31)}`,
      accepted: false,
    },
    {
      label: "mismatched native sandbox",
      scope: `sandbox:${name}`,
      appliesTo: `sandbox:moira-${"b".repeat(32)}`,
      accepted: false,
    },
    {
      label: "native scope with bare target",
      scope: `sandbox:${name}`,
      appliesTo: name,
      accepted: false,
    },
    { label: "foreign bare sandbox", scope: "sandbox", appliesTo: "foreign", accepted: false },
  ])(
    "reopened runtime validates $label broker scope while retaining global denial",
    async ({ scope, appliesTo, accepted }) => {
      const fixture = await localFixture(state);
      let socket = "";
      const runtime = simulatedRuntime(fixture.policy, async (request) =>
        request.argv[0] === "daemon"
          ? result({ status: "running", socket })
          : result({
              rules: [
                { resource_type: "filesystem:read" },
                baseline,
                {
                  ...baseline,
                  scope,
                  applies_to: appliesTo,
                  decision: "allow",
                  resources: ["localhost:12345"],
                  actions: ["net:connect:tcp"],
                },
              ],
            }),
      );
      socket = await ownedSocket(runtime);
      if (accepted) await expect(runtime.verifyGlobalNetworkPolicy()).resolves.toBeUndefined();
      else
        await expect(runtime.verifyGlobalNetworkPolicy()).rejects.toMatchObject({
          code: "LOCAL_NETWORK_UNSAFE",
        });
    },
  );

  test.each([
    { label: "sandbox-only denial", rules: [{ ...baseline, scope: "sandbox" }] },
    { label: "additional global allow", rules: [baseline, { ...baseline, decision: "allow" }] },
    { label: "missing UDP", rules: [{ ...baseline, actions: ["net:connect:tcp"] }] },
    { label: "inactive global denial", rules: [{ ...baseline, status: "inactive" }] },
    { label: "readonly virtual fallback", rules: [virtualDefault] },
  ])(
    "reopening refuses $label instead of treating sandbox policy as global isolation",
    async ({ rules }) => {
      const fixture = await localFixture(state);
      let socket = "";
      const runtime = simulatedRuntime(fixture.policy, async (request) =>
        request.argv[0] === "daemon" ? result({ status: "running", socket }) : result({ rules }),
      );
      socket = await ownedSocket(runtime);
      await expect(runtime.verifyGlobalNetworkPolicy()).rejects.toMatchObject({
        code: "LOCAL_NETWORK_UNSAFE",
      });
    },
  );

  test.each(["id", "name", "agent", "status"])(
    "missing native ls %s is refused instead of admitting an unidentified sandbox",
    async (field) => {
      const fixture = await localFixture(state);
      const row: Record<string, string> = {
        id: "runtime-1",
        name,
        agent: "shell",
        status: "running",
      };
      delete row[field];
      const runtime = simulatedRuntime(fixture.policy, async () =>
        result({
          sandboxes: [row],
        }),
      );
      await expect(runtime.exact({ name, runtimeId: "runtime-1" })).rejects.toThrow();
    },
  );
  test.each([
    {
      label: "isolated stopped shell",
      status: "stopped",
      gateway: false,
      mounts: [],
      expected: { name, runtimeId: "7c34dff2-c6a5-4859-be73-3a8914bc4ceb" },
    },
    {
      label: "isolated running shell",
      status: "running",
      gateway: false,
      mounts: [],
      expected: { name, runtimeId: "7c34dff2-c6a5-4859-be73-3a8914bc4ceb" },
    },
    {
      label: "active host gateway",
      status: "running",
      gateway: true,
      mounts: [],
      expected: { error: "LOCAL_SANDBOX_UNSAFE" },
    },
    {
      label: "missing mount observation",
      status: "stopped",
      gateway: false,
      mounts: undefined,
      expected: { error: "LOCAL_SANDBOX_UNSAFE" },
    },
  ])(
    "raw creation returns identity only for a validated snapshot: $label",
    async ({ status, gateway, mounts, expected }) => {
      const fixture = await localFixture(state);
      const id = "7c34dff2-c6a5-4859-be73-3a8914bc4ceb";
      let created = false;
      let socket = "";
      const runtime = simulatedRuntime(fixture.policy, async (request) => {
        if (request.binary === process.execPath) {
          created = true;
          return result({ name, agent: "shell", workspace: "" });
        }
        if (request.argv[0] === "daemon") return result({ status: "running", socket });
        if (request.argv[0] === "ls")
          return result({ sandboxes: created ? [{ id, name, agent: "shell", status }] : [] });
        return result({
          name,
          agent: "shell",
          image: fixture.policy.runtime.template,
          image_digest: fixture.policy.runtime.template.split("@")[1],
          cpus: fixture.policy.runtime.cpuCores,
          memory: `${fixture.policy.runtime.memoryBytes / 1024 ** 2}m`,
          network: name,
          network_policy: { scope: "sandbox" },
          runtime_mounts: mounts,
          kits: [],
          daemon_version: "v0.46.0",
          mcp_gateway: gateway,
        });
      });
      socket = await ownedSocket(runtime);
      runtime.verifySettings = async () => undefined;
      const outcome = await runtime
        .create(name)
        .catch((error: { code: string }) => ({ error: error.code }));
      expect(outcome).toEqual(expected);
    },
  );

  test.each(["not-a-uuid", ""])(
    "raw creation refuses malformed fresh inventory id '%s'",
    async (id) => {
      const fixture = await localFixture(state);
      let created = false;
      let socket = "";
      const runtime = simulatedRuntime(fixture.policy, async (request) => {
        if (request.binary === process.execPath) {
          created = true;
          return result({ name, agent: "shell", workspace: "" });
        }
        if (request.argv[0] === "daemon") return result({ status: "running", socket });
        return result({
          sandboxes: created ? [{ id, name, agent: "shell", status: "stopped" }] : [],
        });
      });
      socket = await ownedSocket(runtime);
      runtime.verifySettings = async () => undefined;
      await expect(runtime.create(name)).rejects.toThrow();
    },
  );

  test("unsafe host-integration settings are refused instead of being reported ready", async () => {
    const fixture = await localFixture(state);
    let socket = "";
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
      if (request.argv[0] === "daemon") return result({ status: "running", socket });
      if (request.argv[0] === "settings")
        return result([{ key: "clipboard.imagePaste", value: true }]);
      return result();
    });
    socket = await ownedSocket(runtime);
    runtime.validateExecutable = async () => undefined;
    runtime.prepareCredentials = async () => undefined;
    await expect(runtime.verifySettings()).rejects.toMatchObject({ code: "LOCAL_RUNTIME_UNSAFE" });
  });

  test("identity mismatch fails closed before stop or removal can target the observed sandbox", async () => {
    const fixture = await localFixture(state);
    const calls: string[][] = [];
    const runtime = simulatedRuntime(fixture.policy, async (request) => {
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
