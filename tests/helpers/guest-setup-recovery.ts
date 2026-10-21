import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  lstat,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { prepareGuestRepository } from "../../packages/local/src/guest-bootstrap.js";
import {
  openDirectory,
  publishDirectoryNoReplace,
} from "../../packages/workspace-service/src/file-primitives.mjs";

const execute = promisify(execFile);

/** Called inside the existing pinned Linux guest verifier, with its same container and disk. */
export async function verifyGuestSetupRecovery(base: string) {
  let bin: string | undefined;
  try {
    await mkdir(base, { mode: 0o700 });
    const workspaces = join(base, "workspaces"),
      directory = join(base, "private"),
      remote = join(base, "remote.git");
    await mkdir(workspaces);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (...args: string[]) => execute("/usr/bin/git", args, { env });
    await git("init", "--bare", remote);
    const seed = join(base, "seed");
    await git("init", seed);
    await writeFile(join(seed, "README.md"), "original repository\n");
    await git("-C", seed, "add", "README.md");
    await git(
      "-C",
      seed,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Initial",
    );
    await git("-C", seed, "push", remote, "HEAD:main");
    const input = {
      spaceId: randomUUID(),
      operationMarker: `moira-${"a".repeat(24)}`,
      repository: "owner/project",
      ref: "main",
      clone: true,
      origin: remote,
      workspaces,
      directory,
    };
    const receipt = () => readFile(join(directory, "repository.json"), "utf8").then(JSON.parse);
    // A failed real advertisement leaves its original private stage, not a final root.
    await rename(remote, remote + ".held");
    await assert.rejects(
      prepareGuestRepository(input, env),
      (error: unknown) =>
        (error as { setupReason?: string }).setupReason === "repository_checkout_failed",
    );
    const before = await receipt();
    assert.equal(before.phase, "checkout");
    assert.equal(before.operationMarker, input.operationMarker);
    const stagePath = join(workspaces, before.stageName);
    // Reproduce init's config-before-HEAD interruption in this same owned stage.
    // The next preparation must complete metadata, not discard the config.
    const interruptedConfig = await readFile(join(stagePath, ".git", "config"));
    await rm(join(stagePath, ".git", "HEAD"));
    await writeFile(join(stagePath, "user-sentinel"), "preserve unpublished sentinel\n");
    await rename(remote + ".held", remote);
    const foreign = join(base, "foreign");
    await git("init", foreign);
    await writeFile(join(foreign, "sentinel"), "foreign worktree must not change\n");
    const foreignConfig = await readFile(join(foreign, ".git", "config"));
    await rename(join(stagePath, ".git"), join(stagePath, ".git-owned"));
    await symlink(join(foreign, ".git"), join(stagePath, ".git"));
    await assert.rejects(
      prepareGuestRepository(input, env),
      (error: unknown) => (error as { setupReason?: string }).setupReason === "repository_unproven",
    );
    assert.equal((await lstat(join(stagePath, ".git"))).isSymbolicLink(), true);
    assert.deepEqual(await readFile(join(foreign, ".git", "config")), foreignConfig);
    assert.equal(
      await readFile(join(foreign, "sentinel"), "utf8"),
      "foreign worktree must not change\n",
    );
    await rm(join(stagePath, ".git"));
    await rename(join(stagePath, ".git-owned"), join(stagePath, ".git"));
    const stageConfig = await readFile(join(stagePath, ".git", "config"));
    assert.deepEqual(stageConfig, interruptedConfig);
    await git("config", "--file", join(stagePath, ".git", "config"), "core.worktree", foreign);
    const redirectedConfig = await readFile(join(stagePath, ".git", "config"));
    await assert.rejects(
      prepareGuestRepository(input, env),
      (error: unknown) => (error as { setupReason?: string }).setupReason === "repository_unproven",
    );
    assert.deepEqual(await readFile(join(stagePath, ".git", "config")), redirectedConfig);
    assert.deepEqual(await readFile(join(foreign, ".git", "config")), foreignConfig);
    assert.equal(
      await readFile(join(foreign, "sentinel"), "utf8"),
      "foreign worktree must not change\n",
    );
    await writeFile(join(stagePath, ".git", "config"), stageConfig);
    await writeFile(join(stagePath, ".git", "commondir"), join(foreign, ".git") + "\n");
    await assert.rejects(
      prepareGuestRepository(input, env),
      (error: unknown) => (error as { setupReason?: string }).setupReason === "repository_unproven",
    );
    assert.deepEqual(await readFile(join(foreign, ".git", "config")), foreignConfig);
    assert.deepEqual(await readFile(join(stagePath, ".git", "config")), stageConfig);
    await rm(join(stagePath, ".git", "commondir"));

    // Pause only after real git checkout completed. A competing destination then
    // makes the actual no-replace publication fail, preserving both directories.
    // Repository mounts may be noexec. Only this controlled executable belongs
    // on the existing executable HOME mount; all checkout data stays on base.
    bin = await mkdtemp(join(homedir(), ".moira-setup-fixture-git-"));
    const barrier = join(base, "barrier"),
      ready = join(base, "checkout-ready"),
      fifo = join(base, "release");
    await execute("/usr/bin/mkfifo", [fifo]);
    await writeFile(barrier, "hold");
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
/usr/bin/git "$@"
result=$?
if test "$result" -eq 0 && test -f "$MOIRA_FIXTURE_BARRIER"; then
  case " $* " in *" checkout "*)
    : > "$MOIRA_FIXTURE_READY"
    IFS= read -r release < "$MOIRA_FIXTURE_FIFO"
  ;; esac
fi
exit "$result"
`,
      { mode: 0o700 },
    );
    const recoveryEnv = {
      ...env,
      PATH: `${bin}:/usr/bin:/bin`,
      MOIRA_FIXTURE_BARRIER: barrier,
      MOIRA_FIXTURE_READY: ready,
      MOIRA_FIXTURE_FIFO: fifo,
      GIT_DIR: join(foreign, ".git"),
      GIT_WORK_TREE: foreign,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "remote.origin.url",
      GIT_CONFIG_VALUE_0: "/unavailable/ambient.git",
    };
    // Fail explicitly if this executable cannot run, rather than letting PATH
    // skip EACCES and silently choose the uninstrumented system Git.
    await execute(join(bin, "git"), ["--version"], { env: recoveryEnv });
    const preparing = prepareGuestRepository(input, recoveryEnv);
    void preparing.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        void lstat(ready).then(
          () => {
            observer.close();
            resolve();
          },
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") {
              observer.close();
              reject(error);
            }
          },
        );
      };
      const observer = watch(dirname(ready), check);
      observer.unref();
      observer.once("error", reject);
      void preparing.then(
        () => {
          observer.close();
          reject(new Error("Preparation bypassed the real checkout barrier"));
        },
        (error: unknown) => {
          observer.close();
          reject(error);
        },
      );
      check();
    });
    const target = join(workspaces, "project");
    await mkdir(target);
    await writeFile(join(target, "foreign-sentinel"), "preserve occupied target\n");
    const occupied = await lstat(target);
    await rm(barrier);
    await writeFile(fifo, "continue\n");
    await assert.rejects(
      preparing,
      (error: unknown) => (error as { setupReason?: string }).setupReason === "repository_unproven",
    );
    const readyReceipt = await receipt();
    assert.deepEqual(await readFile(join(stagePath, ".git", "config")), interruptedConfig);
    assert.equal(readyReceipt.phase, "ready");
    assert.equal(readyReceipt.stage.ino, before.stage.ino);
    assert.equal((await lstat(target)).ino, occupied.ino);
    assert.equal(
      await readFile(join(target, "foreign-sentinel"), "utf8"),
      "preserve occupied target\n",
    );
    assert.equal(
      await readFile(join(stagePath, "user-sentinel"), "utf8"),
      "preserve unpublished sentinel\n",
    );

    // Model the exact committed-rename/before-receipt interruption with the real
    // primitive and the real ready document. No product test hook is involved.
    await rm(join(target, "foreign-sentinel"));
    await rmdir(target);
    const parent = await openDirectory(workspaces),
      stage = await openDirectory(stagePath);
    try {
      await publishDirectoryNoReplace(parent, readyReceipt.stageName, "project", stage);
    } finally {
      await stage.close();
      await parent.close();
    }
    assert.equal((await receipt()).phase, "ready");
    const published = await lstat(target);
    await prepareGuestRepository(input, env);
    assert.equal((await receipt()).setup.phase, "published");
    assert.equal(String(published.ino), before.stage.ino);
    assert.equal((await lstat(target)).ino, published.ino);
    assert.equal(
      await readFile(join(target, "user-sentinel"), "utf8"),
      "preserve unpublished sentinel\n",
    );
    await git("-C", target, "checkout", "-b", "user-work");
    await writeFile(join(target, "README.md"), "uncommitted user edit\n");
    await prepareGuestRepository(input, env);
    assert.equal(
      (await git("-C", target, "symbolic-ref", "HEAD")).stdout.trim(),
      "refs/heads/user-work",
    );
    assert.equal(await readFile(join(target, "README.md"), "utf8"), "uncommitted user edit\n");
    assert.deepEqual(await readFile(join(foreign, ".git", "config")), foreignConfig);
    assert.equal(
      await readFile(join(foreign, "sentinel"), "utf8"),
      "foreign worktree must not change\n",
    );
    await assert.rejects(
      prepareGuestRepository({ ...input, operationMarker: `moira-${"b".repeat(24)}` }, env),
    );
    assert.equal((await lstat(target)).ino, published.ino);
    return {
      advertisementFailureRetained: true,
      occupiedTargetPreserved: true,
      committedRenameRecovered: true,
      publishedUserBranchPreserved: true,
      foreignGitAndEnvironmentPreserved: true,
    };
  } finally {
    if (bin) await rm(bin, { recursive: true, force: true });
  }
}
