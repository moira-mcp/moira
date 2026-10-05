import { lstat, mkdir, realpath, rmdir, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, basename, dirname } from "node:path";
import { userInfo } from "node:os";
import { LocalRefusal } from "./policy.js";
import { PrivateState } from "./private-state.js";
import { type RunProcess } from "./process.js";
import { z } from "zod";

const refusal = () =>
  new LocalRefusal(
    "LOCAL_KEYCHAIN_UNSAFE",
    "The private Docker credential store is unavailable or does not belong to this device.",
  );

/** Own encrypted Keychain discovery belongs to the private HOME, never the user's login store. */
export async function prepareKeychain(
  home: string,
  deviceId: string,
  helper: string,
  run: RunProcess,
  environment: Readonly<Record<string, string>>,
  options: { newStore?: boolean } = {},
): Promise<void> {
  const privateHome = await PrivateState.open(home);
  const helperMetadata = await lstat(helper);
  if (
    !helperMetadata.isFile() ||
    (helperMetadata.mode & 0o022) !== 0 ||
    (await realpath(helper)) !== helper
  )
    throw refusal();
  const metadata = async (context: string): Promise<string> => {
    const result = await run({
      binary: helper,
      argv: ["metadata"],
      cwd: home,
      env: { HOME: context, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeoutMs: 30_000,
      maxBytes: 16_384,
    });
    if (result.exitCode !== 0) throw refusal();
    const observed = z
      .object({
        defaultStatus: z.number().int(),
        defaultPath: z.string().nullable(),
        searchStatus: z.literal(0),
        searchPaths: z.array(z.string()).max(128),
      })
      .safeParse(JSON.parse(result.stdout.toString()));
    if (
      !observed.success ||
      !(
        (observed.data.defaultStatus === 0 && observed.data.defaultPath) ||
        (observed.data.defaultStatus === -25307 && observed.data.defaultPath === null)
      )
    )
      throw refusal();
    return JSON.stringify({
      default: observed.data.defaultPath,
      search: observed.data.searchPaths,
    });
  };
  const personalHome = userInfo().homedir;
  if (personalHome === home) throw refusal();
  const personalBefore = await metadata(personalHome);
  const lock = join(home, ".moira-keychain-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw refusal();
  }
  let password: Buffer | undefined;
  let failure: unknown;
  try {
    for (const path of [
      join(home, "Library"),
      join(home, "Library", "Preferences"),
      join(home, "Library", "Keychains"),
    ])
      await PrivateState.open(path);
    const directory = join(home, "Library", "Keychains");
    const ownerSchema = z
      .object({ deviceId: z.literal(deviceId), password: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict();
    const pointer = await privateHome.read("keychain-current.json", (value) =>
      z
        .object({ deviceId: z.literal(deviceId), storeId: z.string().regex(/^[a-f0-9]{32}$/) })
        .strict()
        .parse(value),
    );
    const filePresent = async (path: string) => {
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (
        existing &&
        (!existing.isFile() ||
          existing.nlink !== 1 ||
          (existing.mode & 0o077) !== 0 ||
          (process.getuid && existing.uid !== process.getuid()) ||
          (await realpath(path)) !== path)
      )
        throw refusal();
      return !!existing;
    };
    const owned = async (path: string) => {
      if (dirname(path) !== directory) throw refusal();
      const name = basename(path),
        id = /^moira-docker-([a-f0-9]{32})\.keychain-db$/.exec(name)?.[1];
      const key =
        name === "moira-docker.keychain-db"
          ? "keychain-owner.json"
          : id
            ? `keychain-${id}.json`
            : null;
      if (!key) throw refusal();
      const stored = await privateHome.read(key, (value) => ownerSchema.parse(value));
      const exists = await filePresent(path);
      if (!!stored !== exists) throw refusal();
      return stored ? { path, key, id, password: stored.password } : null;
    };
    const before = await metadata(home);
    const empty = JSON.stringify({ default: null, search: [] });
    if (before !== empty) {
      const source = JSON.parse(before) as { default: string | null; search: string[] };
      if (source.search.length > 1) throw refusal();
      const balanced =
        source.default !== null &&
        source.search.length === 1 &&
        source.search[0] === source.default;
      if (!balanced) {
        // Native search/default setters can settle independently. Retry only a committed own target.
        if (
          !pointer ||
          !(await owned(join(directory, `moira-docker-${pointer.storeId}.keychain-db`)))
        )
          throw refusal();
      }
      const references =
        source.default === null ? source.search : [source.default, ...source.search];
      for (const reference of references) if (!(await owned(reference))) throw refusal();
    }
    let target = options.newStore
      ? null
      : await owned(
          pointer
            ? join(directory, `moira-docker-${pointer.storeId}.keychain-db`)
            : join(directory, "moira-docker.keychain-db"),
        );
    if (pointer && !target && !options.newStore) throw refusal();
    if (!target && !options.newStore) {
      const names = [...(await readdir(home)), ...(await readdir(directory))];
      if (names.some((name) => name.startsWith("keychain-") || name.startsWith("moira-docker-")))
        throw refusal();
    }
    const creating = !target;
    if (!target) {
      const id = randomBytes(16).toString("hex"),
        key = `keychain-${id}.json`,
        path = join(directory, `moira-docker-${id}.keychain-db`);
      if (
        (await filePresent(path)) ||
        (await privateHome.read(key, (value) => ownerSchema.parse(value)))
      )
        throw refusal();
      password = Buffer.from(randomBytes(32).toString("hex"));
      // An interrupted create remains an orphan, never an automatic credential reset.
      await privateHome.write(key, { deviceId, password: password.toString() });
      target = { id, key, path, password: password.toString() };
    } else {
      password = Buffer.from(target.password);
    }
    const path = target.path;
    const expected = JSON.stringify({ default: path, search: [path] });
    const native = await run({
      binary: helper,
      argv: [creating ? "create" : target.id ? "unlock-machine" : "unlock", path],
      cwd: home,
      env: environment,
      stdin: password,
      timeoutMs: 30_000,
      maxBytes: 16_384,
    });
    if (native.exitCode !== 0 || !(await filePresent(path))) throw refusal();
    if (creating) {
      // Commit the validated target before selection: an interrupted selector can be retried.
      await privateHome.write("keychain-current.json", { deviceId, storeId: target.id });
    }
    if (before !== expected) {
      const selected = await run({
        binary: helper,
        argv: ["select", path],
        cwd: home,
        env: environment,
        timeoutMs: 30_000,
        maxBytes: 16_384,
      });
      if (selected.exitCode !== 0) throw refusal();
    }
    if ((await metadata(home)) !== expected) throw refusal();
  } catch (error) {
    failure = error instanceof LocalRefusal ? error : refusal();
  } finally {
    password?.fill(0);
    await rmdir(lock);
  }
  if ((await metadata(personalHome)) !== personalBefore) throw refusal();
  if (failure) throw failure;
}
