import { configureGuestDocker } from "./guest-docker.js";
import { mkdir, readFile, writeFile, access, lstat, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { runProcess } from "./process.js";
import type { WorkspaceRepositoryBinding } from "../../workspace-service/src/server.mjs";
import { z } from "zod";
import { readPrivateOwnerJson } from "../../workspace-service/src/private-json.mjs";
import {
  openDirectory,
  directoryIdentity,
  sameDirectoryIdentity,
  publishDirectoryNoReplace,
  writeDurableJson,
  syncDirectory,
} from "../../workspace-service/src/file-primitives.mjs";
import {
  localGitAuthorSchema,
  type LocalGitAuthor,
} from "../../shared/src/codespaces/local-management-types.js";
import { LOCAL_SETUP_HEADER } from "../../shared/src/codespaces/local-protocol.js";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.js";

const execute = promisify(execFile);

/** Caller Git configuration cannot redirect an owned checkout to another directory. */
function guestGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function requireGuestGitDirectory(
  root: string,
  missingAllowed = false,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = join(root, ".git");
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && missingAllowed) return null;
    throw error;
  });
  if (!metadata) return;
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (await realpath(path)) !== join(await realpath(root), ".git")
  )
    throw Object.assign(new Error("Repository Git directory is not confined; it was preserved"), {
      setupReason: "repository_unproven",
    });
  const expectedRoot = await realpath(root),
    expectedGit = join(expectedRoot, ".git");
  const configPath = join(path, "config");
  const config = await lstat(configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    config &&
    (!config.isFile() ||
      config.isSymbolicLink() ||
      config.uid !== process.getuid?.() ||
      config.nlink !== 1)
  )
    throw Object.assign(
      new Error("Repository Git configuration is not confined; it was preserved"),
      { setupReason: "repository_unproven" },
    );
  try {
    const effective = await execute(
      "git",
      [
        "-C",
        root,
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
        "--show-toplevel",
      ],
      {
        env: guestGitEnvironment(environment),
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    const locations = effective.stdout.trimEnd().split("\n");
    if (
      locations.length !== 3 ||
      (await realpath(locations[0])) !== expectedGit ||
      (await realpath(locations[1])) !== expectedGit ||
      (await realpath(locations[2])) !== expectedRoot
    )
      throw new Error("Git selected another worktree or metadata directory");
  } catch {
    // Git init can publish its config before HEAD. Only this unpublished,
    // nonredirected partial metadata may be completed; existing authority is
    // never repaired by overwriting configuration.
    if (missingAllowed) {
      const authority = await Promise.all(
        ["HEAD", "commondir", "gitdir", "config.worktree"].map(async (name) =>
          lstat(join(path, name)).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          ),
        ),
      );
      if (authority.every((present) => !present)) {
        if (!config) return;
        if (
          config.isFile() &&
          !config.isSymbolicLink() &&
          config.uid === process.getuid?.() &&
          config.nlink === 1
        ) {
          const options = {
            env: guestGitEnvironment(environment),
            timeout: 10_000,
            maxBuffer: 64 * 1024,
          };
          // Let Git parse its own syntax, without following includes. Missing
          // HEAD prevents effective rev-parse, so refuse all indirection here
          // and prove the effective directories again immediately after init.
          const names = await execute(
            "git",
            ["config", "--file", configPath, "--no-includes", "--null", "--name-only", "--list"],
            options,
          );
          const keys = names.stdout
            .split("\0")
            .filter(Boolean)
            .map((key) => key.toLowerCase());
          if (
            !keys.some(
              (key) =>
                key.startsWith("include.") ||
                key.startsWith("includeif.") ||
                key.startsWith("extensions.") ||
                key === "core.worktree",
            )
          ) {
            const bare = await execute(
              "git",
              [
                "config",
                "--file",
                configPath,
                "--no-includes",
                "--type=bool",
                "--get-all",
                "core.bare",
              ],
              options,
            );
            if (
              bare.stdout
                .trim()
                .split("\n")
                .every((value) => value === "false")
            )
              return;
          }
        }
      }
    }
    throw Object.assign(
      new Error("Git worktree or metadata is not confined; configuration was preserved"),
      { setupReason: "repository_unproven" },
    );
  }
}

/** Consume Git output through actual close; only diagnostics are retained as a tail. */
async function runGuestGit(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  setupRequestId?: string,
): Promise<boolean> {
  environment = guestGitEnvironment(environment);
  if (setupRequestId) {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(setupRequestId))
      throw new Error("Invalid fixed setup identity");
    argv = ["-c", `http.extraHeader=${LOCAL_SETUP_HEADER}: ${setupRequestId}`, ...argv];
  }
  let advertised = false;
  const result = await runProcess({
    binary: "git",
    argv,
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    timeoutMs: null,
    maxBytes: 64 * 1024,
    retainOutput: true,
    onStdout: (chunk) => {
      if (/\S/.test(chunk.toString("utf8"))) advertised = true;
    },
  });
  if (result.exitCode !== 0)
    throw Object.assign(new Error("Repository checkout did not complete"), {
      setupReason: "repository_checkout_failed",
    });
  return advertised;
}
export interface GuestBootstrap {
  proxySource: string;
  hostPort: number;
  spaceId: string;
  operationMarker: string;
  brokerToken: string;
  repository: string;
  ref: string;
  clone: boolean;
  gitAuthor?: LocalGitAuthor | null;
  setupRequestId?: string;
}

export async function configureGuestGitIdentity(
  root: string,
  author: LocalGitAuthor,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  environment = guestGitEnvironment(environment);
  await requireGuestGitDirectory(root, false, environment);
  const validated = localGitAuthorSchema.parse(author);
  for (const [key, value] of [
    ["user.name", validated.name],
    ["user.email", validated.email],
  ])
    await execute("git", ["-C", root, "config", "--local", "--", key, value], {
      env: environment,
      timeout: 10000,
      maxBuffer: 65536,
    });
}

/** A successful empty advertisement differs from an unavailable or missing requested ref. */
export async function checkoutGuestRepository(
  root: string,
  ref: string,
  environment: NodeJS.ProcessEnv,
  setupRequestId?: string,
): Promise<void> {
  environment = guestGitEnvironment(environment);
  await requireGuestGitDirectory(root, false, environment);
  const options = { env: environment, timeout: 10_000, maxBuffer: 64 * 1024 };
  const advertised = await runGuestGit(
    ["-C", root, "ls-remote", "--refs", "origin"],
    environment,
    setupRequestId,
  );
  if (!advertised) {
    const branch = ref.replace(/^refs\/heads\//, "");
    if (ref.startsWith("refs/tags/") || /^[a-f0-9]{40}$/.test(ref))
      throw new Error("An empty repository requires an initial branch name");
    await execute("git", ["check-ref-format", "--branch", branch], options);
    await execute("git", ["-C", root, "symbolic-ref", "HEAD", `refs/heads/${branch}`], options);
    return;
  }
  await requireGuestGitDirectory(root, false, environment);
  await runGuestGit(
    ["-C", root, "-c", "core.hooksPath=/dev/null", "fetch", "origin", ref],
    environment,
    setupRequestId,
  );
  const checkout =
    ref.startsWith("refs/tags/") || /^[a-f0-9]{40}$/.test(ref)
      ? ["checkout", "--detach", "FETCH_HEAD"]
      : ["checkout", "-B", ref.replace(/^refs\/heads\//, ""), "FETCH_HEAD"];
  await requireGuestGitDirectory(root, false, environment);
  await runGuestGit(["-C", root, "-c", "core.hooksPath=/dev/null", ...checkout], environment);
}

/** Records the repository the local bootstrap owns; job messages cannot select this binding. */
export async function bindGuestRepository(
  input: Pick<GuestBootstrap, "repository" | "spaceId" | "brokerToken">,
): Promise<WorkspaceRepositoryBinding> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(input.repository) ||
    !/^[a-f0-9-]{36}$/.test(input.spaceId) ||
    !/^[a-f0-9]{64}$/.test(input.brokerToken)
  ) {
    throw new Error("Invalid local repository binding");
  }
  const root = `/workspaces/${input.repository.split("/")[1]}`;
  const metadata = await lstat(root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (await realpath(root)) !== root
  )
    throw new Error("Invalid local repository root");
  const origin = `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437/git/${input.repository}.git`;
  await requireGuestGitDirectory(root);
  const observed = await execute("git", ["-C", root, "remote", "get-url", "origin"], {
    env: guestGitEnvironment(process.env),
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (observed.stdout.trim() !== origin) throw new Error("Local repository origin changed");
  const binding = {
    repositoryFullName: input.repository,
    root,
    origin,
    dev: metadata.dev,
    ino: metadata.ino,
  };
  return binding;
}

const directoryId = z
  .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict();
const preparationSchema = z
  .object({
    version: z.literal(1),
    spaceId: z.string().uuid(),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    repositoryFullName: z.string(),
    root: z.string(),
    origin: z.string(),
    ref: z.string(),
    parent: directoryId,
    stageName: z.string().regex(/^\.moira-setup-[a-f0-9]{32}$/),
    stage: directoryId,
    phase: z.enum(["checkout", "ready", "published"]),
  })
  .strict();
const bindingSchema = z
  .object({
    repositoryFullName: z.string(),
    root: z.string(),
    origin: z.string(),
    dev: z.number().int(),
    ino: z.number().int(),
    setup: preparationSchema.optional(),
  })
  .strict();

/** One private provenance document owns an unpublished checkout and its exact publication. */
export async function prepareGuestRepository(
  input: {
    spaceId: string;
    operationMarker: string;
    repository: string;
    ref: string;
    clone: boolean;
    origin: string;
    workspaces: string;
    directory: string;
    setupRequestId?: string;
  },
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    environment = guestGitEnvironment(environment);
    const targetName = input.repository.split("/")[1];
    if (!targetName || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(targetName))
      throw new Error("Invalid repository destination");
    const root = join(input.workspaces, targetName);
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    const retained = await readPrivateOwnerJson(join(input.directory, "repository.json"));
    const parent = await openDirectory(input.workspaces);
    const parentIdentity = await directoryIdentity(parent);
    try {
      const binding = bindingSchema.safeParse(retained);
      if (binding.success) {
        const value = binding.data;
        if (
          value.repositoryFullName !== input.repository ||
          value.root !== root ||
          value.origin !== input.origin
        )
          throw new Error("Retained repository binding changed");
        if (
          value.setup &&
          (value.setup.spaceId !== input.spaceId ||
            value.setup.operationMarker !== input.operationMarker ||
            value.setup.ref !== input.ref ||
            value.setup.root !== root ||
            value.setup.origin !== input.origin ||
            !sameDirectoryIdentity(value.setup.parent, parentIdentity))
        )
          throw new Error("Published setup provenance changed");
        const opened = await openDirectory({ path: root, dev: value.dev, ino: value.ino });
        try {
          if (
            value.setup &&
            !sameDirectoryIdentity(value.setup.stage, await directoryIdentity(opened))
          )
            throw new Error("Published setup inode changed");
        } finally {
          await opened.close();
        }
        await requireGuestOrigin(root, input.origin, environment);
        // Published branches and user files are never checked out again.
        return root;
      }
      let preparation = retained === null ? undefined : preparationSchema.parse(retained);
      if (
        preparation &&
        (preparation.spaceId !== input.spaceId ||
          preparation.operationMarker !== input.operationMarker ||
          preparation.repositoryFullName !== input.repository ||
          preparation.root !== root ||
          preparation.origin !== input.origin ||
          preparation.ref !== input.ref ||
          !sameDirectoryIdentity(preparation.parent, parentIdentity))
      )
        throw new Error("Retained setup identity changed");
      const target = await lstat(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (target) {
        // The rename may have committed before its published receipt. Only the
        // original ready inode proves this is ours, never matching names/content.
        if (
          !preparation ||
          preparation.phase !== "ready" ||
          String(target.dev) !== preparation.stage.dev ||
          String(target.ino) !== preparation.stage.ino ||
          !target.isDirectory() ||
          target.isSymbolicLink()
        )
          throw new Error("Existing repository is not proven setup output; it was preserved");
      } else {
        if (!input.clone) throw new Error("The bound repository is missing");
        if (!preparation) {
          const stageName = `.moira-setup-${randomBytes(16).toString("hex")}`;
          await mkdir(join(input.workspaces, stageName), { mode: 0o700 });
          await syncDirectory(parent);
          const stage = await openDirectory(input.workspaces, stageName);
          try {
            preparation = {
              version: 1,
              spaceId: input.spaceId,
              operationMarker: input.operationMarker,
              repositoryFullName: input.repository,
              root,
              origin: input.origin,
              ref: input.ref,
              parent: parentIdentity,
              stageName,
              stage: await directoryIdentity(stage),
              phase: "checkout",
            };
            await writeDurableJson(input.directory, "repository.json", preparation);
          } finally {
            await stage.close();
          }
        }
        const stage = await openDirectory(input.workspaces, preparation.stageName);
        try {
          if (!sameDirectoryIdentity(await directoryIdentity(stage), preparation.stage))
            throw new Error("Setup staging directory changed; it was preserved");
          const metadata = await stage.stat();
          if (metadata.uid !== process.getuid?.() || metadata.mode & 0o077)
            throw new Error("Setup staging directory ownership changed; it was preserved");
          // Git follows the held directory, not a replaceable staging pathname.
          const stageRoot =
            process.platform === "linux"
              ? `/proc/${process.pid}/fd/${stage.fd}`
              : join(input.workspaces, preparation.stageName);
          if (preparation.phase === "checkout") {
            // Re-initialization completes an interrupted unpublished git init; it
            // does not remove any file or reset an already published repository.
            await requireGuestGitDirectory(stageRoot, true, environment);
            await runGuestGit(
              ["-c", "core.hooksPath=/dev/null", "init", "--template=", stageRoot],
              environment,
            );
            await requireGuestGitDirectory(stageRoot, false, environment);
            const remotes = await execute("git", ["-C", stageRoot, "remote"], { env: environment });
            if (!remotes.stdout.trim())
              await execute("git", ["-C", stageRoot, "remote", "add", "origin", input.origin], {
                env: environment,
              });
            await requireGuestOrigin(stageRoot, input.origin, environment);
            await checkoutGuestRepository(stageRoot, input.ref, environment, input.setupRequestId);
            preparation = { ...preparation, phase: "ready" };
            await writeDurableJson(input.directory, "repository.json", preparation);
          }
          await publishDirectoryNoReplace(parent, preparation.stageName, targetName, stage).catch(
            (error: unknown) => {
              if ((error as { fileReason?: string }).fileReason === "unsupported")
                throw Object.assign(
                  new Error("Safe directory publication prerequisites are unavailable"),
                  { setupReason: "prerequisite_unavailable" },
                );
              throw error;
            },
          );
        } finally {
          await stage.close();
        }
      }
      if (!preparation) throw new Error("Missing repository setup provenance");
      await requireGuestOrigin(root, input.origin, environment);
      const published = await openDirectory(root);
      try {
        const identity = await directoryIdentity(published);
        if (!sameDirectoryIdentity(identity, preparation.stage))
          throw new Error("Published setup identity changed");
        await writeDurableJson(input.directory, "repository.json", {
          repositoryFullName: input.repository,
          root,
          origin: input.origin,
          dev: Number(identity.dev),
          ino: Number(identity.ino),
          setup: { ...preparation, phase: "published" },
        });
      } finally {
        await published.close();
      }
      return root;
    } finally {
      await parent.close();
    }
  } catch (error) {
    if (error && typeof error === "object" && "setupReason" in error) throw error;
    throw Object.assign(
      new Error("Repository ownership or setup state requires local inspection"),
      { setupReason: "repository_unproven" },
    );
  }
}

async function requireGuestOrigin(root: string, expected: string, environment: NodeJS.ProcessEnv) {
  await requireGuestGitDirectory(root, false, environment);
  const result = await execute("git", ["-C", root, "remote", "get-url", "origin"], {
    env: guestGitEnvironment(environment),
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.stdout.trim() !== expected)
    throw new Error("Repository origin changed; contents were preserved");
}

/** This module is shipped as data and evaluated only by node inside the owned VM. */
export async function bootstrap(input: GuestBootstrap) {
  z.object({
    proxySource: z.string(),
    hostPort: z.number().int().min(1024).max(65535),
    spaceId: z.string().uuid(),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
    brokerToken: z.string().regex(/^[a-f0-9]{64}$/),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    ref: z.string().min(1).max(255),
    clone: z.boolean(),
    gitAuthor: localGitAuthorSchema.nullable().optional(),
    setupRequestId: z.string().regex(WORKSPACE_REQUEST_ID_PATTERN).optional(),
  })
    .strict()
    .parse(input);
  const directory = join(homedir(), ".local", "share", "moira-local");
  if (!input.clone) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: 3437 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) {
      await prepareGuestRepository(
        {
          ...input,
          origin: `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437/git/${input.repository}.git`,
          workspaces: "/workspaces",
          directory,
        },
        {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      );
      const binding = await bindGuestRepository(input);
      const retained = bindingSchema.parse(
        await readPrivateOwnerJson(join(directory, "repository.json")),
      );
      if (
        Object.entries(binding).some(
          ([key, value]) => retained[key as keyof typeof retained] !== value,
        )
      )
        throw new Error("Retained repository binding changed");
      return { repositoryRoot: `/workspaces/${input.repository.split("/")[1]}`, proxyReady: true };
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const proxyPath = join(directory, "proxy.mjs");
  const pidPath = join(directory, "proxy.pid");
  try {
    const pid = Number(await readFile(pidPath, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 1) {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command.split("\0").includes(proxyPath)) {
        process.kill(pid, "SIGTERM");
        for (let attempt = 0; attempt < 40; attempt++) {
          try {
            await access(`/proc/${pid}/cmdline`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
            throw error;
          }
          if (attempt === 39) throw new Error("Previous guest proxy did not stop");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  await writeFile(proxyPath, input.proxySource, { mode: 0o600 });
  const proxy = spawn(process.execPath, [proxyPath, String(input.hostPort)], {
    env: {
      ...process.env,
      MOIRA_LOCAL_PROXY_AUTHORIZATION: `Basic ${Buffer.from(`${input.spaceId}:${input.brokerToken}`).toString("base64")}`,
    },
    detached: true,
    stdio: "ignore",
  });
  let proxyFailed = false;
  proxy.once("error", () => {
    proxyFailed = true;
  });
  proxy.once("exit", () => {
    proxyFailed = true;
  });
  proxy.unref();
  if (!proxy.pid) throw new Error("Guest network proxy could not start");
  await writeFile(pidPath, String(proxy.pid), { mode: 0o600 });
  let connected = false;
  for (let attempt = 0; attempt < 40 && !proxyFailed; attempt++) {
    connected = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: 3437 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!connected || proxyFailed) throw new Error("Guest network proxy is unavailable");
  const proxyUrl = `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437`;
  const environment = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  await writeFile(
    join(directory, "environment.json"),
    JSON.stringify({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    }),
    { mode: 0o600 },
  );
  await configureGuestDocker(proxyUrl, input.spaceId, input.brokerToken);
  const root = `/workspaces/${input.repository.split("/")[1]}`;
  if (input.clone) {
    await execute("sudo", ["-n", "mkdir", "-p", "/workspaces"], { timeout: 10_000 });
    await execute(
      "sudo",
      ["-n", "chown", `${process.getuid!()}:${process.getgid!()}`, "/workspaces"],
      { timeout: 10_000 },
    );
  }
  await prepareGuestRepository(
    {
      ...input,
      origin: `http://${input.spaceId}:${input.brokerToken}@127.0.0.1:3437/git/${input.repository}.git`,
      workspaces: "/workspaces",
      directory,
    },
    environment,
  );
  if (input.gitAuthor) {
    await configureGuestGitIdentity(root, input.gitAuthor, environment);
  }
  await access(root);
  await bindGuestRepository(input);
  return { repositoryRoot: root, proxyReady: true };
}
