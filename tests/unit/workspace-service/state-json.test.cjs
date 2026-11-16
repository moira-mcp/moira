const { afterEach, beforeEach, beforeAll, expect, test } = require("@jest/globals");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, writeFile, rm, symlink, link, mkdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const moduleUrl = pathToFileURL(resolve("packages/workspace-service/src/file-primitives.mjs")).href;
let readStateJson, directory;
beforeAll(async () => ({ readStateJson } = await import(moduleUrl)));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "moira-state-json-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("atomic publication in another process leaves every state read a complete version", async () => {
  const versions = [
    { launchAttempted: false, requestDigest: "a".repeat(64) },
    { launchAttempted: true, requestDigest: "a".repeat(64), startedAt: 123, runtimeMs: 10000 },
  ];
  const path = join(directory, "execution.json");
  await writeFile(path, JSON.stringify(versions[0]), { mode: 0o600 });
  const writer = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {writeDurableJson} from ${JSON.stringify(moduleUrl)};
     const versions=JSON.parse(process.argv[2]);
     process.stdout.write('ready');
     for(let index=0;index<1000;index++)
       await writeDurableJson(process.argv[1],'execution.json',versions[index%2]);`,
      directory,
      JSON.stringify(versions),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let ended = false,
    stderr = "";
  writer.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const closed = once(writer, "close").then(([code]) => {
    ended = true;
    return code;
  });
  try {
    await once(writer.stdout, "data");
    do {
      expect(versions).toContainEqual(await readStateJson(path));
    } while (!ended);
    expect({ code: await closed, stderr }).toEqual({ code: 0, stderr: "" });
    expect(await readStateJson(path)).toEqual(versions[1]);
  } finally {
    if (!ended) writer.kill("SIGTERM");
    await closed;
  }
});

test.each(["symlink", "hardlink", "directory", "fifo"])(
  "state reads refuse %s entries",
  async (kind) => {
    const path = join(directory, "state.json"),
      target = join(directory, "original.json");
    await writeFile(target, '{"valid":true}', { mode: 0o600 });
    if (kind === "symlink") await symlink(target, path);
    if (kind === "hardlink") await link(target, path);
    if (kind === "directory") await mkdir(path);
    if (kind === "fifo") {
      const created = spawnSync("mkfifo", [path], { encoding: "utf8" });
      expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: "" });
    }
    await expect(readStateJson(path)).rejects.toThrow();
  },
);

test("missing and malformed states remain failures rather than empty successful snapshots", async () => {
  const path = join(directory, "state.json");
  await expect(readStateJson(path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, "{unfinished", { mode: 0o600 });
  await expect(readStateJson(path)).rejects.toBeInstanceOf(SyntaxError);
});
