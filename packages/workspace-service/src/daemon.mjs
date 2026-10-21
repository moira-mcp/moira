import { constants } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import {
  open,
  readFile,
  mkdir,
  rename,
  rm,
  lstat,
  realpath,
  stat,
  readdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { startWorkspaceService } from "./server.mjs";
import { createWorkspaceEngine } from "./engine.mjs";
import { startWorkspaceRemote, WorkspaceAuthorityRefusal } from "./remote.ts";
import { validatedInstalledProxy } from "./tls-transport.mjs";
import { originalGitOrigin, configureOwnerGit } from "./github-config.mjs";
import { startWorkspaceGitBroker, brokerPullRequest } from "./github-broker.mjs";
import { credentialWorkspaceStore } from "./credential-workspace-store.mjs";
import { isOwnerSelector } from "../../shared/src/codespaces/workspace-references.mjs";
import { canonicalJson } from "../../shared/src/utils/canonical-json.ts";
import { createOwnerCommunicationTransport } from "./communication-transport.mjs";
import {
  createWorkspaceRequestId,
  WORKSPACE_REQUEST_ID_PATTERN,
} from "../../shared/src/codespaces/workspace-request-id.mjs";
import {
  workspaceBootstrapCredentialSchema,
  githubProvisionProofSchema,
} from "../../shared/src/codespaces/local-controller-protocol.ts";

const execute = promisify(execFile);
const installation = join(homedir(), ".local/share/moira-workspace");
const stateRoot = join(homedir(), ".local/state/moira/workspace-service");
const socketPath = join(stateRoot, "service.sock");
const configurationPath = join(installation, "config.json");
const ownerPath = join(stateRoot, "daemon.json");

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const value = await lstat(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== process.getuid() ||
    (value.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error("Workspace private directory is unsafe");
}

async function privateJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = await handle.stat();
    if (
      !value.isFile() ||
      value.nlink !== 1 ||
      value.uid !== process.getuid() ||
      (value.mode & 0o077) !== 0 ||
      value.size > 64 * 1024
    )
      throw new Error("Workspace private configuration is unsafe");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function publish(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.next-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const previous = await lstat(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (
      previous &&
      (!previous.isFile() ||
        previous.isSymbolicLink() ||
        previous.nlink !== 1 ||
        previous.uid !== process.getuid())
    )
      throw new Error("Workspace configuration target is unsafe");
    await rename(temporary, path);
    const parent = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function life(binding) {
  return createWorkspaceEngine({ stateRoot, binding }).environmentIdentity();
}

async function releaseIdentity() {
  const bytes = await readFile(new URL("../release.json", import.meta.url));
  const manifest = JSON.parse(bytes);
  if (
    manifest.version !== 1 ||
    manifest.nodeVersion !== "24.21.0" ||
    manifest.libc !== "glibc" ||
    manifest.architecture !== process.arch ||
    process.version !== `v${manifest.nodeVersion}`
  )
    throw new Error("Workspace owned runtime does not match its release");
  return createHash("sha256").update(bytes).digest("hex");
}

const githubRepositorySelectionSchema = githubProvisionProofSchema
  .pick({ repositoryId: true, repositoryFullName: true })
  .extend({
    resourceId: workspaceBootstrapCredentialSchema.shape.resourceId,
    previousRepositoryFullName: githubProvisionProofSchema.shape.repositoryFullName.optional(),
  })
  .strict();
const repositoryName = (origin) =>
  origin
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
const unprovenRebind = () =>
  Object.assign(new Error("The previous guest repository has no matching numeric owner proof."), {
    code: "WORKSPACE_REPOSITORY_REBIND_UNPROVEN",
  });
function numericGitHubOwner(previous, selection, root, metadata) {
  return (
    previous?.github?.repositoryId === selection.repositoryId &&
    previous.ownerSelector?.kind === "github" &&
    previous.ownerSelector.resourceId === selection.resourceId &&
    previous.binding?.root === root &&
    previous.binding.dev === metadata.dev &&
    previous.binding.ino === metadata.ino
  );
}
function approvedGitHubOrigin(previous, selection, root, metadata, origin) {
  const renamed =
    previous &&
    previous.binding.repositoryFullName.toLowerCase() !==
      selection.repositoryFullName.toLowerCase();
  const numericOwner = numericGitHubOwner(previous, selection, root, metadata);
  if (
    renamed &&
    (!numericOwner ||
      selection.previousRepositoryFullName?.toLowerCase() !==
        previous.binding.repositoryFullName.toLowerCase())
  )
    throw unprovenRebind();
  return (
    repositoryName(origin) === selection.repositoryFullName.toLowerCase() ||
    (numericOwner && origin === previous.github.canonicalOrigin)
  );
}

/** Fixed controller inspection of a unique actual repository, never a caller-selected root. */
export async function probeGitHubWorkspace(input) {
  const selection = githubRepositorySelectionSchema.parse(input);
  const previous = await privateJson(configurationPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const matches = [];
  for (const name of await readdir("/workspaces")) {
    const root = join("/workspaces", name),
      metadata = await lstat(root);
    if (previous && previous.binding.root !== root) continue;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid() ||
      (await realpath(root)) !== root
    )
      continue;
    let origin;
    try {
      origin = await originalGitOrigin(root);
    } catch {
      continue;
    }
    if (!approvedGitHubOrigin(previous, selection, root, metadata, origin)) continue;
    const binding = {
      repositoryFullName: selection.repositoryFullName,
      root,
      origin,
      dev: metadata.dev,
      ino: metadata.ino,
    };
    const identity = await lstat(root, { bigint: true });
    matches.push({
      root,
      rootDevice: String(identity.dev),
      rootInode: String(identity.ino),
      environmentIdentity: await life(binding),
      release: await releaseIdentity(),
    });
  }
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].environmentIdentity ?? ""))
    throw new Error("No unique owned GitHub repository root");
  return matches[0];
}

/** Called by the fixed installer, after its exact archive hash was verified. */
export async function configureWorkspace(input) {
  if (
    !input ||
    input.version !== 1 ||
    typeof input.repositoryFullName !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repositoryFullName) ||
    typeof input.root !== "string" ||
    resolve(input.root) !== input.root ||
    (!input.remote && input.mode !== "local-only")
  )
    throw new Error("Invalid workspace bootstrap configuration");
  if (input.expectedRelease !== undefined && input.expectedRelease !== (await releaseIdentity()))
    throw new Error("Workspace measured release changed");
  const previous = await privateJson(configurationPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (input.remote) {
    workspaceBootstrapCredentialSchema.parse(input.remote);
    const origin = new URL(input.remote.origin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      input.remoteState !== undefined
    )
      throw new Error("Invalid workspace remote authority");
  } else if (
    input.remoteState !== undefined &&
    !["unconfigured", "enrollment_unavailable", "refused"].includes(input.remoteState)
  )
    throw new Error("Invalid workspace remote observation");
  const metadata = await lstat(input.root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    (await realpath(input.root)) !== input.root
  )
    throw new Error("Workspace bootstrap repository is unsafe");
  if (input.rootDevice !== undefined || input.rootInode !== undefined) {
    const identity = await lstat(input.root, { bigint: true });
    if (String(identity.dev) !== input.rootDevice || String(identity.ino) !== input.rootInode)
      throw new Error("Workspace measured root changed");
  }
  let origin = (
    await execute("/usr/bin/git", ["-C", input.root, "remote", "get-url", "origin"])
  ).stdout.trim();
  if (input.expectedOrigin !== undefined && origin !== input.expectedOrigin)
    throw new Error("Workspace bootstrap repository origin changed");
  const canonicalOrigin = await originalGitOrigin(input.root);
  let binding = {
    repositoryFullName: input.repositoryFullName,
    root: input.root,
    origin,
    dev: metadata.dev,
    ino: metadata.ino,
  };
  const environmentIdentity = input.environmentIdentity ?? input.remote?.environmentIdentity;
  if (
    !/^[a-f0-9]{64}$/.test(environmentIdentity ?? "") ||
    environmentIdentity !== (await life(binding)) ||
    (input.remote && input.remote.environmentIdentity !== environmentIdentity)
  )
    throw new Error("Workspace bootstrap guest life changed");
  let proxy;
  try {
    const environment = await privateJson(
      join(homedir(), ".local/share/moira-local/environment.json"),
    );
    const target = validatedInstalledProxy(environment.HTTPS_PROXY);
    proxy = target.href;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!input.remote && proxy && input.expectedOrigin === undefined)
    throw new Error("Local-only workspace requires its installed Local repository binding");
  const ownerSelector =
    input.ownerSelector ??
    (!proxy && input.remote ? { kind: "github", resourceId: input.remote.resourceId } : undefined);
  if (
    !isOwnerSelector(ownerSelector) ||
    (proxy
      ? ownerSelector.kind !== "local"
      : ownerSelector.kind !== "github" ||
        ownerSelector.resourceId !== input.resourceId ||
        (input.remote && ownerSelector.resourceId !== input.remote.resourceId)) ||
    (previous?.ownerSelector &&
      canonicalJson(previous.ownerSelector) !== canonicalJson(ownerSelector))
  )
    throw new Error("Workspace original owner selector changed or is unavailable");
  if (
    !proxy &&
    !input.remote &&
    (input.rootDevice === undefined ||
      input.rootInode === undefined ||
      input.expectedRelease === undefined)
  )
    throw new Error("Credential-free GitHub configuration requires its complete measured proof");
  if (
    input.expectedOrigin === undefined &&
    (proxy || !input.remote) &&
    repositoryName(canonicalOrigin) !== input.repositoryFullName.toLowerCase()
  )
    throw new Error("Workspace bootstrap repository identity changed");
  let github;
  if (!proxy && canonicalOrigin) {
    const selection = githubRepositorySelectionSchema.parse({
      resourceId: input.resourceId,
      repositoryId: input.repositoryId,
      repositoryFullName: input.repositoryFullName,
      ...(input.previousRepositoryFullName
        ? { previousRepositoryFullName: input.previousRepositoryFullName }
        : {}),
    });
    if (selection.resourceId !== ownerSelector.resourceId) throw unprovenRebind();
    if (
      previous &&
      (previous.binding.root !== input.root ||
        previous.binding.dev !== metadata.dev ||
        previous.binding.ino !== metadata.ino)
    )
      throw new Error("Previous Git owner binding changed");
    if (!approvedGitHubOrigin(previous, selection, input.root, metadata, canonicalOrigin))
      throw new Error("Workspace bootstrap repository identity changed");
    if (
      numericGitHubOwner(previous, selection, input.root, metadata) &&
      previous.github.repositoryFullName === input.repositoryFullName &&
      previous.github.canonicalOrigin === canonicalOrigin
    ) {
      github = previous.github;
      origin = github.brokerOrigin;
    } else {
      const capability = randomBytes(32).toString("hex");
      origin = `http://${ownerSelector.resourceId}:${capability}@127.0.0.1:3437/git/${input.repositoryFullName}.git`;
      github = {
        repositoryId: selection.repositoryId,
        repositoryFullName: input.repositoryFullName,
        canonicalOrigin,
        brokerOrigin: origin,
        authorization: `Basic ${Buffer.from(`${ownerSelector.resourceId}:${capability}`).toString("base64")}`,
      };
    }
    await configureOwnerGit(input.root, canonicalOrigin, origin, previous?.github);
    binding = { ...binding, origin, canonicalOrigin };
  }
  await publish(configurationPath, {
    version: 1,
    binding,
    ownerSelector,
    environmentIdentity,
    ...(proxy ? { proxy } : {}),
    ...(!input.remote ? { remoteState: input.remoteState ?? "unconfigured" } : {}),
    ...(github ? { github } : {}),
    ...(input.remote ? { remote: { ...input.remote, ...(proxy ? { proxy } : {}) } } : {}),
    ...(input.renewal
      ? {
          renewal: workspaceBootstrapCredentialSchema.parse({
            ...input.remote,
            renewal: input.renewal,
          }).renewal,
        }
      : {}),
    releaseIdentity: await releaseIdentity(),
  });
  // This fixed local request carries no credentials or selected paths. The
  // existing owner re-observes its private published configuration itself.
  const running = await health().catch((error) => {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    return null;
  });
  if (
    running?.releaseIdentity === (await releaseIdentity()) &&
    running.repositoryFullName === input.repositoryFullName
  )
    await health("POST", "/v1/configuration/reload");
  return {
    configured: true,
    releaseIdentity: await releaseIdentity(),
    environmentIdentity: await life(binding),
  };
}

async function workspaceRenewalProof(config, release) {
  if (
    !config.github ||
    config.proxy ||
    !config.remote ||
    !config.renewal ||
    config.releaseIdentity !== release
  )
    throw new Error("Workspace cold boot enrollment unavailable");
  workspaceBootstrapCredentialSchema.parse({ ...config.remote, renewal: config.renewal });
  const root = config.binding.root,
    identity = await lstat(root, { bigint: true });
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== BigInt(process.getuid()) ||
    (await realpath(root)) !== root ||
    Number(identity.dev) !== config.binding.dev ||
    Number(identity.ino) !== config.binding.ino
  )
    throw new Error("Workspace cold boot root changed");
  const environmentIdentity = await life(config.binding);
  if (!/^[a-f0-9]{64}$/.test(environmentIdentity ?? ""))
    throw new Error("Workspace cold boot life unavailable");
  await createWorkspaceEngine({ stateRoot, binding: config.binding }).verifyBinding();
  return {
    environmentIdentity,
    root,
    rootDevice: String(identity.dev),
    rootInode: String(identity.ino),
    release,
  };
}

/** Cold boot repeats only its durably recorded enrollment security request, never VM or command work. */
export async function renewWorkspaceConfiguration(config, release, signal) {
  const body = await workspaceRenewalProof(config, release);
  const { environmentIdentity } = body;
  const installed = workspaceBootstrapCredentialSchema.parse({
    ...config.remote,
    renewal: config.renewal,
  });
  const requestPath = join(stateRoot, `renewal-${environmentIdentity}.json`);
  let original = await privateJson(requestPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!original) {
    original = { requestId: createWorkspaceRequestId(), ...body };
    await publish(requestPath, original);
  }
  if (
    Object.keys(original).length !== 6 ||
    typeof original.requestId !== "string" ||
    !WORKSPACE_REQUEST_ID_PATTERN.test(original.requestId) ||
    !Object.entries(body).every(([key, value]) => original[key] === value)
  )
    throw new WorkspaceAuthorityRefusal("Workspace original enrollment request changed");
  const origin = new URL(installed.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new WorkspaceAuthorityRefusal("Workspace enrollment origin invalid");
  const response = await globalThis.fetch(
    new URL(`/api/codespaces/github/resources/${installed.resourceId}/renew-enrollment`, origin),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${installed.renewal.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(original),
      redirect: "error",
      signal,
    },
  );
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new WorkspaceAuthorityRefusal("Workspace renewal authority refused");
    throw new Error("Workspace enrollment outcome unconfirmed");
  }
  const remote = workspaceBootstrapCredentialSchema.parse(await response.json());
  if (
    remote.resourceId !== installed.resourceId ||
    remote.resourceGeneration !== installed.resourceGeneration ||
    remote.authorizationGeneration !== installed.authorizationGeneration ||
    remote.environmentIdentity !== environmentIdentity ||
    remote.origin !== installed.origin ||
    remote.publicOrigin !== installed.publicOrigin ||
    remote.renewal?.credential !== installed.renewal.credential
  )
    throw new WorkspaceAuthorityRefusal("Workspace enrollment authority changed");
  if (
    canonicalJson(await workspaceRenewalProof(config, release)) !== canonicalJson(body) ||
    canonicalJson(await privateJson(configurationPath)) !== canonicalJson(config) ||
    signal?.aborted
  )
    throw new WorkspaceAuthorityRefusal("Workspace renewal binding changed");
  const { renewal, ...credential } = remote;
  const next = { ...config, environmentIdentity, remote: credential, renewal };
  delete next.renewalPending;
  delete next.remoteState;
  await publish(configurationPath, next);
  return next;
}

function health(method = "GET", path = "/v1/health") {
  return new Promise((done, failed) => {
    const call = request({ socketPath, method, path, agent: false }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) response.destroy(new Error("Invalid workspace health response"));
        else chunks.push(chunk);
      });
      response.once("error", failed);
      response.once("end", () => {
        if (response.statusCode !== 200) {
          failed(new Error("Workspace service is unavailable"));
          return;
        }
        try {
          done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          failed(error);
        }
      });
    });
    call.once("error", failed);
    call.end();
  });
}

async function processStart(pid) {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = value.slice(value.lastIndexOf(") ") + 2).split(" ");
  if (["Z", "X"].includes(fields[0])) return null;
  const start = fields[19];
  if (!/^[0-9]+$/.test(start ?? "")) throw new Error("Workspace process identity is unavailable");
  return start;
}

/** Replace only this owned observer. Admitted detached commands are never signalled here. */
async function stopOwnedService() {
  const owner = await privateJson(ownerPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!owner) return;
  const config = await privateJson(configurationPath);
  if (owner.environmentIdentity !== (await life(config.binding))) return;
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 2 ||
    typeof owner.program !== "string" ||
    !owner.program.startsWith(`${installation}/releases/`) ||
    !owner.program.endsWith("/service/daemon.mjs") ||
    !/^[0-9]+$/.test(owner.startTime ?? "")
  )
    throw new Error("Invalid workspace owner receipt");
  const identity = async () => {
    try {
      const cmdline = (await readFile(`/proc/${owner.pid}/cmdline`)).toString("utf8").split("\0");
      const startTime = await processStart(owner.pid);
      if (startTime === null) return false;
      if (startTime !== owner.startTime || !cmdline.includes(owner.program))
        throw new Error("Workspace daemon process identity changed");
      return true;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return false;
      throw error;
    }
  };
  if (!(await identity())) return;
  process.kill(owner.pid, "SIGTERM");
  while (await identity()) await new Promise((done) => setTimeout(done, 25));
}

async function serve() {
  let config = await privateJson(configurationPath);
  const release = await releaseIdentity();
  if (config.environmentIdentity !== (await life(config.binding))) {
    if (config.proxy)
      throw new Error(
        "Local workspace life changed; the host owner must refresh its fixed binding",
      );
    const proof = await workspaceRenewalProof(config, release);
    config = { ...config, environmentIdentity: proof.environmentIdentity, renewalPending: true };
    await publish(configurationPath, config);
  }
  if (
    config.version !== 1 ||
    !isOwnerSelector(config.ownerSelector) ||
    config.releaseIdentity !== release ||
    config.environmentIdentity !== (await life(config.binding))
  )
    throw new Error("Workspace service configuration no longer matches this release and guest");
  if (config.proxy) {
    const proxy = validatedInstalledProxy(config.proxy);
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
      process.env[name] = proxy.href;
    process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1,::1";
  }
  await privateDirectory(stateRoot);
  const verifyExclusiveOwner = async () => {
    if (process.platform !== "linux") return false;
    try {
      const owner = await privateJson(ownerPath);
      if (
        owner.pid !== process.pid ||
        owner.startTime !== (await processStart(process.pid)) ||
        owner.environmentIdentity !== config.environmentIdentity ||
        owner.program !== fileURLToPath(import.meta.url)
      )
        return false;
      // startOwnedService passes the daemon.lock descriptor as FD4 through the
      // fixed shell's flock+exec. fdinfo reports locks of this open description.
      const descriptor = await stat("/proc/self/fd/4");
      const named = await lstat(join(stateRoot, "daemon.lock"));
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.uid !== process.getuid() ||
        named.mode & 0o077 ||
        descriptor.dev !== named.dev ||
        descriptor.ino !== named.ino
      )
        return false;
      const info = await readFile("/proc/self/fdinfo/4", "utf8");
      return info
        .split("\n")
        .some((line) => /^lock:\s+\S+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/.test(line));
    } catch {
      return false;
    }
  };
  const githubBroker = config.github
    ? await startWorkspaceGitBroker(
        config.github,
        config.renewalPending ? undefined : config.remote,
        credentialWorkspaceStore(stateRoot),
        verifyExclusiveOwner,
      )
    : null;
  const gitProxy = config.proxy ?? config.github?.brokerOrigin;
  let service, remote;
  let closing;
  let reloading = Promise.resolve();
  const remoteConfiguration = (value) =>
    value.remote && !value.renewalPending
      ? {
          publicationScope: {
            resourceId: value.remote.resourceId,
            resourceGeneration: value.remote.resourceGeneration,
            authorizationGeneration: value.remote.authorizationGeneration,
            publicOrigin: value.remote.publicOrigin ?? value.remote.origin,
          },
          communicationTransport: createOwnerCommunicationTransport({
            origin: value.remote.origin,
            credential: value.remote.credential,
            proxy: value.proxy,
          }),
        }
      : {};
  const reloadConfiguration = () => {
    const work = reloading.then(async () => {
      if (closing) throw new Error("Workspace owner is closing");
      const next = await privateJson(configurationPath);
      if (
        next.version !== 1 ||
        next.releaseIdentity !== release ||
        next.environmentIdentity !== config.environmentIdentity ||
        JSON.stringify(next.binding) !== JSON.stringify(config.binding) ||
        !isOwnerSelector(next.ownerSelector) ||
        canonicalJson(next.ownerSelector) !== canonicalJson(config.ownerSelector) ||
        next.proxy !== config.proxy ||
        JSON.stringify(next.github) !== JSON.stringify(config.github) ||
        next.environmentIdentity !== (await life(next.binding))
      )
        throw new Error("Running workspace configuration identity changed");
      await createWorkspaceEngine({ stateRoot, binding: next.binding }).verifyBinding();
      if (next.remote) {
        const credential = { ...next.remote };
        delete credential.proxy;
        const checked = workspaceBootstrapCredentialSchema.parse(credential);
        if (
          checked.environmentIdentity !== next.environmentIdentity ||
          (config.remote &&
            (checked.resourceId !== config.remote.resourceId ||
              checked.origin !== config.remote.origin))
        )
          throw new Error("Running workspace remote authority changed owner");
      }
      if (
        JSON.stringify(next.remote) === JSON.stringify(config.remote) &&
        next.remoteState === config.remoteState
      )
        return;
      await service.owner.configureRemote(remoteConfiguration(next));
      githubBroker?.configureRemote(next.remote);
      await remote?.close();
      remote = undefined;
      config = next;
      if (next.remote) remote = startWorkspaceRemote({ socketPath, ...next.remote });
    });
    reloading = work.catch(() => undefined);
    return work;
  };
  try {
    service = await startWorkspaceService({
      socketPath,
      stateRoot,
      binding: config.binding,
      ownerSelector: config.ownerSelector,
      releaseIdentity: release,
      searchExecutable: fileURLToPath(new URL("../runtime/bin/rg", import.meta.url)),
      sourceProxy: config.proxy,
      remoteStatus: () => remote?.status() ?? { state: config.remoteState ?? "unconfigured" },
      reloadConfiguration,
      ...(githubBroker ? { collectCredentialRequest: githubBroker.collect } : {}),
      ...(gitProxy
        ? { pullRequest: (action, input) => brokerPullRequest(gitProxy, action, input) }
        : {}),
      ...remoteConfiguration(config),
    });
    if (config.remote)
      remote = startWorkspaceRemote({
        socketPath,
        ...config.remote,
        environmentIdentity: config.environmentIdentity,
        ...(config.renewalPending
          ? {
              prepareCredential: async (signal) => {
                if (!config.renewalPending) return config.remote.credential;
                let next;
                try {
                  next = await renewWorkspaceConfiguration(config, release, signal);
                } catch (error) {
                  if (error instanceof WorkspaceAuthorityRefusal || signal.aborted) throw error;
                  // Local identity failure cannot become another enrollment proof.
                  await workspaceRenewalProof(config, release).catch(() => {
                    throw new WorkspaceAuthorityRefusal("Workspace renewal binding changed");
                  });
                  throw error;
                }
                await service.owner.configureRemote(remoteConfiguration(next));
                githubBroker?.configureRemote(next.remote);
                config = next;
                return next.remote.credential;
              },
            }
          : {}),
      });
    const owner = {
      pid: process.pid,
      startTime: await processStart(process.pid),
      program: fileURLToPath(import.meta.url),
      releaseIdentity: release,
      environmentIdentity: await life(config.binding),
    };
    await publish(ownerPath, owner);
    const close = () =>
      (closing ??= (async () => {
        await reloading;
        await remote?.close();
        await service.close();
        await githubBroker?.close();
        const current = await privateJson(ownerPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (JSON.stringify(current) === JSON.stringify(owner)) await rm(ownerPath);
      })());
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        void close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    const ready = await health();
    if (ready.releaseIdentity !== release)
      throw new Error("Workspace service release is not current");
    if (process.connected)
      process.send({ type: "workspace-service-ready", health: ready }, () => {});
    process.stdout.write(
      `${JSON.stringify({ workspaceService: "ready", releaseIdentity: release })}\n`,
    );
  } catch (error) {
    const cleanup = await Promise.allSettled([
      remote?.close(),
      service?.close(),
      githubBroker?.close(),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        [error, ...failures.map((result) => result.reason)],
        "Workspace startup and cleanup failed",
      );
    throw error;
  }
}

async function startOwnedService(foreground = false) {
  await privateDirectory(stateRoot);
  const release = await releaseIdentity();
  const ownedFile = async (path, flags) => {
    const handle = await open(
      path,
      flags | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const info = await handle.stat();
      const named = await lstat(path);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0 ||
        named.dev !== info.dev ||
        named.ino !== info.ino
      )
        throw new Error("Workspace startup file is unsafe");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  const lock = await ownedFile(join(stateRoot, "daemon.lock"), constants.O_RDWR);
  let log;
  try {
    if (!foreground)
      log = await ownedFile(join(stateRoot, "daemon.log"), constants.O_WRONLY | constants.O_APPEND);
    // The fixed shell claims the inherited descriptor, then execs the daemon
    // while preserving the private IPC channel and held kernel lock. The
    // controller waits for actual readiness or child failure, then leaves this
    // detached owner alive without retaining its IPC handle.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        '/usr/bin/flock --exclusive --nonblock 4 || exit $?; exec "$1" "$2"',
        "sh",
        process.execPath,
        fileURLToPath(import.meta.url),
      ],
      {
        detached: !foreground,
        stdio: foreground
          ? ["ignore", "inherit", "inherit", "ipc", lock.fd]
          : ["ignore", log.fd, log.fd, "ipc", lock.fd],
        env: process.env,
      },
    );
    const ended = foreground
      ? new Promise((done) => child.once("close", (code) => done(code)))
      : null;
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Workspace service exited before readiness")));
      child.on("message", (message) => {
        if (
          message?.type === "workspace-service-ready" &&
          message.health?.releaseIdentity === release
        )
          done(message.health);
      });
    });
    if (foreground) {
      const stop = () => child.kill("SIGTERM");
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      try {
        if ((await ended) !== 0) throw new Error("Workspace foreground owner failed");
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    } else {
      if (child.connected) child.disconnect();
      child.unref();
    }
    return result;
  } finally {
    await log?.close();
    await lock.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--github-proof") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(`${JSON.stringify(await probeGitHubWorkspace(input))}\n`);
    } else if (process.argv[2] === "--configure") {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error("Workspace bootstrap metadata is too large");
        chunks.push(chunk);
      }
      process.stdout.write(
        `${JSON.stringify(await configureWorkspace(JSON.parse(Buffer.concat(chunks).toString("utf8"))))}\n`,
      );
    } else if (process.argv[2] === "--stop") await stopOwnedService();
    else if (process.argv[2] === "--foreground") await startOwnedService(true);
    else if (process.argv[2] === "--start-if-configured") {
      const configured = await privateJson(configurationPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (configured) {
        const running = await health().catch(() => null);
        if (
          running?.releaseIdentity === (await releaseIdentity()) &&
          running?.environmentIdentity === (await life(configured.binding)) &&
          running?.repositoryFullName === configured.binding.repositoryFullName
        )
          process.stdout.write(`${JSON.stringify(running)}\n`);
        else {
          // A new payload replaces only the proved owned service observer.
          // A same-release lost reply never stops the existing Unix owner.
          if (running) await stopOwnedService();
          process.stdout.write(`${JSON.stringify(await startOwnedService())}\n`);
        }
      } else
        process.stdout.write(`${JSON.stringify({ workspaceService: "enrollment-required" })}\n`);
    } else if (process.argv[2] === "--start") {
      process.stdout.write(`${JSON.stringify(await startOwnedService())}\n`);
    } else if (process.argv[2] === "--health") {
      const result = await health();
      if (result.releaseIdentity !== (await releaseIdentity()))
        throw new Error("Workspace service release is not current");
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (process.argv.length === 2) await serve();
    else throw new Error("Unknown fixed workspace service action");
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error?.code === "WORKSPACE_REPOSITORY_REBIND_UNPROVEN" ? error.code : "WORKSPACE_SERVICE_UNAVAILABLE" })}\n`,
    );
    process.exitCode = 1;
  }
}
