import { describe, expect, test } from "@jest/globals";
import { validateGitHubSshConfig } from "../../../packages/local/src/github-provisioner.js";
import {
  provisionGitHubWorkspace,
  resumeGitHubWorkspaceEnrollment,
  type GitHubProvisionDependencies,
  type GitHubProvisionTarget,
} from "../../../packages/local/src/github-provisioner.js";
import {
  WORKSPACE_PROBE_SCRIPT,
  WORKSPACE_INSTALL_SCRIPT,
  WORKSPACE_GITHUB_PROOF_SCRIPT,
  WORKSPACE_CONFIGURE_SCRIPT,
  WORKSPACE_START_SCRIPT,
  WORKSPACE_HEALTH_SCRIPT,
} from "../../../packages/workspace-service/src/bootstrap.mjs";
import { LocalRefusal } from "../../../packages/local/src/policy.js";
import { randomUUID } from "node:crypto";
import type { GitHubProvisionProof } from "../../../packages/shared/src/codespaces/local-controller-protocol.js";

const home = "/tmp/moira-gh-owned",
  gh = `${home}/gh`,
  resource = "owned-codespace";
const generated = `Host cs.${resource}.feature-branch
  User codespace
  ProxyCommand ${gh} cs ssh -c ${resource} --stdio -- -i ${home}/.ssh/codespaces.auto
  UserKnownHostsFile=/dev/null
  StrictHostKeyChecking no
  LogLevel quiet
  ControlMaster auto
  IdentityFile ${home}/.ssh/codespaces.auto
`;
describe("fixed GitHub provisioning configuration", () => {
  test("the pinned CLI configuration retains exactly the owned resource, key and executable", () => {
    expect(validateGitHubSshConfig(generated, gh, home, resource)).toBe(
      `cs.${resource}.feature-branch`,
    );
  });
  test.each([
    generated + "User root\n",
    generated + "LocalCommand touch /tmp/unowned\n",
    generated.replace(`${gh} cs ssh`, "/project/gh cs ssh"),
    generated.replace("--stdio -- -i", "--stdio -- -o ProxyCommand=unowned -i"),
    generated.replace("Host cs.owned-codespace", "Host cs.foreign-codespace"),
    generated.replace(`IdentityFile ${home}`, "IdentityFile /project"),
  ])("foreign or overriding SSH configuration refuses before execution", (configuration) => {
    expect(() => validateGitHubSshConfig(configuration, gh, home, resource)).toThrow();
  });
});

function provisioningFixture() {
  const target: GitHubProvisionTarget = {
    requestId: `ws1-${randomUUID()}`,
    resourceId: randomUUID(),
    providerResourceName: resource,
    repositoryId: "1",
    repositoryFullName: "owner/project",
    resourceGeneration: 3,
    authorizationGeneration: 4,
  };
  const measured = {
    root: "/workspaces/project",
    rootDevice: "1",
    rootInode: "2",
    environmentIdentity: "e".repeat(64),
    release: "a".repeat(64),
  };
  const proof: GitHubProvisionProof = {
    ...measured,
    requestId: target.requestId,
    providerResourceName: resource,
    repositoryId: "1",
    repositoryFullName: "owner/project",
    resourceGeneration: 3,
    authorizationGeneration: 4,
  };
  const executed: string[] = [];
  const configurations: Record<string, unknown>[] = [];
  let serving = false,
    prepared: GitHubProvisionProof | undefined,
    disposed = 0;
  const scripts = [
    WORKSPACE_PROBE_SCRIPT,
    WORKSPACE_INSTALL_SCRIPT,
    WORKSPACE_GITHUB_PROOF_SCRIPT,
    WORKSPACE_CONFIGURE_SCRIPT,
    WORKSPACE_START_SCRIPT,
    WORKSPACE_HEALTH_SCRIPT,
  ];
  const dependencies: GitHubProvisionDependencies = {
    tools: async (home) => ({ gh: `${home}/gh`, ssh: "/usr/bin/ssh", version: "2.102.0" }),
    payload: async (_directory, architecture) => ({
      version: 1,
      architecture: architecture as "arm64",
      libc: "glibc",
      release: measured.release,
      archiveSha256: "b".repeat(64),
      fileName: "fixture.tar.gz",
      path: "/not-opened-by-controlled-process",
      size: 1,
      identity: { dev: 1, ino: 2, size: 1, mtimeMs: 0, ctimeMs: 0 },
    }),
    custody: { directory: "/fixture-custody", prepared: async () => undefined },
    acquire: async () => ({
      securityRequestId: `ws1-${randomUUID()}`,
      token: "host-scoped-only",
      expiresAt: Date.now() + 60000,
      useUntil: Date.now() + 60000,
      repositoryFullName: target.repositoryFullName,
      validate: async () => undefined,
      dispose: async () => {
        disposed++;
      },
    }),
    inspect: async () => ({
      name: resource,
      repositoryId: "1",
      repositoryFullName: target.repositoryFullName,
      state: "available",
    }),
    prepared: async (value) => {
      prepared = value;
    },
    ready: async (health) => {
      expect(health.environmentIdentity).toBe(proof.environmentIdentity);
    },
    enroll: async () => {
      throw new LocalRefusal("WORKSPACE_OUTCOME_UNCONFIRMED", "Controlled cloud outage");
    },
    run: async (request) => {
      expect(request.env.GH_TOKEN).toBe("host-scoped-only");
      expect(request.settleGroup).toBe(true);
      expect(request.custody?.directory).toBe("/fixture-custody");
      let result: unknown;
      if (request.binary.endsWith("/gh")) {
        expect(request.argv).toEqual(["codespace", "ssh", "-c", resource, "--config"]);
        return {
          exitCode: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(generated.replaceAll(home, request.cwd)),
        };
      }
      expect(request.binary).toBe("/usr/bin/ssh");
      expect(request.argv.slice(0, 9)).toEqual([
        "-F",
        `${request.cwd}/ssh-config`,
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "BatchMode=yes",
        `cs.${resource}.feature-branch`,
      ]);
      const script = scripts.find(
        (value) => request.argv[9] === `/bin/sh -c '${value.replace(/'/g, `'\\''`)}'`,
      );
      if (!script) throw new Error("Unexpected non-fixed provisioning program");
      executed.push(script);
      if (script === WORKSPACE_PROBE_SCRIPT)
        result = { environmentIdentity: measured.environmentIdentity, architecture: "aarch64" };
      else if (script === WORKSPACE_INSTALL_SCRIPT)
        result = { installed: true, releaseIdentity: measured.release };
      else if (script === WORKSPACE_GITHUB_PROOF_SCRIPT) result = measured;
      else if (script === WORKSPACE_CONFIGURE_SCRIPT) {
        const value = JSON.parse(Buffer.from(request.stdin!).toString());
        expect(JSON.stringify(value)).not.toContain("host-scoped-only");
        configurations.push(value);
        result = {
          configured: true,
          releaseIdentity: measured.release,
          environmentIdentity: measured.environmentIdentity,
        };
      } else if (script === WORKSPACE_START_SCRIPT) {
        serving = true;
        result = {};
      } else {
        if (!serving) throw new Error("Unix owner not ready");
        result = {
          releaseIdentity: measured.release,
          environmentIdentity: measured.environmentIdentity,
          remote: {
            state: configurations.at(-1)?.remote
              ? "connecting"
              : (configurations.at(-1)?.remoteState ?? "unconfigured"),
          },
        };
      }
      return { exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify(result)) };
    },
  };
  return {
    target,
    proof,
    measured,
    dependencies,
    executed,
    configurations,
    serving: () => serving,
    prepared: () => prepared,
    disposed: () => disposed,
  };
}

test("initial provisioning persists exact proof and establishes Unix readiness while enrollment is held, then preserves local readiness on outage", async () => {
  const f = provisioningFixture();
  let entered!: () => void, release!: () => void;
  const enrolling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.dependencies.enroll = async (proof) => {
    expect(proof).toEqual(f.prepared());
    expect(f.serving()).toBe(true);
    entered();
    await held;
    throw new LocalRefusal("WORKSPACE_OUTCOME_UNCONFIRMED", "Controlled outage");
  };
  const work = provisionGitHubWorkspace(f.target, f.dependencies);
  await enrolling;
  expect(f.configurations[0]).toMatchObject({
    ownerSelector: { kind: "github", resourceId: f.target.resourceId },
    mode: "local-only",
    expectedRelease: f.proof.release,
  });
  expect(f.configurations[0]).not.toHaveProperty("remote");
  release();
  expect(await work).toMatchObject({
    proof: f.proof,
    health: { remote: { state: "enrollment_unavailable" } },
  });
  expect(f.disposed()).toBe(1);
});

test("explicit enrollment continuation uses original proof without installation or provider startup and rejects a changed initial life", async () => {
  const f = provisioningFixture();
  f.dependencies.payload = async () => {
    throw new Error("The current host payload is unavailable after upgrade");
  };
  const remote = {
    version: 1 as const,
    origin: "https://moira.example",
    publicOrigin: "https://moira.example",
    resourceId: f.target.resourceId,
    resourceGeneration: 3,
    authorizationGeneration: 4,
    environmentIdentity: f.proof.environmentIdentity,
    credential: "x".repeat(43),
  };
  f.dependencies.enroll = async (value) => {
    expect(value).toEqual(f.proof);
    return remote;
  };
  expect(await resumeGitHubWorkspaceEnrollment(f.target, f.proof, f.dependencies)).toMatchObject({
    proof: f.proof,
    health: { remote: { state: "connecting" } },
  });
  expect(f.executed).not.toContain(WORKSPACE_INSTALL_SCRIPT);
  expect(f.configurations).toHaveLength(2);
  const changed = provisioningFixture();
  const original = structuredClone(changed.proof);
  changed.measured.environmentIdentity = "f".repeat(64);
  await expect(
    resumeGitHubWorkspaceEnrollment(changed.target, original, changed.dependencies),
  ).rejects.toMatchObject({ code: "GITHUB_PROVISIONING_UNAVAILABLE" });
  expect(changed.configurations).toEqual([]);
  expect(changed.disposed()).toBe(1);
});

test("a refused current-authority readiness publication prevents enrollment of the prepared original", async () => {
  const f = provisioningFixture();
  let enrollments = 0;
  f.dependencies.ready = async () => {
    throw new LocalRefusal("LOCAL_GENERATION_CONFLICT", "Original setup authority changed");
  };
  f.dependencies.enroll = async () => {
    enrollments++;
    throw new Error("Old authority must not enroll");
  };
  await expect(provisionGitHubWorkspace(f.target, f.dependencies)).rejects.toMatchObject({
    code: "LOCAL_GENERATION_CONFLICT",
  });
  expect(f.prepared()).toEqual(f.proof);
  expect(f.serving()).toBe(true);
  expect(enrollments).toBe(0);
  expect(f.disposed()).toBe(1);
});

test("a retained proof resumes failed initial configuration on the same root without installing another payload", async () => {
  const f = provisioningFixture();
  const run = f.dependencies.run!;
  let refuseConfiguration = true;
  f.dependencies.run = async (request) => {
    if (refuseConfiguration && request.argv.at(-1)?.includes("--configure")) {
      refuseConfiguration = false;
      return {
        exitCode: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("Controlled configuration failure"),
      };
    }
    return run(request);
  };
  await expect(provisionGitHubWorkspace(f.target, f.dependencies)).rejects.toMatchObject({
    code: "GITHUB_PROVISIONING_UNAVAILABLE",
  });
  expect(f.prepared()).toEqual(f.proof);
  expect(f.configurations).toEqual([]);
  expect(f.serving()).toBe(false);
  f.dependencies.payload = async () => {
    throw new Error("Resume must not load a host payload");
  };
  expect(await resumeGitHubWorkspaceEnrollment(f.target, f.proof, f.dependencies)).toMatchObject({
    proof: f.proof,
    health: { remote: { state: "enrollment_unavailable" } },
  });
  expect(f.executed.filter((script) => script === WORKSPACE_INSTALL_SCRIPT)).toHaveLength(1);
  expect(f.serving()).toBe(true);
  expect(f.disposed()).toBe(2);
});
