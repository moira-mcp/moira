import { expect, test } from "@jest/globals";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../../../packages/local/src/process.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { localFixture } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import { controllerFixture } from "../../fixtures/local-controller.js";
import { controllerRequest } from "../../../packages/local/src/controller.js";
import {
  encodeReference,
  decodeReference,
} from "../../../packages/shared/src/codespaces/workspace-references.mjs";

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

test.each(["create", "start", "resume-setup"] as const)(
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

test.each(["local-sandboxes", "github-codespaces"] as const)(
  "packaged observe of %s finishes while the full native inventory remains held",
  async (provider) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "moira-cli-exact-")));
    const identity = {
      userId: "owner",
      deviceId: randomUUID(),
      deviceGeneration: 1,
      connectionId: randomUUID(),
    };
    const f = await controllerFixture(root, identity);
    const resourceId = randomUUID();
    await f.controller.state.putBinding({
      ...identity,
      resourceId,
      resourceGeneration: 3,
      repositoryId: f.space.repositoryId,
      operationMarker: f.space.operationMarker,
      localSpaceId: f.space.id,
      localGeneration: f.space.generation,
      creationClosed: false,
    });
    const githubId = randomUUID();
    await f.controller.state.putGitHubBinding(
      {
        resourceId: githubId,
        resourceGeneration: 5,
        authorizationGeneration: 1,
        repositoryId: "123",
        repositoryFullName: "owner/project",
        requestedRef: "main",
        operationMarker: `moira-${"b".repeat(24)}`,
        providerResourceName: "retained-gh",
        retirement: "owned",
        state: "running",
        desiredState: "running",
        environmentIdentity: "c".repeat(64),
        pendingRequestIds: [],
        observedAt: 1,
        providerResource: null,
      },
      identity,
    );
    let release!: () => void, entered!: () => void, blockedCli!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inventoryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cliEnteredFullScan = new Promise<void>((resolve) => {
      blockedCli = resolve;
    });
    const native = f.manager.snapshot.bind(f.manager);
    const reads: Array<string | undefined> = [];
    f.manager.snapshot = async (spaceId) => {
      reads.push(spaceId);
      if (spaceId === undefined) {
        if (reads.length === 1) entered();
        else blockedCli();
        await held;
      }
      return native(spaceId);
    };
    const full = controllerRequest(f.endpoint.socketPath, "GET", "/v1/controller");
    let fullFinished = false;
    void full.then(() => {
      fullFinished = true;
    });
    let finished = false;
    let selected: ReturnType<typeof runProcess> | undefined;
    try {
      await inventoryEntered;
      const reference = encodeReference("workspace", {
        resourceId: provider === "local-sandboxes" ? resourceId : githubId,
        provider,
        deviceId: identity.deviceId,
        generation: 1,
      });
      selected = runProcess({
        binary: process.execPath,
        argv: [resolve("packages/local/dist/cli.js"), "observe", reference, "--state", root],
        cwd: root,
        env: {},
        timeoutMs: 15_000,
        maxBytes: 8192,
      });
      void selected.then(() => {
        finished = true;
      });
      const observed = await Promise.race([
        selected.then((result) => ({ kind: "completed" as const, result })),
        cliEnteredFullScan.then(() => ({ kind: "held-full-scan" as const })),
      ]);
      // The wrong implementation is observed entering the held scan, rather than inferred from a timeout.
      expect({ kind: observed.kind, finished }).toEqual({ kind: "completed", finished: true });
      if (observed.kind !== "completed") throw new Error("Selected CLI used the held full scan");
      expect(observed.result.exitCode).toBe(0);
      expect(fullFinished).toBe(false);
      const result = JSON.parse(observed.result.stdout.toString());
      expect(result.workspaces).toHaveLength(1);
      expect(decodeReference(result.workspaces[0].workspace, "workspace")).toEqual({
        resourceId: provider === "local-sandboxes" ? resourceId : githubId,
        provider,
        deviceId: identity.deviceId,
        generation: provider === "local-sandboxes" ? 3 : 5,
      });
      expect(reads).toEqual(provider === "local-sandboxes" ? [undefined, f.space.id] : [undefined]);
    } finally {
      release();
      await Promise.allSettled([full, ...(selected ? [selected] : [])]);
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
