import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  checkoutGuestRepository,
  configureGuestGitIdentity,
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
