import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  checkoutGuestRepository,
  configureGuestGitIdentity,
  prepareGuestRepository,
} from "../../../packages/local/src/guest-bootstrap.js";
const run = promisify(execFile);
let root: string, remote: string, clone: string;
const environment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ml-empty-")));
  remote = join(root, "remote.git");
  clone = join(root, "clone");
  await run("git", ["init", "--bare", remote], { env: environment });
  await run("git", ["clone", "--no-checkout", remote, clone], { env: environment });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("Guest initialization of a proven empty repository", () => {
  test("identity configuration refuses a linked local config without changing foreign bytes", async () => {
    const foreignConfig = join(root, "foreign-config");
    const original = await readFile(join(clone, ".git", "config"));
    await writeFile(foreignConfig, original);
    await rm(join(clone, ".git", "config"));
    await symlink(foreignConfig, join(clone, ".git", "config"));
    const outcome = await configureGuestGitIdentity(
      clone,
      { name: "Changed", email: "changed@example.invalid" },
      environment,
    ).catch((error: unknown) => error);
    expect(await readFile(foreignConfig)).toEqual(original);
    expect(outcome).toMatchObject({ setupReason: "repository_unproven" });
  });
  test("interrupted init with benign owned config before HEAD resumes in the same private stage", async () => {
    const workspaces = join(root, "workspaces"),
      directory = join(root, "private");
    await mkdir(workspaces);
    const input = {
      spaceId: randomUUID(),
      operationMarker: `moira-${"a".repeat(24)}`,
      repository: "owner/project",
      ref: "main",
      clone: true,
      origin: join(root, "unavailable.git"),
      workspaces,
      directory,
    };
    await expect(prepareGuestRepository(input, environment)).rejects.toMatchObject({
      setupReason: "repository_checkout_failed",
    });
    const before = JSON.parse(await readFile(join(directory, "repository.json"), "utf8"));
    const gitDirectory = join(workspaces, before.stageName, ".git");
    const config = await readFile(join(gitDirectory, "config")),
      head = await readFile(join(gitDirectory, "HEAD"));
    await rm(join(gitDirectory, "HEAD"));
    // The next actual Git advertisement still fails; reaching that same stage
    // proves init recovered its own metadata rather than guessing another root.
    await expect(prepareGuestRepository(input, environment)).rejects.toMatchObject({
      setupReason: "repository_checkout_failed",
    });
    expect(await readFile(join(gitDirectory, "HEAD"))).toEqual(head);
    expect(await readFile(join(gitDirectory, "config"))).toEqual(config);
    expect(JSON.parse(await readFile(join(directory, "repository.json"), "utf8"))).toEqual(before);
  });
  test.each(["worktree", "common-dir"] as const)(
    "redirected Git %s is refused without touching foreign files or either configuration",
    async (redirect) => {
      await writeFile(join(clone, "remote-owned.txt"), "remote bytes\n");
      await run("git", ["-C", clone, "add", "remote-owned.txt"], { env: environment });
      await run(
        "git",
        [
          "-C",
          clone,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "Fixture",
        ],
        { env: environment },
      );
      await run("git", ["-C", clone, "push", "origin", "HEAD:main"], { env: environment });
      const stage = join(root, "stage"),
        foreign = join(root, "foreign");
      await run("git", ["clone", "--no-checkout", remote, stage], { env: environment });
      await mkdir(foreign);
      await run("git", ["init", foreign], { env: environment });
      await writeFile(join(foreign, "sentinel"), "preserve foreign bytes\n");
      if (redirect === "worktree")
        await run("git", ["-C", stage, "config", "core.worktree", foreign], { env: environment });
      else await writeFile(join(stage, ".git", "commondir"), join(foreign, ".git") + "\n");
      const config = await readFile(join(stage, ".git", "config"));
      const foreignConfig = await readFile(join(foreign, ".git", "config"));
      const outcome = await (
        redirect === "worktree"
          ? checkoutGuestRepository(stage, "main", environment)
          : configureGuestGitIdentity(
              stage,
              { name: "Changed", email: "changed@example.invalid" },
              environment,
            )
      ).then(
        () => ({ ok: true }),
        (error) => error,
      );
      expect(await readFile(join(foreign, ".git", "config"))).toEqual(foreignConfig);
      await expect(readFile(join(foreign, "remote-owned.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("preserve foreign bytes\n");
      expect(await readFile(join(stage, ".git", "config"))).toEqual(config);
      expect(outcome).toMatchObject({ setupReason: "repository_unproven" });
    },
  );
  test("an explicit local worktree resolving to the same proved root remains usable", async () => {
    await run("git", ["-C", clone, "config", "core.worktree", clone], { env: environment });
    await checkoutGuestRepository(clone, "main", environment);
    expect(
      (await run("git", ["-C", clone, "symbolic-ref", "HEAD"], { env: environment })).stdout.trim(),
    ).toBe("refs/heads/main");
  });
  test("a complete large ref advertisement still checks out the requested branch", async () => {
    await run(
      "git",
      [
        "-C",
        clone,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Existing",
      ],
      { env: environment },
    );
    await run("git", ["-C", clone, "push", "origin", "HEAD:main"], { env: environment });
    const commit = (
      await run("git", ["-C", clone, "rev-parse", "HEAD"], { env: environment })
    ).stdout.trim();
    const refs = Array.from(
      { length: 18_000 },
      (_, index) => `${commit} refs/tags/${String(index).padStart(90, "r")}\n`,
    )
      .sort()
      .join("");
    expect(Buffer.byteLength(refs)).toBeGreaterThan(1024 * 1024);
    await writeFile(join(remote, "packed-refs"), "# pack-refs with: sorted\n" + refs);
    await checkoutGuestRepository(clone, "main", environment);
    expect(
      (await run("git", ["-C", clone, "symbolic-ref", "HEAD"], { env: environment })).stdout.trim(),
    ).toBe("refs/heads/main");
    expect(
      (await run("git", ["-C", clone, "rev-parse", "HEAD"], { env: environment })).stdout.trim(),
    ).toBe(commit);
  });
  test("a failed advertisement is not interpreted as an empty repository", async () => {
    await run("git", ["-C", clone, "remote", "set-url", "origin", join(root, "absent.git")], {
      env: environment,
    });
    await expect(checkoutGuestRepository(clone, "main", environment)).rejects.toThrow();
    await expect(
      run("git", ["-C", clone, "show-ref", "--verify", "refs/heads/main"], { env: environment }),
    ).rejects.toThrow();
  });
  test("sets an unborn main branch and supports first commit, push, feature commit without host Git identity", async () => {
    await checkoutGuestRepository(clone, "main", environment);
    expect(
      (await run("git", ["-C", clone, "symbolic-ref", "HEAD"], { env: environment })).stdout.trim(),
    ).toBe("refs/heads/main");
    await configureGuestGitIdentity(
      clone,
      { name: "fixture-login", email: "123+fixture-login@users.noreply.github.com" },
      environment,
    );
    await writeFile(join(clone, "README.md"), "Owned first commit\n");
    await run("git", ["-C", clone, "add", "README.md"], { env: environment });
    await run("git", ["-C", clone, "commit", "-m", "Initial main"], { env: environment });
    await run("git", ["-C", clone, "push", "origin", "main"], { env: environment });
    expect(
      (await run("git", ["--git-dir", remote, "show", "main:README.md"], { env: environment }))
        .stdout,
    ).toBe("Owned first commit\n");
    expect(
      (
        await run("git", ["-C", clone, "show", "-s", "--format=%an|%ae"], { env: environment })
      ).stdout.trim(),
    ).toBe("fixture-login|123+fixture-login@users.noreply.github.com");
    await run("git", ["-C", clone, "checkout", "-b", "feature"], { env: environment });
    await writeFile(join(clone, "feature.txt"), "Feature\n");
    await run("git", ["-C", clone, "add", "feature.txt"], { env: environment });
    await run("git", ["-C", clone, "commit", "-m", "Feature"], { env: environment });
    await run("git", ["-C", clone, "push", "origin", "feature"], { env: environment });
    expect(
      (
        await run("git", ["--git-dir", remote, "rev-list", "--count", "main..feature"], {
          env: environment,
        })
      ).stdout.trim(),
    ).toBe("1");
  });
  test("nonempty missing requested branch remains an error rather than empty bootstrap", async () => {
    await run(
      "git",
      [
        "-C",
        clone,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Existing",
      ],
      { env: environment },
    );
    await run("git", ["-C", clone, "push", "origin", "HEAD:main"], { env: environment });
    await expect(checkoutGuestRepository(clone, "missing", environment)).rejects.toThrow();
    expect(
      (
        await run("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], {
          env: environment,
        })
      ).stdout.trim(),
    ).toBe("refs/heads/main");
  });
});
