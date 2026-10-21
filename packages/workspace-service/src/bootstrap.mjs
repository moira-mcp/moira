import { constants } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";

/** A provider runs this fixed program, never a caller-selected shell command. */
export const WORKSPACE_INSTALL_SCRIPT = String.raw`set -eu
PATH=/usr/bin:/bin
export PATH
umask 077
IFS=' ' read -r release archive_sha architecture bytes
case "$release:$archive_sha" in *[!a-f0-9:]*) echo 'Invalid workspace payload header' >&2; exit 1;; esac
case "$bytes" in ''|*[!0-9]*) exit 1;; esac
test "${"$"}{#release}" = 64 && test "${"$"}{#archive_sha}" = 64
case "$architecture" in x64) machine=x86_64;; arm64) machine=aarch64;; *) exit 1;; esac
test "$(uname -s)" = Linux && test "$(uname -m)" = "$machine"
libc=$(getconf GNU_LIBC_VERSION)
test "${"$"}{libc%% *}" = glibc
printf '%s\n' "$libc" | awk '{split($2,v,".");if(v[1]<2||(v[1]==2&&v[2]<28))exit 1}'
base="$HOME/.local/share/moira-workspace"
for directory in "$HOME/.local" "$HOME/.local/share" "$base" "$base/releases" "$HOME/.local/bin"; do
  test ! -L "$directory"
  mkdir -p "$directory"
  test "$(stat -c %u "$directory")" = "$(id -u)"
  test "$(realpath "$directory")" = "$directory"
done
chmod 700 "$base" "$base/releases"
lock="$base/install.lock"
test ! -L "$lock"
if test -e "$lock"; then
  test -f "$lock" && test "$(stat -c %h "$lock")" = 1 && test "$(stat -c %u "$lock")" = "$(id -u)"
fi
exec 9>"$lock"
flock --exclusive 9
temporary=$(mktemp -d "$base/.install-XXXXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
cat >"$temporary/payload.tar.gz"
test "$(wc -c <"$temporary/payload.tar.gz" | tr -d ' ')" = "$bytes"
test "$(sha256sum "$temporary/payload.tar.gz" | cut -d ' ' -f1)" = "$archive_sha"
tar -tzf "$temporary/payload.tar.gz" >"$temporary/names"
test -z "$(sort "$temporary/names" | uniq -d)"
while IFS= read -r name; do
  case "$name" in /*|../*|*/../*|*/..|./*|*/./*|*//*) echo 'Unsafe workspace archive member' >&2; exit 1;; esac
  case "$name" in runtime/|runtime/bin/|runtime/ripgrep/|service/|runtime/bin/node|runtime/bin/rg|runtime/LICENSE|runtime/ripgrep/LICENSE-MIT|runtime/ripgrep/UNLICENSE|runtime/ripgrep/COPYING|service/daemon.mjs|service/cli.mjs|service/local-bootstrap.mjs|service/guest-proxy.mjs|service/owner-renderer.mjs|service/extension-handler-host.mjs|service/request-retirement.mjs|service/process-group-helper|service/node_modules/|service/node_modules/*|service/fonts/|service/fonts/*|release.json) ;; *) echo 'Unsafe workspace archive member' >&2; exit 1;; esac
done <"$temporary/names"
tar -tvzf "$temporary/payload.tar.gz" | awk 'substr($0,1,1)!="-"&&substr($0,1,1)!="d"{exit 1}'
mkdir "$temporary/release"
tar -xzf "$temporary/payload.tar.gz" -C "$temporary/release" --no-same-owner
test "$(sha256sum "$temporary/release/release.json" | cut -d ' ' -f1)" = "$release"
target="$base/releases/$release"
if test -e "$target"; then
  test ! -L "$target"
  test -d "$target" && test "$(stat -c %u "$target")" = "$(id -u)"
  test -z "$(find "$target" -type l -print)"
  test -z "$(find "$target" -type f -links +1 -print)"
  diff -r "$target" "$temporary/release" >/dev/null
else
  mv "$temporary/release" "$target"
fi
test "$($target/runtime/bin/node --version)" = v24.21.0
printf '%s\n' "$release" >"$temporary/current"
mv "$temporary/current" "$base/current"
printf '#!/bin/sh\nset -eu\nIFS= read -r release <"$HOME/.local/share/moira-workspace/current"\ncase "$release" in *[!a-f0-9]*) exit 1;; esac\ntest "${"$"}{#release}" = 64\nexec "$HOME/.local/share/moira-workspace/releases/$release/runtime/bin/node" "$HOME/.local/share/moira-workspace/releases/$release/service/cli.mjs" "$@"\n' >"$temporary/moira-workspace"
chmod 700 "$temporary/moira-workspace"
test ! -L "$HOME/.local/bin/moira-workspace"
mv "$temporary/moira-workspace" "$HOME/.local/bin/moira-workspace"
printf '#!/bin/sh\nset -eu\nIFS= read -r release <"$HOME/.local/share/moira-workspace/current"\ncase "$release" in *[!a-f0-9]*) exit 1;; esac\ntest "${"$"}{#release}" = 64\nexec "$HOME/.local/share/moira-workspace/releases/$release/runtime/bin/node" "$HOME/.local/share/moira-workspace/releases/$release/service/daemon.mjs" --start-if-configured\n' >"$temporary/moira-workspace-service"
chmod 700 "$temporary/moira-workspace-service"
test ! -L "$HOME/.local/bin/moira-workspace-service"
mv "$temporary/moira-workspace-service" "$HOME/.local/bin/moira-workspace-service"
printf '{"installed":true,"releaseIdentity":"%s","architecture":"%s"}\n' "$release" "$architecture"
`;

export const WORKSPACE_PROBE_SCRIPT = String.raw`set -eu
PATH=/usr/bin:/bin
export PATH
boot=$(cat /proc/sys/kernel/random/boot_id)
record=$(cat /proc/1/stat)
start=$(printf '%s\n' "${"$"}{record##*) }" | awk '{print $20}')
life=$(printf '%s|%s' "$boot" "$start" | sha256sum | cut -d ' ' -f1)
printf '{"environmentIdentity":"%s","architecture":"%s"}\n' "$life" "$(uname -m)"
`;

const RELEASE_SELECTION = String.raw`set -eu
IFS= read -r release <"$HOME/.local/share/moira-workspace/current"
case "$release" in *[!a-f0-9]*) exit 1;; esac
test "${"$"}{#release}" = 64
program="$HOME/.local/share/moira-workspace/releases/$release"
`;

export const WORKSPACE_CONFIGURE_SCRIPT = `${RELEASE_SELECTION}\nexec "$program/runtime/bin/node" "$program/service/daemon.mjs" --configure`;
export const WORKSPACE_LOCAL_BOOTSTRAP_SCRIPT = `${RELEASE_SELECTION}\nexec "$program/runtime/bin/node" "$program/service/local-bootstrap.mjs"`;
export const WORKSPACE_HEALTH_SCRIPT = `${RELEASE_SELECTION}\nexec "$program/runtime/bin/node" "$program/service/daemon.mjs" --health`;
export const WORKSPACE_GITHUB_PROOF_SCRIPT = `${RELEASE_SELECTION}\nexec "$program/runtime/bin/node" "$program/service/daemon.mjs" --github-proof`;
export const WORKSPACE_START_SCRIPT = `${RELEASE_SELECTION}\nexec "$program/runtime/bin/node" "$program/service/daemon.mjs" --start-if-configured`;

export async function loadWorkspacePayload(directory, architecture) {
  if (!["x64", "arm64"].includes(architecture))
    throw new Error("Unsupported workspace payload architecture");
  const receiptPath = join(directory, `payload-${architecture}.json`);
  const descriptor = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let receipt;
  try {
    const metadata = await descriptor.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size > 64 * 1024 ||
      (await realpath(receiptPath)) !== receiptPath
    )
      throw new Error("Unsafe workspace payload receipt");
    receipt = JSON.parse(await descriptor.readFile("utf8"));
  } finally {
    await descriptor.close();
  }
  if (
    receipt.version !== 1 ||
    receipt.architecture !== architecture ||
    receipt.libc !== "glibc" ||
    typeof receipt.release !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.release) ||
    typeof receipt.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.archiveSha256) ||
    receipt.fileName !== `moira-workspace-linux-${architecture}.tar.gz` ||
    !Number.isSafeInteger(receipt.size) ||
    receipt.size < 1
  )
    throw new Error("Invalid workspace payload receipt");
  const path = join(directory, receipt.fileName);
  const archive = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let identity;
  try {
    const metadata = await archive.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size !== receipt.size ||
      (await realpath(path)) !== path
    )
      throw new Error("Unsafe workspace payload archive");
    const hash = createHash("sha256");
    for await (const bytes of archive.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await archive.stat();
    if (
      hash.digest("hex") !== receipt.archiveSha256 ||
      metadata.size !== after.size ||
      metadata.mtimeMs !== after.mtimeMs ||
      metadata.ctimeMs !== after.ctimeMs
    )
      throw new Error("Workspace payload archive changed");
    identity = {
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    };
  } finally {
    await archive.close();
  }
  return {
    version: 1,
    architecture,
    libc: "glibc",
    release: receipt.release,
    archiveSha256: receipt.archiveSha256,
    fileName: receipt.fileName,
    size: receipt.size,
    path,
    identity,
  };
}

export async function* workspaceInstallInput(payload) {
  const archive = await open(payload.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const observed = await archive.stat();
    if (
      !observed.isFile() ||
      observed.nlink !== 1 ||
      !payload.identity ||
      Object.entries(payload.identity).some(([field, value]) => observed[field] !== value)
    )
      throw new Error("Workspace payload archive was replaced before delivery");
    yield Buffer.from(
      `${payload.release} ${payload.archiveSha256} ${payload.architecture} ${payload.size}\n`,
    );
    yield* archive.createReadStream({ autoClose: false });
  } finally {
    await archive.close();
  }
}

export const WORKSPACE_PAYLOAD_DIRECTORY = new URL("../dist/", import.meta.url);
