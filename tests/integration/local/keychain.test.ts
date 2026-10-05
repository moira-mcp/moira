import { afterEach, beforeEach, expect, test, jest } from "@jest/globals";
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { prepareKeychain } from "../../../packages/local/src/keychain.js";
import type { RunProcess } from "../../../packages/local/src/process.js";
import { localPolicy } from "./fixtures.js";

let home: string;
let helper: string;
const device = "0868fa30-2793-43aa-b463-6ba9a20e024c";
let selected: string;
let searchOverride: string[] | undefined;
let passwords: Map<string, string>;
let corruptStores: Set<string>;
let hostChanged: boolean;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "moira-keychain-")));
  helper = join(home, "helper");
  await writeFile(helper, "fixture", { mode: 0o700 });
  selected = "";
  searchOverride = undefined;
  passwords = new Map();
  corruptStores = new Set();
  hostChanged = false;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const output = (exitCode: number, stdout = "", stderr = "") => ({
  exitCode,
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(stderr),
});
const run: RunProcess = async (request) => {
  if (request.binary === helper) {
    if (request.argv[0] === "metadata") {
      const path =
        request.env.HOME === userInfo().homedir
          ? hostChanged
            ? "/foreign"
            : "/personal-metadata-only"
          : selected || null;
      return output(
        0,
        JSON.stringify({
          defaultStatus: path ? 0 : -25307,
          defaultPath: path,
          searchStatus: 0,
          searchPaths:
            request.env.HOME === userInfo().homedir
              ? path
                ? [path]
                : []
              : (searchOverride ?? (path ? [path] : [])),
        }),
      );
    }
    if (request.argv[0] === "select") {
      selected = request.argv[1];
      searchOverride = [selected];
      return output(0);
    }
    const password = request.stdin!.toString();
    expect(request.argv).not.toContain(password);
    expect(Object.values(request.env)).not.toContain(password);
    if (request.argv[0] === "create") {
      passwords.set(request.argv[1], password);
      await writeFile(request.argv[1], "encrypted-fixture", { mode: 0o600 });
    } else if (corruptStores.has(request.argv[1]) || password !== passwords.get(request.argv[1]))
      return output(1);
    return output(0);
  }
  return output(0, "SDK diagnostic");
};
const prepare = () =>
  prepareKeychain(home, device, helper, run, { HOME: home, PATH: "/usr/bin:/bin" });
const currentOwner = async () => {
  const pointer = JSON.parse(await readFile(join(home, "keychain-current.json"), "utf8"));
  return join(home, `keychain-${pointer.storeId}.json`);
};

test("explicit recovery preserves refused legacy bytes and selects a distinct owned store", async () => {
  await mkdir(join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
  const legacy = join(home, "Library", "Keychains", "moira-docker.keychain-db");
  const owner = join(home, "keychain-owner.json");
  await writeFile(legacy, "legacy-encrypted-bytes", { mode: 0o600 });
  await writeFile(owner, JSON.stringify({ deviceId: device, password: "a".repeat(64) }), {
    mode: 0o600,
  });
  selected = legacy;
  corruptStores.add(legacy);
  const legacyBefore = await readFile(legacy),
    ownerBefore = await readFile(owner);
  await expect(prepare()).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
  await prepareKeychain(
    home,
    device,
    helper,
    run,
    { HOME: home, PATH: "/usr/bin:/bin" },
    { newStore: true },
  );
  expect(selected).not.toBe(legacy);
  expect(await readFile(legacy)).toEqual(legacyBefore);
  expect(await readFile(owner)).toEqual(ownerBefore);
  await prepare();
});

test.each(["owner", "database"])(
  "normal preparation refuses orphan generated %s without inventing a fresh profile",
  async (kind) => {
    if (kind === "database")
      await mkdir(join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
    const orphan =
      kind === "owner"
        ? join(home, "keychain-" + "a".repeat(32) + ".json")
        : join(home, "Library", "Keychains", "moira-docker-" + "a".repeat(32) + ".keychain-db");
    const bytes = JSON.stringify({ deviceId: device, password: "a".repeat(64) });
    await writeFile(orphan, bytes, { mode: 0o600 });
    await expect(prepare()).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
    expect(await readFile(orphan, "utf8")).toBe(bytes);
    await prepareKeychain(home, device, helper, run, { HOME: home }, { newStore: true });
    expect(await readFile(orphan, "utf8")).toBe(bytes);
  },
);

test("an interrupted selector retries the committed store without creating another credential owner", async () => {
  let fail = true;
  const interrupted: RunProcess = async (request) =>
    request.binary === helper && request.argv[0] === "select" && fail ? output(1) : run(request);
  await expect(
    prepareKeychain(home, device, helper, interrupted, { HOME: home }),
  ).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
  const pointer = await readFile(join(home, "keychain-current.json"), "utf8"),
    owner = await currentOwner();
  const bytes = await readFile(owner);
  fail = false;
  await prepareKeychain(home, device, helper, interrupted, { HOME: home });
  expect(await readFile(join(home, "keychain-current.json"), "utf8")).toBe(pointer);
  expect(await readFile(owner)).toEqual(bytes);
  expect(selected).toContain(JSON.parse(pointer).storeId);
});

test.each(["empty", "legacy"])(
  "search-only selector effect recovers the committed target from %s default",
  async (kind) => {
    if (kind === "legacy") {
      await mkdir(join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
      const path = join(home, "Library", "Keychains", "moira-docker.keychain-db");
      await writeFile(path, "legacy encrypted", { mode: 0o600 });
      await writeFile(
        join(home, "keychain-owner.json"),
        JSON.stringify({ deviceId: device, password: "a".repeat(64) }),
        { mode: 0o600 },
      );
      passwords.set(path, "a".repeat(64));
      selected = path;
    }
    const previous = selected;
    let fail = true;
    const partial: RunProcess = async (request) => {
      if (request.binary === helper && request.argv[0] === "select" && fail) {
        searchOverride = [request.argv[1]];
        return output(1);
      }
      return run(request);
    };
    await expect(
      prepareKeychain(home, device, helper, partial, { HOME: home }, { newStore: true }),
    ).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
    const pointer = await readFile(join(home, "keychain-current.json"), "utf8"),
      owner = await currentOwner(),
      bytes = await readFile(owner);
    expect(selected).toBe(previous);
    expect(searchOverride?.[0]).toContain(JSON.parse(pointer).storeId);
    fail = false;
    await prepareKeychain(home, device, helper, partial, { HOME: home });
    expect(selected).toBe(searchOverride?.[0]);
    expect(selected).toContain(JSON.parse(pointer).storeId);
    expect(await readFile(join(home, "keychain-current.json"), "utf8")).toBe(pointer);
    expect(await readFile(owner)).toEqual(bytes);
  },
);

test("a committed target never admits mixed own and foreign search references", async () => {
  await prepare();
  const pointer = await readFile(join(home, "keychain-current.json"), "utf8");
  searchOverride = [selected, "/foreign/private.keychain-db"];
  await expect(prepare()).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
  expect(await readFile(join(home, "keychain-current.json"), "utf8")).toBe(pointer);
  expect(searchOverride).toHaveLength(2);
});

test.each(["duplicate", "different"])(
  "a committed target refuses two %s owned search references without changing discovery",
  async (kind) => {
    await prepare();
    const first = selected;
    if (kind === "different")
      await prepareKeychain(home, device, helper, run, { HOME: home }, { newStore: true });
    const current = selected,
      pointer = await readFile(join(home, "keychain-current.json"), "utf8");
    searchOverride = kind === "duplicate" ? [current, current] : [first, current];
    const before = [...searchOverride];
    await expect(prepare()).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
    expect(searchOverride).toEqual(before);
    expect(await readFile(join(home, "keychain-current.json"), "utf8")).toBe(pointer);
  },
);

test("a readable legacy store remains usable without rewriting its owner or creating a pointer", async () => {
  await mkdir(join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
  const path = join(home, "Library", "Keychains", "moira-docker.keychain-db"),
    owner = join(home, "keychain-owner.json"),
    password = "a".repeat(64);
  const bytes = JSON.stringify({ deviceId: device, password });
  await writeFile(path, "legacy encrypted", { mode: 0o600 });
  await writeFile(owner, bytes, { mode: 0o600 });
  passwords.set(path, password);
  selected = path;
  await prepare();
  expect(await readFile(owner, "utf8")).toBe(bytes);
  expect(await readFile(path, "utf8")).toBe("legacy encrypted");
  await expect(readFile(join(home, "keychain-current.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a later SDK boundary cannot reuse preparation success after its owned store stops unlocking", async () => {
  const assets = await import("../../../packages/local/src/assets.js");
  jest.unstable_mockModule("../../../packages/local/src/assets.js", () => ({
    ...assets,
    keychainAsset: () => helper,
  }));
  const { SbxRuntime } = await import("../../../packages/local/src/sbx-runtime.js");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    const runtime = new SbxRuntime(localPolicy(home), run);
    await runtime.call(["version"]);
    corruptStores.add(selected);
    await expect(runtime.call(["version"])).rejects.toMatchObject({
      code: "LOCAL_KEYCHAIN_UNSAFE",
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("restarting preparation unlocks the original owned store without replacing its password", async () => {
  await prepare();
  const owner = await currentOwner();
  const first = await readFile(owner, "utf8");
  await prepare();
  expect(await readFile(owner, "utf8")).toBe(first);
  expect(selected).toMatch(/\/moira-docker-[a-f0-9]{32}\.keychain-db$/);
});
test("foreign default discovery is refused without creating credential ownership", async () => {
  selected = "/foreign/keychain";
  await expect(prepare()).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
  await expect(readFile(join(home, "keychain-owner.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("an interrupted owner manifest without its encrypted store is not recreated", async () => {
  await writeFile(
    join(home, "keychain-owner.json"),
    JSON.stringify({ deviceId: device, password: "a".repeat(64) }),
    { mode: 0o600 },
  );
  await expect(prepare()).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
  expect(selected).toBe("");
});
test("corrupt owned storage fails unlock instead of resetting credentials", async () => {
  await prepare();
  corruptStores.add(selected);
  const owner = await currentOwner();
  const first = await readFile(owner, "utf8");
  await expect(prepare()).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
  expect(await readFile(owner, "utf8")).toBe(first);
});
test("another device cannot adopt an existing encrypted credential store", async () => {
  await prepare();
  await expect(
    prepareKeychain(home, "11111111-1111-4111-8111-111111111111", helper, run, { HOME: home }),
  ).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
});
test("a personal metadata change during private preparation refuses success", async () => {
  const changed: RunProcess = async (request) => {
    const response = await run(request);
    if (request.binary === helper) hostChanged = true;
    return response;
  };
  await expect(
    prepareKeychain(home, device, helper, changed, { HOME: home }),
  ).rejects.toMatchObject({ code: "LOCAL_KEYCHAIN_UNSAFE" });
});
