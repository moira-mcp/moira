import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  githubProvisionProofSchema,
  type GitHubProvisionProof,
  type WorkspaceBootstrapCredential,
} from "../../shared/src/codespaces/local-controller-protocol.js";
import {
  loadWorkspacePayload,
  workspaceInstallInput,
  WORKSPACE_PROBE_SCRIPT,
  WORKSPACE_INSTALL_SCRIPT,
  WORKSPACE_GITHUB_PROOF_SCRIPT,
  WORKSPACE_CONFIGURE_SCRIPT,
  WORKSPACE_START_SCRIPT,
  WORKSPACE_HEALTH_SCRIPT,
} from "../../workspace-service/src/bootstrap.mjs";
import { githubToolchain } from "./github-toolchain.js";
import { runProcess } from "./process.js";
import { LocalRefusal } from "./policy.js";
import type { ProcessCustodyWitness } from "./process-custody.js";

export interface GitHubProvisionTarget {
  requestId: string;
  resourceId: string;
  providerResourceName: string;
  repositoryId: string;
  repositoryFullName: string;
  previousRepositoryFullName?: string;
  resourceGeneration: number;
  authorizationGeneration: number;
}
export type GitHubEnrollment = WorkspaceBootstrapCredential;
export interface GitHubProvisionDependencies {
  signal?: AbortSignal;
  custody: {
    directory: string;
    prepared(witness: ProcessCustodyWitness, securityRequestId: string): Promise<void>;
  };
  acquire(signal?: AbortSignal): Promise<{
    securityRequestId: string;
    token: string;
    expiresAt: number;
    useUntil: number;
    repositoryFullName: string;
    validate(signal?: AbortSignal): Promise<void>;
    dispose(): Promise<void>;
  }>;
  inspect(
    signal?: AbortSignal,
  ): Promise<{ name: string; repositoryId: string; repositoryFullName: string; state: string }>;
  enroll(proof: GitHubProvisionProof): Promise<GitHubEnrollment>;
}
export interface GitHubProvisionResult {
  proof: GitHubProvisionProof;
  health: unknown;
}
const unavailable = () =>
  new LocalRefusal(
    "GITHUB_PROVISIONING_UNAVAILABLE",
    "The assigned GitHub workspace could not be provisioned.",
  );
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const payloadDirectory = () => fileURLToPath(new URL("workspace-payload/", import.meta.url));

/** Accept the complete one-host configuration of the pinned gh; duplicates cannot override custody. */
export function validateGitHubSshConfig(
  text: string,
  gh: string,
  home: string,
  resource: string,
): string {
  const lines = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const host = /^Host (cs\.\S+)$/.exec(lines[0] ?? "")?.[1];
  if (!host || !host.startsWith(`cs.${resource}.`)) throw unavailable();
  const expected: Record<string, string> = {
    ProxyCommand: `${gh} cs ssh -c ${resource} --stdio -- -i ${home}/.ssh/codespaces.auto`,
    UserKnownHostsFile: "/dev/null",
    StrictHostKeyChecking: "no",
    LogLevel: "quiet",
    ControlMaster: "auto",
    IdentityFile: `${home}/.ssh/codespaces.auto`,
  };
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const entry = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!entry || seen.has(entry[1])) throw unavailable();
    seen.add(entry[1]);
    if (entry[1] === "User") {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(entry[2])) throw unavailable();
    } else if (expected[entry[1]] !== entry[2]) throw unavailable();
  }
  if (seen.size !== 7 || !seen.has("User") || Object.keys(expected).some((key) => !seen.has(key)))
    throw unavailable();
  return host;
}

export async function githubProvisioningReadiness(): Promise<{
  state: "available" | "unavailable";
}> {
  if (!["darwin", "linux"].includes(process.platform)) return { state: "unavailable" };
  const home = await realpath(await mkdtemp("/tmp/moira-gh-"));
  try {
    await githubToolchain(home);
    await Promise.all(
      ["x64", "arm64"].map((architecture) =>
        loadWorkspacePayload(payloadDirectory(), architecture),
      ),
    );
    return { state: "available" };
  } catch {
    return { state: "unavailable" };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function provisionGitHubWorkspace(
  target: GitHubProvisionTarget,
  dependencies: GitHubProvisionDependencies,
): Promise<GitHubProvisionResult> {
  if (!["darwin", "linux"].includes(process.platform)) throw unavailable();
  if (!/^[A-Za-z0-9_-]+$/.test(target.providerResourceName)) throw unavailable();
  const home = await realpath(await mkdtemp("/tmp/moira-gh-"));
  let child: Awaited<ReturnType<GitHubProvisionDependencies["acquire"]>> | undefined;
  let custodyUnconfirmed = false;
  try {
    const tools = await githubToolchain(home);
    const observed = await dependencies.inspect(dependencies.signal);
    if (
      observed.name !== target.providerResourceName ||
      observed.repositoryId !== target.repositoryId ||
      observed.repositoryFullName !== target.repositoryFullName ||
      observed.state !== "available"
    )
      throw unavailable();
    child = await dependencies.acquire(dependencies.signal);
    if (
      child.repositoryFullName !== target.repositoryFullName ||
      child.expiresAt <= Date.now() ||
      child.useUntil <= Date.now()
    )
      throw unavailable();
    await mkdir(join(home, "config"), { mode: 0o700 });
    const environment = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      GH_CONFIG_DIR: join(home, "config"),
      GH_TOKEN: child.token,
      GH_PROMPT_DISABLED: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const execute = async (
      binary: string,
      argv: string[],
      input?: AsyncIterable<Uint8Array>,
      stdin?: Uint8Array,
    ) => {
      await child!.validate(dependencies.signal);
      const result = await runProcess({
        binary,
        argv,
        cwd: home,
        env: environment,
        timeoutMs: null,
        maxBytes: 65536,
        retainOutput: true,
        settleGroup: true,
        custody: {
          directory: dependencies.custody.directory,
          prepared: (witness) => dependencies.custody.prepared(witness, child!.securityRequestId),
        },
        signal: dependencies.signal,
        input,
        stdin,
      });
      if (result.exitCode !== 0) {
        if (
          result.stderr.toString("utf8").trim() ===
          '{"error":"WORKSPACE_REPOSITORY_REBIND_UNPROVEN"}'
        )
          throw new LocalRefusal(
            "GITHUB_REPOSITORY_REBIND_UNPROVEN",
            "The existing guest lacks the numeric repository proof required for this rename.",
          );
        throw unavailable();
      }
      return result.stdout.toString("utf8");
    };
    const sshText = await execute(tools.gh, [
      "codespace",
      "ssh",
      "-c",
      target.providerResourceName,
      "--config",
    ]);
    const host = validateGitHubSshConfig(sshText, tools.gh, home, target.providerResourceName);
    const configuration = join(home, "ssh-config");
    await writeFile(configuration, sshText, { flag: "wx", mode: 0o600 });
    const fixed = (script: string, input?: AsyncIterable<Uint8Array>, stdin?: Uint8Array) =>
      execute(
        tools.ssh,
        [
          "-F",
          configuration,
          "-o",
          "ControlMaster=no",
          "-o",
          "ControlPath=none",
          "-o",
          "BatchMode=yes",
          host,
          `/bin/sh -c ${quote(script)}`,
        ],
        input,
        stdin,
      );
    const before = z
      .object({
        environmentIdentity: z.string().regex(/^[a-f0-9]{64}$/),
        architecture: z.enum(["x86_64", "aarch64"]),
      })
      .strict()
      .parse(JSON.parse(await fixed(WORKSPACE_PROBE_SCRIPT)));
    const payload = await loadWorkspacePayload(
      payloadDirectory(),
      before.architecture === "x86_64" ? "x64" : "arm64",
    );
    const installed = JSON.parse(
      await fixed(WORKSPACE_INSTALL_SCRIPT, workspaceInstallInput(payload)),
    );
    if (installed.installed !== true || installed.releaseIdentity !== payload.release)
      throw unavailable();
    const measured = z
      .object({
        root: z.string().startsWith("/"),
        rootDevice: z.string().regex(/^[0-9]+$/),
        rootInode: z.string().regex(/^[0-9]+$/),
        environmentIdentity: z.string().regex(/^[a-f0-9]{64}$/),
        release: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(
        JSON.parse(
          await fixed(
            WORKSPACE_GITHUB_PROOF_SCRIPT,
            undefined,
            Buffer.from(
              JSON.stringify({
                resourceId: target.resourceId,
                repositoryId: target.repositoryId,
                repositoryFullName: target.repositoryFullName,
                ...(target.previousRepositoryFullName
                  ? { previousRepositoryFullName: target.previousRepositoryFullName }
                  : {}),
              }),
            ),
          ),
        ),
      );
    const proof = githubProvisionProofSchema.parse({
      requestId: target.requestId,
      resourceGeneration: target.resourceGeneration,
      authorizationGeneration: target.authorizationGeneration,
      providerResourceName: target.providerResourceName,
      repositoryId: target.repositoryId,
      repositoryFullName: target.repositoryFullName,
      ...measured,
    });
    if (
      proof.environmentIdentity !== before.environmentIdentity ||
      proof.release !== payload.release
    )
      throw unavailable();
    const remote = await dependencies.enroll(proof);
    if (
      remote.resourceId !== target.resourceId ||
      remote.resourceGeneration !== target.resourceGeneration ||
      remote.authorizationGeneration !== target.authorizationGeneration ||
      remote.environmentIdentity !== proof.environmentIdentity
    )
      throw unavailable();
    const { renewal, ...credential } = remote;
    const configured = JSON.parse(
      await fixed(
        WORKSPACE_CONFIGURE_SCRIPT,
        undefined,
        Buffer.from(
          JSON.stringify({
            version: 1,
            root: proof.root,
            rootDevice: proof.rootDevice,
            rootInode: proof.rootInode,
            repositoryFullName: target.repositoryFullName,
            resourceId: target.resourceId,
            repositoryId: target.repositoryId,
            ...(target.previousRepositoryFullName
              ? { previousRepositoryFullName: target.previousRepositoryFullName }
              : {}),
            environmentIdentity: proof.environmentIdentity,
            remote: credential,
            ...(renewal ? { renewal } : {}),
          }),
        ),
      ),
    );
    if (
      configured.configured !== true ||
      configured.releaseIdentity !== proof.release ||
      configured.environmentIdentity !== proof.environmentIdentity
    )
      throw unavailable();
    await fixed(WORKSPACE_START_SCRIPT);
    const health = JSON.parse(await fixed(WORKSPACE_HEALTH_SCRIPT));
    if (
      health.releaseIdentity !== proof.release ||
      health.environmentIdentity !== proof.environmentIdentity
    )
      throw unavailable();
    return { proof, health };
  } catch (error) {
    custodyUnconfirmed =
      error instanceof LocalRefusal && error.code === "LOCAL_CUSTODY_UNCONFIRMED";
    throw error instanceof LocalRefusal ? error : unavailable();
  } finally {
    try {
      if (child && !custodyUnconfirmed) await child.dispose();
    } finally {
      if (!custodyUnconfirmed) await rm(home, { recursive: true, force: true });
    }
  }
}
