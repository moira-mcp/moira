import { constants } from "node:fs";
import { open, lstat, realpath, copyFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runProcess, processGroupHelperAsset } from "./process.js";
import { LocalRefusal } from "./policy.js";

const version = "2.102.0";
const directory = () => fileURLToPath(new URL("github-toolchain/", import.meta.url));
const refused = () =>
  new LocalRefusal(
    "GITHUB_PROVISIONING_UNAVAILABLE",
    "Trusted GitHub provisioning dependencies are unavailable.",
  );
async function verifiedGh() {
  const base = directory();
  const receiptHandle = await open(
    join(base, "gh.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let receipt;
  try {
    const info = await receiptHandle.stat();
    if (!info.isFile() || info.nlink !== 1) throw refused();
    receipt = JSON.parse(await receiptHandle.readFile("utf8"));
  } finally {
    await receiptHandle.close();
  }
  if (
    receipt.version !== 1 ||
    receipt.platform !== process.platform ||
    receipt.architecture !== process.arch ||
    receipt.ghVersion !== version ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  )
    throw refused();
  const path = join(base, "gh"),
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (await realpath(path)) !== path) throw refused();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (
      hash.digest("hex") !== receipt.sha256 ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw refused();
    return { path, sha256: receipt.sha256 };
  } finally {
    await handle.close();
  }
}
export async function githubToolchain(home: string) {
  const uid = process.getuid?.();
  if (uid === undefined) throw refused();
  const source = await verifiedGh();
  const helper = processGroupHelperAsset(),
    guard = await lstat(helper);
  if (
    !guard.isFile() ||
    guard.isSymbolicLink() ||
    (guard.uid !== uid && guard.uid !== 0) ||
    guard.mode & 0o022 ||
    !(guard.mode & 0o111) ||
    (await realpath(helper)) !== helper
  )
    throw refused();
  const ssh = "/usr/bin/ssh";
  const info = await lstat(ssh);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    info.mode & 0o022 ||
    (await realpath(ssh)) !== ssh
  )
    throw refused();
  const checked = await runProcess({
    binary: ssh,
    argv: ["-V"],
    cwd: home,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    timeoutMs: null,
    maxBytes: null,
  });
  if (checked.exitCode !== 0 || !/^OpenSSH_\d+\.\d+/.test(checked.stderr.toString()))
    throw refused();
  const gh = join(home, "gh");
  await copyFile(source.path, gh, constants.COPYFILE_EXCL);
  await chmod(gh, 0o700);
  const copied = await open(gh, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    for await (const bytes of copied.createReadStream({ autoClose: false })) hash.update(bytes);
    if (hash.digest("hex") !== source.sha256) throw refused();
  } finally {
    await copied.close();
  }
  return { gh, ssh, version };
}
