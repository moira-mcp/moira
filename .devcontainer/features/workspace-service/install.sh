#!/bin/sh
set -eu
test "$(id -u)" = 0
test "$(uname -s)" = Linux
case "$(uname -m)" in x86_64) architecture=x64;; aarch64) architecture=arm64;; *) exit 1;; esac
getconf GNU_LIBC_VERSION >/dev/null
user=${_REMOTE_USER:-root}
id "$user" >/dev/null
if ! command -v flock >/dev/null || ! command -v runuser >/dev/null || ! command -v git >/dev/null; then
  command -v apt-get >/dev/null
  apt-get update
  apt-get install -y --no-install-recommends util-linux git ca-certificates
  rm -rf /var/lib/apt/lists/*
fi
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cat "$directory/header-$architecture.txt" "$directory/moira-workspace-linux-$architecture.tar.gz" |
  runuser -u "$user" -- /bin/sh "$directory/payload-install.sh"
