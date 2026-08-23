import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoDir = path.resolve(process.argv[2] || process.cwd());

function git(args, options = {}) {
  return execFileSync("git", ["-C", repoDir, ...args], options);
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
hash.update(git(["diff", "--binary", "HEAD"]));

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
