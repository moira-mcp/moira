import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoDir = path.resolve(process.argv[2] || process.cwd());

// Status and file lists are text proportional to the number of changed paths; the default 1 MiB
// buffer is too small for a large change set, and the build script turns any failure here into a
// silent `unknown`.
const MAX_TEXT_OUTPUT_BYTES = 256 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    maxBuffer: MAX_TEXT_OUTPUT_BYTES,
    ...options,
  });
}

/** Feed a git command's output into the hash as it arrives, without holding it in memory. */
function hashGitOutput(hash, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoDir, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk) => hash.update(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} exited with ${code}`)),
    );
  });
}

const commit = git(["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const status = git(["status", "--porcelain=v1", "--untracked-files=all"], {
  encoding: "utf8",
}).trim();

if (!status) {
  process.stdout.write(commit);
  process.exit(0);
}

const hash = createHash("sha256");
hash.update(commit);
hash.update("\0");
hash.update(status);
hash.update("\0");
// A binary diff can be arbitrarily large (regenerated screenshots), so it is streamed.
await hashGitOutput(hash, ["diff", "--binary", "HEAD"]);

const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean)
  .sort();
for (const relativePath of untracked) {
  const absolutePath = path.join(repoDir, relativePath);
  hash.update(relativePath);
  hash.update("\0");
  if (fs.statSync(absolutePath).isFile()) hash.update(fs.readFileSync(absolutePath));
  hash.update("\0");
}

process.stdout.write(`${commit}-dirty-${hash.digest("hex").slice(0, 16)}`);
