const { test, expect } = require("@jest/globals");
const { mkdtemp, realpath, writeFile, readFile, rename, symlink, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");

test("canonical clean and dirty build identities preserve base source and honest dirty metadata", async () => {
  const { parseWorkspaceSourceIdentity } = await import(
    pathToFileURL(resolve("scripts/package-workspace-service.js")).href
  );
  const commit = "b7".repeat(20);
  expect(parseWorkspaceSourceIdentity(commit)).toEqual({ source: commit, sourceDirty: false });
  expect(parseWorkspaceSourceIdentity(`${commit}-dirty-0123456789abcdef`)).toEqual({
    source: commit,
    sourceDirty: true,
  });
  expect(parseWorkspaceSourceIdentity("unknown")).toEqual({ source: "unknown", sourceDirty: true });
  for (const invalid of [
    "unit6-preflight",
    `${commit}-dirty-short`,
    `${commit}-dirty-0123456789abcdeg`,
    [commit],
    "",
  ])
    expect(() => parseWorkspaceSourceIdentity(invalid)).toThrow(
      "Invalid workspace source identity",
    );
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-payload-")));
  const source = Buffer.from("one immutable release archive");
  const fileName = "moira-workspace-linux-arm64.tar.gz";
  const receipt = {
    version: 1,
    architecture: "arm64",
    libc: "glibc",
    release: "a".repeat(64),
    archiveSha256: createHash("sha256").update(source).digest("hex"),
    fileName,
    size: source.length,
  };
  await writeFile(join(root, fileName), source);
  await writeFile(join(root, "payload-arm64.json"), JSON.stringify(receipt));
  const module = await import(
    pathToFileURL(resolve("packages/workspace-service/src/bootstrap.mjs")).href
  );
  return { root, source, receipt, fileName, ...module };
}

test.each(["symlink", "replacement"])(
  "payload %s after measurement sends no bootstrap header or foreign bytes",
  async (kind) => {
    const f = await fixture();
    try {
      const payload = await f.loadWorkspacePayload(f.root, "arm64");
      await rename(join(f.root, f.fileName), join(f.root, "original"));
      await writeFile(join(f.root, "foreign"), Buffer.alloc(f.source.length, 42));
      if (kind === "symlink") await symlink(join(f.root, "foreign"), join(f.root, f.fileName));
      else await rename(join(f.root, "foreign"), join(f.root, f.fileName));
      await expect(f.workspaceInstallInput(payload).next()).rejects.toThrow();
      expect(await readFile(join(f.root, "original"))).toEqual(f.source);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test("held stream preserves its verified archive through atomic replacement", async () => {
  const f = await fixture();
  try {
    const payload = await f.loadWorkspacePayload(f.root, "arm64");
    const input = f.workspaceInstallInput(payload);
    const header = await input.next();
    expect(header.value.toString()).toContain(
      `${f.receipt.archiveSha256} arm64 ${f.source.length}`,
    );
    await rename(join(f.root, f.fileName), join(f.root, "original"));
    await writeFile(join(f.root, f.fileName), "unrelated replacement");
    const bytes = [];
    for await (const chunk of input) bytes.push(chunk);
    expect(Buffer.concat(bytes)).toEqual(f.source);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test.each(["release-array", "digest-array", "archive-digest"])(
  "payload loader refuses %s before provider delivery",
  async (invalid) => {
    const f = await fixture();
    try {
      const receipt = { ...f.receipt };
      if (invalid === "release-array") receipt.release = [receipt.release];
      if (invalid === "digest-array") receipt.archiveSha256 = [receipt.archiveSha256];
      if (invalid === "archive-digest")
        await writeFile(join(f.root, f.fileName), Buffer.alloc(f.source.length, 43));
      await writeFile(join(f.root, "payload-arm64.json"), JSON.stringify(receipt));
      await expect(f.loadWorkspacePayload(f.root, "arm64")).rejects.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
