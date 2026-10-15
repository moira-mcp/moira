import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { verifyOwnerGit } from "./github-config.mjs";
import {
  failFile,
  readStateJson,
  safeRelativePath,
  descriptorPath,
  syncDirectory,
  persistDirectory,
  inspectPath,
  withRegularFile,
  hashRegular,
  writeAll,
  version,
  validateExpected,
  fileIdentity,
  directoryIdentity,
  verifyEntryIdentity,
  parentDirectory,
  currentFile,
  cleanupStaged,
  writeDurableJson,
  commitStaged,
  cleanupFileTransaction,
  recoverFileTransaction,
  stageStream as stageFileStream,
} from "./file-primitives.mjs";

export function createWorkspaceEngine({ stateRoot, binding, searchExecutable }) {
  const repositoryRoot = { path: binding.root, dev: binding.dev, ino: binding.ino };
  const VERSION = 1;
  const OUTPUT_STREAMS = new Map([
    ["stdout", "stdout.log"],
    ["stderr", "stderr.log"],
  ]);
  const MARKER = /^moira-op-[a-f0-9]{32}$/;
  const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/([A-Za-z0-9_.-]{1,100})$/;
  const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "not_started"]);
  /**
   * Version-control internals are not repository content: searching them returns pack files, refs
   * and reflogs that bury the caller's actual matches. They stay readable by exact path.
   */
  const UNSEARCHABLE_DIRECTORY = ".git";
  const STATE_ROOT = resolve(stateRoot);
  // A session outlives the commands that use it, so it lives beside the operation directories rather
  // than inside one of them, and it is removed with the codespace rather than with an operation.
  const SESSION_ROOT = join(STATE_ROOT, "sessions");
  const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  // A shell sets these for itself; they describe the shell rather than anything the script changed.
  const SHELL_OWNED_VARIABLES = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
  /** Marks a variable a script removed, so a later command in the session does not see it again. */
  const REMOVED = null;

  function fail(message) {
    throw new Error(message);
  }

  function operationDirectory(marker) {
    if (!MARKER.test(marker)) fail("invalid operation marker");
    return join(STATE_ROOT, marker);
  }

  function validateBase(request) {
    if (!request || request.version !== VERSION || !MARKER.test(request.remoteMarker ?? "")) {
      fail("invalid supervisor request");
    }
    return operationDirectory(request.remoteMarker);
  }

  function validateExecution(request) {
    const match = request.repositoryFullName?.match(REPOSITORY);
    if (
      !match ||
      (request.requestDigest !== undefined && !/^[a-f0-9]{64}$/.test(request.requestDigest)) ||
      (request.argv !== undefined &&
        (!Array.isArray(request.argv) ||
          !request.argv.length ||
          !request.argv[0] ||
          request.argv.some(
            (value) => typeof value !== "string" || value.includes(String.fromCharCode(0)),
          ))) ||
      (request.script !== undefined &&
        (typeof request.script !== "string" || !request.script || request.argv !== undefined)) ||
      (!request.argv && !request.script && !request.sessionEnd) ||
      (request.session !== undefined && !SESSION_NAME.test(request.session)) ||
      (request.sessionStart !== undefined && typeof request.sessionStart !== "boolean") ||
      (request.sessionEnd !== undefined && typeof request.sessionEnd !== "boolean") ||
      (request.timeoutMs !== null &&
        (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1)) ||
      typeof request.stdin !== "string"
    )
      fail("invalid execution request");
    const stdin = Buffer.from(request.stdin, "base64");
    if (stdin.toString("base64") !== request.stdin) fail("invalid execution input");
  }

  /**
   * Identifies the codespace's current running environment. It changes when that environment is
   * restarted or replaced, which is what binds a session to the life it was opened in. On Linux it is
   * the kernel's boot identity together with the start time of the first process; elsewhere only an
   * explicit override can establish it, which is how the suite exercises two different lives.
   */
  async function environmentIdentity() {
    if (process.platform === "linux") {
      // Where the running environment can identify itself it does, and an override never outranks it.
      const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => null);
      const firstProcess = await linuxStartTime(1);
      if (!bootId || firstProcess === null) return null;
      return createHash("sha256").update(`${bootId.trim()}|${firstProcess}`).digest("hex");
    }
    const override = process.env.MOIRA_ENVIRONMENT_ID;
    return override ? createHash("sha256").update(`override:${override}`).digest("hex") : null;
  }

  function sessionPath(name) {
    if (!SESSION_NAME.test(name ?? "")) fail("invalid session name");
    return join(SESSION_ROOT, `${name}.json`);
  }

  function validateSessionEnvironment(value, allowRemovals = false) {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("invalid session variables");
    const entries = Object.entries(value);
    for (const [name, entry] of entries) {
      const removal = allowRemovals && entry === REMOVED;
      if (
        !ENVIRONMENT_NAME.test(name) ||
        (!removal && (typeof entry !== "string" || entry.includes(String.fromCharCode(0))))
      ) {
        fail("invalid session variables");
      }
    }
    return Object.fromEntries(entries);
  }

  /**
   * Resolves the context a command runs in. A session that was opened in an earlier life of this
   * environment is refused rather than resumed, and so is one that was never opened: an agent must be
   * able to tell "your context is gone" from "your context is here".
   */
  /** Applies a stored context to an environment: a value sets a variable, a removal takes it away. */
  function applyContext(base, context) {
    const applied = { ...base };
    for (const [name, value] of Object.entries(context)) {
      if (value === REMOVED) delete applied[name];
      else applied[name] = value;
    }
    return applied;
  }

  async function resolveSession(request) {
    const requested = validateSessionEnvironment(request.env);
    if (!request.session)
      return { cwd: request.cwd ?? ".", env: requested, store: null, end: null };
    const identity = await environmentIdentity();
    if (identity === null) return null;
    const path = sessionPath(request.session);
    // Ending a session removes whatever stands under that name, including a file an earlier life of
    // this environment left behind, so a dead session can never hold a slot no call can free.
    if (request.sessionEnd && !request.argv && !request.script) {
      return { ended: true, end: async () => rm(path, { force: true }) };
    }
    const stored = request.sessionStart
      ? null
      : await readStateJson(path).catch((error) => {
          if (error?.code === "ENOENT") return undefined;
          throw error;
        });
    if (stored === undefined) return null;
    if (stored && stored.environment !== identity) return null;
    const context = { ...validateSessionEnvironment(stored?.env, true), ...requested };
    const cwd = request.cwd ?? stored?.cwd ?? ".";
    return {
      cwd,
      context,
      env: applyContext({}, context),
      /**
       * Stores the context this command ran with, plus whatever a script left behind. A capture keeps
       * only the difference from the environment the script started with, so the codespace's own
       * environment never enters the file.
       */
      store: async (captured) => {
        const merged = captured ? { ...context, ...captured.context } : context;
        const finalCwd = captured?.cwd ?? cwd;
        await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomBytes(8).toString("hex")}`;
        await writeFile(
          temporary,
          JSON.stringify({ environment: identity, cwd: finalCwd, env: merged }),
          { mode: 0o600 },
        );
        await rename(temporary, path);
        return null;
      },
      end: async () => {
        await rm(path, { force: true });
      },
    };
  }

  async function verifyBindingIdentity() {
    const root = binding.root;
    const value = await stat(root);
    if (!value.isDirectory() || value.uid !== process.getuid?.())
      fail("invalid workspace repository owner");
    const inspected = await lstat(root);
    if (
      inspected.isSymbolicLink() ||
      (await realpath(root)) !== root ||
      inspected.dev !== binding.dev ||
      inspected.ino !== binding.ino ||
      value.dev !== inspected.dev ||
      value.ino !== inspected.ino
    ) {
      fail("repository root identity mismatch");
    }
  }

  async function verifyRepository(request) {
    const root = binding.root;
    if (binding.repositoryFullName !== request.repositoryFullName) {
      fail("repository identity mismatch");
    }
    await verifyBindingIdentity();
    const result = await capture("/usr/bin/git", [
      "-c",
      `safe.directory=${root}`,
      "-C",
      root,
      "remote",
      "get-url",
      "origin",
    ]);
    const origin = result.stdout.trim();
    if (origin !== binding.origin) {
      fail("repository identity mismatch");
    }
    if (binding.canonicalOrigin !== undefined) {
      await verifyOwnerGit(root, binding.canonicalOrigin, binding.origin);
    }
    const cwd = resolve(root, request.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}${sep}`))
      fail("working directory escaped codespace");
    const canonical = await realpath(cwd);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
      fail("working directory escaped codespace");
    }
    await access(cwd, constants.R_OK | constants.X_OK);
    return cwd;
  }

  async function repositoryRootForFile(request) {
    const match = request.repositoryFullName?.match(REPOSITORY);
    if (!match) fail("invalid repository identity");
    const path = await verifyRepository({ ...request, cwd: "." });
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) fail("codespace root is invalid");
    return { path, dev: binding.dev, ino: binding.ino };
  }

  function decodeBytes(value) {
    if (typeof value !== "string") fail("invalid encoded file bytes");
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) fail("invalid encoded file bytes");
    return bytes;
  }

  function searchResultBytes(matches, truncated) {
    return Buffer.byteLength(JSON.stringify({ action: "search", matches, truncated }));
  }

  async function executeFileRequest(root, request, marker, directory) {
    if (!request || !["stat", "search", "apply_patch"].includes(request.action))
      fail("invalid file request");
    if (request.action === "stat") {
      const inspected = await inspectPath(root, request.path, true);
      if (inspected.stat.isDirectory()) {
        try {
          return {
            action: "stat",
            stat: {
              path: inspected.relative,
              type: "directory",
              size: 0,
              mode: inspected.stat.mode & 0o777,
              modifiedAt: Math.trunc(inspected.stat.mtimeMs),
              version: null,
            },
          };
        } finally {
          await inspected.handle.close();
        }
      }
      const current = await withRegularFile(
        root,
        request.path,
        async (handle, size) => ({ sha256: await hashRegular(handle, size) }),
        { inspected },
      );
      return {
        action: "stat",
        stat: {
          path: current.path,
          type: "file",
          size: current.stat.size,
          mode: current.stat.mode & 0o777,
          modifiedAt: Math.trunc(current.stat.mtimeMs),
          version: version(null, { ...current.stat, sha256: current.sha256 }),
        },
      };
    }
    if (request.action === "apply_patch") {
      if (!Array.isArray(request.files) || !request.files.length) fail("invalid patch files");
      const staged = [];
      const paths = new Set();
      let commitAttempted = false;
      try {
        for (const file of request.files) {
          const relative = safeRelativePath(file.path);
          if (paths.has(relative)) fail("duplicate patch path");
          paths.add(relative);
          const current = await currentFile(root, relative, { stream: true, keepOpen: true });
          try {
            validateExpected(file.expected, current);
            if (!Array.isArray(file.edits)) fail("invalid patch edits");
            let cursor = 0;
            for (const edit of file.edits) {
              if (
                !Number.isSafeInteger(edit.start) ||
                !Number.isSafeInteger(edit.end) ||
                edit.start < cursor ||
                edit.end < edit.start ||
                edit.end > (current?.stat.size ?? 0)
              )
                fail("invalid patch range");
              cursor = edit.end;
            }
            async function* patched() {
              let position = 0;
              const buffer = Buffer.alloc(64 * 1024);
              const copy = async function* (end) {
                while (position < end) {
                  const result = await current.handle.read(
                    buffer,
                    0,
                    Math.min(buffer.length, end - position),
                    position,
                  );
                  if (!result.bytesRead) failFile("concurrent_change", "patch source changed");
                  position += result.bytesRead;
                  yield buffer.subarray(0, result.bytesRead);
                }
              };
              for (const edit of file.edits) {
                yield* copy(edit.start);
                yield decodeBytes(edit.bytesBase64);
                position = edit.end;
              }
              yield* copy(current?.stat.size ?? 0);
            }
            staged.push(await stageStream(relative, patched(), file.expected, marker));
          } finally {
            await current?.handle?.close();
          }
        }
        commitAttempted = true;
        await commitStaged(staged, marker, directory);
        const files = [];
        for (const item of staged) {
          const current = await currentFile(root, item.relative, { stream: true });
          files.push({
            path: item.relative,
            previous: item.current ? version(null, item.current.stat) : null,
            current: version(null, current.stat),
          });
        }
        return { action: "apply_patch", files };
      } catch (error) {
        error.fileCommitAttempted = commitAttempted;
        throw error;
      } finally {
        await cleanupStaged(staged);
      }
    }
    if (
      typeof request.query !== "string" ||
      !request.query ||
      !["literal", "regex"].includes(request.mode) ||
      !Number.isSafeInteger(request.maxMatches) ||
      request.maxMatches < 1 ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes < 1
    )
      fail("invalid search request");
    if (typeof searchExecutable !== "string" || !searchExecutable.startsWith("/")) {
      const error = new Error("workspace search tool unavailable");
      error.publicCode = "SEARCH_TOOL_UNAVAILABLE";
      error.status = 503;
      throw error;
    }
    const base = await inspectPath(root, request.path, true);
    if (!base.stat.isDirectory()) {
      await base.handle.close();
      fail("search root must be a directory");
    }
    const matches = [];
    let payloadBytes = searchResultBytes([], false);
    let truncated = false;
    const searchFile = async (path) =>
      withRegularFile(root, path, async (handle, size) => {
        const args = [
          "--no-heading",
          "--color",
          "never",
          "--line-number",
          "--column",
          "--only-matching",
          "--no-filename",
        ];
        if (request.mode === "literal") args.push("--fixed-strings");
        args.push("--regexp", request.query, "--", "-");
        const child = spawn(searchExecutable, args, { stdio: ["pipe", "pipe", "pipe"] });
        let childError = null;
        child.once("error", (error) => {
          childError = error;
        });
        child.stderr.resume();
        child.stdin.on("error", () => undefined);
        const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
        const aborted = () => child.kill("SIGTERM");
        request.signal?.addEventListener("abort", aborted, { once: true });
        let phase = 0,
          line = "",
          column = "",
          preview = [],
          previewBytes = 0;
        const finishMatch = () => {
          if (phase === 2) {
            const item = {
              path,
              line: Number(line),
              column: Number(column),
              preview: Buffer.from(preview).toString("utf8"),
            };
            const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
            if (matches.length >= request.maxMatches || payloadBytes + bytes > request.maxBytes)
              truncated = true;
            else {
              matches.push(item);
              payloadBytes += bytes;
            }
          }
          phase = 0;
          line = "";
          column = "";
          preview = [];
          previewBytes = 0;
        };
        const feed = async () => {
          let position = 0;
          while (
            position < size &&
            !truncated &&
            !request.signal?.aborted &&
            child.exitCode === null
          ) {
            const buffer = Buffer.alloc(Math.min(64 * 1024, size - position));
            const result = await handle.read(buffer, 0, buffer.length, position);
            if (!result.bytesRead) failFile("concurrent_change", "search source changed");
            position += result.bytesRead;
            if (!child.stdin.write(buffer.subarray(0, result.bytesRead))) {
              await new Promise((resolve) => {
                const settled = () => {
                  child.stdin.off("drain", settled);
                  child.stdin.off("error", settled);
                  child.off("close", settled);
                  resolve();
                };
                child.stdin.once("drain", settled);
                child.stdin.once("error", settled);
                child.once("close", settled);
              });
            }
          }
          child.stdin.end();
        };
        let feedError = null;
        const feeding = feed().catch((error) => {
          feedError = error;
          aborted();
        });
        try {
          for await (const chunk of child.stdout) {
            for (const byte of chunk) {
              if (byte === 10) {
                finishMatch();
                if (truncated) break;
                continue;
              }
              if (phase === 0 || phase === 1) {
                if (byte === 58) {
                  phase++;
                  continue;
                }
                if (byte < 48 || byte > 57) {
                  phase = 3;
                  continue;
                }
                if (phase === 0) {
                  if (line.length < 16) line += String.fromCharCode(byte);
                  else phase = 3;
                } else {
                  if (column.length < 16) column += String.fromCharCode(byte);
                  else phase = 3;
                }
              } else if (phase === 2 && previewBytes < 512) {
                preview.push(byte);
                previewBytes++;
              }
            }
            if (truncated || request.signal?.aborted) {
              aborted();
              break;
            }
          }
          await feeding;
          const code = await closed;
          if (feedError) throw feedError;
          if (childError) {
            const error = new Error("workspace search tool unavailable");
            error.publicCode = "SEARCH_TOOL_UNAVAILABLE";
            error.status = 503;
            throw error;
          }
          if (request.signal?.aborted) {
            const error = new Error("search cancelled");
            error.publicCode = "SEARCH_CANCELLED";
            throw error;
          }
          if (!truncated && code !== 0 && code !== 1) {
            const error = new Error("workspace search rejected");
            error.publicCode = "SEARCH_REJECTED";
            throw error;
          }
          return {};
        } finally {
          request.signal?.removeEventListener("abort", aborted);
          if (child.exitCode === null) aborted();
          await closed;
        }
      });
    const visit = async (directoryHandle, prefix, directoryPath) => {
      const openedPath =
        process.platform === "linux" ? descriptorPath(directoryHandle) : directoryPath;
      const entries = await opendir(openedPath);
      try {
        for await (const entry of entries) {
          if (request.signal?.aborted) {
            const error = new Error("search cancelled");
            error.publicCode = "SEARCH_CANCELLED";
            throw error;
          }
          if (entry.name === UNSEARCHABLE_DIRECTORY) continue;
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          const path = base.relative === "." ? relative : `${base.relative}/${relative}`;
          const value = await lstat(join(openedPath, entry.name));
          if (value.isSymbolicLink()) continue;
          if (value.isDirectory()) {
            const child = await open(
              join(openedPath, entry.name),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            try {
              await visit(child, relative, join(directoryPath, entry.name));
            } finally {
              await child.close();
            }
          } else if (value.isFile() && value.nlink === 1) await searchFile(path);
          if (truncated) return;
        }
      } finally {
        await entries.close().catch((error) => {
          if (error.code !== "ERR_DIR_CLOSED") throw error;
        });
      }
    };
    const rootPath = typeof root === "string" ? root : root.path;
    try {
      await visit(
        base.handle,
        "",
        base.relative === "." ? rootPath : join(rootPath, base.relative),
      );
      return { action: "search", matches, truncated };
    } finally {
      await base.handle.close();
    }
  }

  async function withFileCommitLock(work) {
    await mkdir(STATE_ROOT, { recursive: true, mode: 0o700 });
    await persistDirectory(STATE_ROOT);
    const lockPath = join(STATE_ROOT, "file-commit.lock");
    const holder =
      process.platform === "linux"
        ? spawn(
            "/usr/bin/flock",
            ["--exclusive", lockPath, "/bin/sh", "-c", "printf 1; cat >/dev/null"],
            { stdio: ["pipe", "pipe", "pipe"] },
          )
        : spawn(
            "python3",
            [
              "-c",
              "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('1',flush=True); sys.stdin.buffer.read()",
              lockPath,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
    let acquired = false;
    let releasing = false;
    const closed = new Promise((done) => holder.once("close", done));
    holder.stdin.on("error", () => undefined);
    holder.stderr.resume();
    await new Promise((done, reject) => {
      holder.once("error", reject);
      holder.once("close", () => {
        if (!acquired) reject(new Error("file commit lock is unavailable"));
        // Losing the lock while committing cannot permit unprotected filesystem writes.
        else if (!releasing) process.kill(process.pid, "SIGKILL");
      });
      holder.stdout.once("data", () => {
        acquired = true;
        done();
      });
    });
    try {
      return await work();
    } finally {
      releasing = true;
      holder.stdin.end();
      await closed;
    }
  }

  function capture(executable, argv) {
    return new Promise((resolveValue, reject) => {
      const child = spawn(executable, argv, {
        env: { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let size = 0;
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) child.kill("SIGKILL");
        else stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) child.kill("SIGKILL");
        else stderr.push(Buffer.from(chunk));
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) reject(new Error("control command failed"));
        else
          resolveValue({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
      });
    });
  }

  // The collector is outside the command group. Only its live launch owner can
  // signal that group: its own membership prevents PID/PGID reuse at the signal.
  const GROUP_OWNER = String.raw`
const {spawn}=require('node:child_process');
const {watch}=require('node:fs');
const {access}=require('node:fs/promises');
let stopping=false;let closed=false;let timer=null;let observer=null;
process.on('SIGTERM',()=>{});
const stop=()=>{if(stopping||closed)return;stopping=true;process.kill(-process.pid,'SIGTERM');setTimeout(()=>process.kill(-process.pid,'SIGKILL'),250)};
process.on('message',input=>{
if(input==='stop'){stop();return}
const env={...process.env};for(const [name,value] of Object.entries(input.env??{})){if(value===null)delete env[name];else env[name]=value}
const options={cwd:input.cwd,env,stdio:input.sessionLock?['pipe','pipe','pipe',3]:['pipe','pipe','pipe']};
const launchAt=Date.now();
const child=input.script?spawn('/bin/sh',['-c','. "$1"; __moira_status=$?; { pwd; "$2" -e "process.stdout.write(JSON.stringify(process.env))"; } > "$3"; exit $__moira_status','sh',input.script,process.execPath,input.capturePath],options):spawn(input.argv[0],input.argv.slice(1),options);
const send=value=>{if(process.connected)process.send(value,()=>{})};
let commandStarted=false;
child.once('spawn',()=>{commandStarted=true;send({startedAt:launchAt})});child.once('error',()=>{if(!commandStarted)send({spawnRejected:true})});
child.stdout.pipe(process.stdout,{end:false});child.stderr.pipe(process.stderr,{end:false});
for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',()=>{});
process.stdin.on('error',()=>{});process.stdin.pipe(child.stdin);
const check=()=>access(input.cancelPath).then(stop,()=>{});
observer=watch(require('node:path').dirname(input.cancelPath),check);check();
if(input.timeoutMs!==null){const deadline=launchAt+input.timeoutMs;const schedule=()=>{const left=deadline-Date.now();if(left<=0){send({timedOut:true});stop();return}timer=setTimeout(schedule,Math.min(left,2147483647));timer.unref()};schedule()}
child.once('close',(code,signal)=>{closed=true;clearTimeout(timer);observer.close();send({commandFinished:true,exitCode:code,exitSignal:signal});if(process.connected)process.disconnect();process.stdin.destroy();process.exitCode=Number.isInteger(code)?code:1});
});`;

  const RUNNER = String.raw`
const {spawn}=require("node:child_process");
const {createWriteStream,createReadStream,fsync,close}=require("node:fs");
const {access,readFile,rename,rm,writeFile,open}=require("node:fs/promises");
const durable=async(path,value)=>{const temporary=path+'.'+process.pid+'.tmp';const f=await open(temporary,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync()}finally{await f.close()}await rename(temporary,path);const parent=await open(require('node:path').dirname(path),'r');try{await parent.sync().catch(e=>{if(process.platform==='linux'||!['EINVAL','ENOTSUP'].includes(e.code))throw e})}finally{await parent.close()}};
const startTimeOf=async(path)=>{try{const value=await readFile(path,'utf8');const field=value.slice(value.lastIndexOf(') ')+2).split(' ')[19]??null;return /^[0-9]+$/.test(field)?field:null}catch{return null}};
(async()=>{process.stdin.setEncoding('utf8');let raw="";for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);
// Streams stay on disk; observer windows do not constrain the command's retained output.
const total={stdout:0,stderr:0};
let child;
const sink={stdout:createWriteStream(input.stdoutPath,{mode:0o600,autoClose:false}),stderr:createWriteStream(input.stderrPath,{mode:0o600,autoClose:false})};
let storageFailed=false;let groupStopRequested=false;
for(const stream of ["stdout","stderr"])sink[stream].on("error",()=>{storageFailed=true;groupStopRequested=true;if(child?.connected)child.send('stop',()=>{})});
let timedOut=false;
let runnerStartTime=null;if(process.platform==="linux"){runnerStartTime=await startTimeOf('/proc/self/stat');if(runnerStartTime===null)throw new Error("invalid runner start time")}
await durable(input.runnerPidPath,{pid:process.pid,startTime:runnerStartTime});
const childEnv={...process.env};
for(const [name,value] of Object.entries(input.env??{})){if(value===null)delete childEnv[name];else childEnv[name]=value}
// One launch boundary governs admission and runtime; the later spawn event proves
// success without replacing it with the time its notification was delivered.
// A crash after this durable intent cannot be mistaken for proof of nonexecution.
await durable(input.executionPath,{...input.execution,launchAttempted:true});
// A script runs under the codespace's own shell, sourced so that its directory changes and exports
// take effect in that shell, and the shell then reports where it ended and what it ended with. An
// argv command is spawned exactly as before, with no shell anywhere near it.
const spawned=spawn(process.execPath,['-e',input.groupOwner],{detached:true,stdio:['pipe','pipe','pipe',input.sessionLock?3:'ignore','ipc']});
child=spawned;
let exitCode=null;let exitSignal=null;let commandFinished=false;let spawnRejected=false;let ownerSpawned=false;
child.once('spawn',()=>{ownerSpawned=true});
const started=new Promise(resolve=>{child.on('message',value=>{if(Number.isSafeInteger(value.startedAt)&&value.startedAt>0)resolve(value.startedAt);if(value.spawnRejected===true){spawnRejected=true;resolve(null)}if(value.commandFinished===true&&(Number.isInteger(value.exitCode)||(typeof value.exitSignal==='string'&&/^SIG[A-Z0-9]+$/.test(value.exitSignal)))){commandFinished=true;exitCode=value.exitCode;exitSignal=value.exitSignal}if(value.timedOut)timedOut=true});child.once('error',()=>{if(!ownerSpawned)spawnRejected=true;resolve(null)});child.once('close',()=>resolve(null))});
child.send(input,()=>{});
if(storageFailed)child.send('stop',()=>{});
const collect=(stream)=>(chunk)=>{const buffer=Buffer.from(chunk);total[stream]+=buffer.length;
if(!sink[stream].write(buffer)){child[stream].pause();sink[stream].once("drain",()=>child[stream].resume())}};
// Output collection, exit observation and pipe-error tolerance are installed before any
// await: a command that exits immediately must not close before the runner is listening,
// and writing its stdin after it exited must not abort the runner without a result.
child.stdout.on("data",collect("stdout"));child.stderr.on("data",collect("stderr"));
child.on("error",()=>{});for(const stream of [child.stdin,child.stdout,child.stderr])stream.on("error",()=>{});
const closed=new Promise((resolveClose)=>child.once("close",()=>resolveClose(exitCode)));
const startedAt=await started;
if(startedAt!==null){await durable(input.executionPath,{...input.execution,launchAttempted:true,startedAt,runtimeMs:input.timeoutMs})}
if(startedAt!==null&&input.session){await durable(input.session.path,{environment:input.session.identity,cwd:input.session.cwd,env:input.session.context})}
try{if(input.inputDescriptor){const source=createReadStream(null,{fd:6,autoClose:true});source.on("error",()=>{groupStopRequested=true;if(child.connected)child.send('stop',()=>{})});source.pipe(child.stdin)}else child.stdin.end(Buffer.from(input.stdin,"base64"))}catch{}
// A start time is unreadable only once the child is gone; the published result is then the
// authority, and an unverifiable identity is never reported as a live process.
const startTime=process.platform==="linux"?await startTimeOf('/proc/'+child.pid+'/stat'):null;
if(startedAt!==null)await durable(input.pidPath,{pid:child.pid,startTime});
// FD5 is held only until launch proof and process identity are published;
// it is not inherited by the actual command or descendants.
if(input.admissionLock){require('node:fs').writeSync(5,'release\n');require('node:fs').closeSync(5)}
const code=await closed;let cancelled=false;try{await access(input.cancelPath);cancelled=true}catch{}
// The retained streams must be complete on disk before the result announces their size.
await Promise.all(["stdout","stderr"].map(async(stream)=>{await new Promise(done=>{if(sink[stream].destroyed)done();else sink[stream].end(done)});const fd=sink[stream].fd;if(!Number.isInteger(fd)){storageFailed=true;return}try{await new Promise((done,reject)=>fsync(fd,error=>error?reject(error):done()))}catch{storageFailed=true}finally{await new Promise(done=>close(fd,error=>{if(error)storageFailed=true;done()}))}}));
// A vanished launch owner is not command completion. Cancellation additionally
// requires absence of its group; observing a PGID never grants signal authority.
if(commandFinished&&(cancelled||timedOut||groupStopRequested)){try{process.kill(-child.pid,0);commandFinished=false}catch(error){if(error.code!=='ESRCH')commandFinished=false}}
const state=spawnRejected?"not_started":!commandFinished?"outcome_unknown":storageFailed?"failed":cancelled?"cancelled":timedOut?"timed_out":code===0?"succeeded":"failed";
// What the script left behind is the difference from the environment it started with, and only that.
let captureDropped=false;
if(input.session&&input.script&&(state==="succeeded"||state==="failed")){
try{
const raw=await readFile(input.capturePath,"utf8");
const split=raw.indexOf("\n");
const endedIn=raw.slice(0,split);
const ended=JSON.parse(raw.slice(split+1));
const shellOwned=new Set(input.shellOwned);
const difference={};
// A capture obeys every rule the reader applies, name and value alike, so a stored context can
// always be read back; anything the reader would refuse means the capture is dropped instead.
const nameRule=new RegExp(input.session.namePattern);
let refused=false;
const keep=(name,value)=>{if(!nameRule.test(name)||(value!==null&&(typeof value!=="string"||value.includes(String.fromCharCode(0))))){refused=true;return}difference[name]=value};
for(const [name,value] of Object.entries(ended))if(!shellOwned.has(name)&&childEnv[name]!==value)keep(name,value);
for(const name of Object.keys(childEnv))if(!shellOwned.has(name)&&!(name in ended))keep(name,null);
// The shell reports the path it actually stands in, which may differ from the configured root by a
// symbolic link, so both sides are resolved before they are compared.
const {realpathSync}=require("node:fs");const {relative:relativeTo}=require("node:path");
let relative=null;try{const inside=relativeTo(realpathSync(input.repositoryRoot),realpathSync(endedIn));relative=inside===""?".":(inside.startsWith("..")?null:inside)}catch{relative=null}
const merged={...input.session.context,...difference};
const cwd=relative??input.session.cwd;
const encoded=JSON.stringify({environment:input.session.identity,cwd,env:merged});
if(!refused){
await durable(input.session.path,JSON.parse(encoded));
}else captureDropped=true;
}catch{captureDropped=true}
}
else if(input.session&&input.script)captureDropped=true;
if(input.session&&input.sessionEnd)await rm(input.session.path,{force:true}).catch(()=>{});
await durable(input.resultPath,{state,stdout:"",stderr:"",exitCode:!spawnRejected&&Number.isInteger(code)?code:null,...(exitSignal?{exitSignal}:{}),...(storageFailed?{reason:"OUTPUT_STORAGE_FAILED"}:spawnRejected?{reason:"COMMAND_START_REJECTED"}:state==='outcome_unknown'?{reason:"COMMAND_OUTCOME_UNKNOWN"}:{}),stdoutBytes:total.stdout,stderrBytes:total.stderr,sessionCaptureDropped:captureDropped,...(input.requestDigest===undefined?{}:{requestDigest:input.requestDigest,...(startedAt===null?{}:{startedAt,runtimeMs:input.timeoutMs})})});
if(input.sessionLock){require('node:fs').writeSync(3,'release\n');require('node:fs').closeSync(3)}
})().catch(async()=>{process.exitCode=1});`;

  async function executionMetadata(directory) {
    try {
      return await readStateJson(join(directory, "execution.json"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  function receiptMetadata(value) {
    return value?.requestDigest === undefined
      ? {}
      : {
          requestDigest: value.requestDigest,
          ...(Number.isSafeInteger(value.startedAt) && value.startedAt > 0
            ? {
                startedAt: value.startedAt,
                ...(Number.isSafeInteger(value.runtimeMs) && value.runtimeMs > 0
                  ? { runtimeMs: value.runtimeMs }
                  : {}),
              }
            : {}),
        };
  }

  async function readCancellation(directory, request) {
    let value;
    try {
      value = await readStateJson(join(directory, "cancel-intent.json"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (
      typeof value.noStart !== "boolean" ||
      (value.requestDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.requestDigest))
    )
      fail("invalid operation cancellation intent");
    if (request.requestDigest !== undefined && request.requestDigest !== value.requestDigest)
      fail("operation cancellation intent mismatch");
    return value;
  }

  async function publishNotStarted(directory, metadata, reason) {
    await writeDurableJson(directory, "result.json", {
      state: "not_started",
      ...(reason ? { reason } : {}),
      stdout: "",
      stderr: "",
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      sessionCaptureDropped: false,
      ...(metadata.requestDigest === undefined ? {} : { requestDigest: metadata.requestDigest }),
    });
    return readResult(directory);
  }

  /** The existing kernel-lock pattern, scoped to one explicit session and handed to its runner. */
  async function acquireSessionLock(request) {
    if (!request.session) return null;
    await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
    await persistDirectory(SESSION_ROOT);
    const path = join(SESSION_ROOT, `${request.session}.lock`);
    return acquireKernelLock(path);
  }

  /** One kernel-owned primitive also fences cancellation against the actual launch boundary. */
  async function acquireKernelLock(path) {
    const holder =
      process.platform === "linux"
        ? spawn(
            "/usr/bin/flock",
            [
              "--exclusive",
              path,
              "/bin/sh",
              "-c",
              'printf 1; while IFS= read -r line; do [ "$line" = release ] && break; done',
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          )
        : spawn(
            "python3",
            [
              "-c",
              "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('1',flush=True);\nfor line in sys.stdin:\n if line.rstrip('\\n') == 'release': break",
              path,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
    holder.stdin.on("error", () => undefined);
    holder.stderr.resume();
    try {
      await new Promise((done, reject) => {
        holder.once("error", reject);
        holder.once("close", () => reject(new Error("lock owner exited before admission")));
        holder.stdout.once("data", () => done(true));
      });
      return {
        stream: holder.stdin,
        release: () => {
          holder.stdin.destroy();
          holder.stdout.destroy();
          holder.stderr.destroy();
          holder.unref();
        },
      };
    } catch (error) {
      holder.kill("SIGTERM");
      holder.stdin.destroy();
      throw error;
    }
  }

  async function execute(request, binding, inputDescriptor) {
    const directory = validateBase(request);
    validateExecution(request);
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const cancellation = await readCancellation(directory, request);
      if (cancellation) {
        if (cancellation.requestDigest !== request.requestDigest)
          fail("operation cancellation intent mismatch");
        return inspect(request);
      }
      const accepted = await executionMetadata(directory);
      if (
        !accepted ||
        accepted.requestHash !== requestHash ||
        accepted.requestDigest !== request.requestDigest
      )
        fail("operation execution intent mismatch");
      return inspect(request);
    }
    await persistDirectory(directory);
    const execution = {
      requestHash,
      launchAttempted: false,
      ...(request.requestDigest === undefined ? {} : { requestDigest: request.requestDigest }),
    };
    await writeDurableJson(directory, "execution.json", execution);
    const sessionLock = await acquireSessionLock(request);
    let admissionLock = null;
    let runnerAttempted = false;
    try {
      const session = await resolveSession(request);
      // A command whose session belongs to an earlier life of this environment does not run at all.
      if (session === null) return publishNotStarted(directory, execution, "SESSION_UNAVAILABLE");
      admissionLock = await acquireKernelLock(join(directory, "admission.lock"));
      const cancellation = await readCancellation(directory, request);
      if (cancellation) return inspect(request);
      const cwd = await verifyRepository({ ...request, cwd: session.ended ? "." : session.cwd });
      // Ending a session is answered here: the stored context is removed and nothing is dispatched.
      if (session.ended) {
        await writeDurableJson(directory, "execution.json", {
          ...execution,
          launchAttempted: true,
        });
        const startedAt = Date.now();
        await session.end?.();
        await writeDurableJson(directory, "execution.json", {
          ...execution,
          launchAttempted: true,
          startedAt,
          runtimeMs: request.timeoutMs,
        });
        await writeDurableJson(directory, "result.json", {
          state: "succeeded",
          stdout: "",
          stderr: "",
          exitCode: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          sessionCaptureDropped: false,
          requestDigest: request.requestDigest,
          startedAt,
          runtimeMs: request.timeoutMs,
        });
        if (request.requestDigest === undefined) return { state: "session_ended" };
        return readResult(directory);
      }
      // The life of the environment the command runs in, so a later inspection can tell a command whose
      // codespace restarted underneath it from a supervisor that exited without publishing a result.
      const life = await environmentIdentity();
      if (life) await writeFile(join(directory, "environment"), life, { mode: 0o600 });
      const pidPath = join(directory, "pid");
      const runnerPidPath = join(directory, "runner-pid");
      const stdoutPath = join(directory, OUTPUT_STREAMS.get("stdout"));
      const stderrPath = join(directory, OUTPUT_STREAMS.get("stderr"));
      const resultPath = join(directory, "result.json");
      const cancelPath = join(directory, "cancel-requested");
      const capturePath = join(directory, "session-capture.json");
      let scriptPath = null;
      if (request.script !== undefined) {
        scriptPath = join(directory, "script.sh");
        await writeFile(scriptPath, request.script, { mode: 0o600 });
      }
      runnerAttempted = true;
      const runner = spawn(process.execPath, ["-e", RUNNER], {
        detached: true,
        stdio: [
          "pipe",
          "ignore",
          "ignore",
          sessionLock?.stream ?? "ignore",
          "ignore",
          admissionLock.stream,
          inputDescriptor ?? "ignore",
        ],
        env: process.env,
      });
      // Session context becomes durable only after an actual launch.
      runner.stdin.end(
        JSON.stringify({
          argv: request.argv ?? null,
          groupOwner: GROUP_OWNER,
          script: scriptPath,
          capturePath,
          shellOwned: [...SHELL_OWNED_VARIABLES],
          sessionEnd: Boolean(request.sessionEnd),
          repositoryRoot: binding.root,
          session: session.store
            ? {
                path: sessionPath(request.session),
                identity: await environmentIdentity(),
                context: session.context,
                cwd: session.cwd,
                namePattern: ENVIRONMENT_NAME.source,
              }
            : null,
          cwd,
          // The context travels as it is stored, so a removal reaches the child as a removal.
          env: session.context ?? session.env,
          stdin: request.stdin,
          inputDescriptor: inputDescriptor !== undefined,
          timeoutMs: request.timeoutMs,
          requestDigest: request.requestDigest,
          execution,
          executionPath: join(directory, "execution.json"),
          sessionLock: Boolean(sessionLock),
          admissionLock: true,
          pidPath,
          runnerPidPath,
          stdoutPath,
          stderrPath,
          resultPath,
          cancelPath,
        }),
      );
      runner.unref();
      // Dispatch is proven by the child's identity or by a result the runner already published;
      // a command that outlives neither is not silently left running.
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await dispatched(pidPath, resultPath)) break;
        await new Promise((resolveValue) => setTimeout(resolveValue, 25));
      }
      if (!(await dispatched(pidPath, resultPath))) {
        await access(pidPath, constants.R_OK);
      }
      const proof = await executionMetadata(directory);
      if (request.requestDigest !== undefined)
        return (
          (await readResult(directory)) ?? {
            state: proof?.startedAt ? "running" : "outcome_unknown",
            ...receiptMetadata(proof),
          }
        );
      return { state: "running" };
    } catch (error) {
      // A durable negative launch proof permits one collectible no-start result.
      // Once launch was attempted, lost observation must retain uncertainty.
      const proof = await executionMetadata(directory);
      if (!runnerAttempted && proof?.launchAttempted === false)
        return publishNotStarted(directory, execution, "COMMAND_START_REJECTED");
      throw error;
    } finally {
      admissionLock?.release();
      sessionLock?.release();
    }
  }

  async function dispatched(pidPath, resultPath) {
    for (const path of [pidPath, resultPath]) {
      try {
        await access(path, constants.R_OK);
        return true;
      } catch {
        // The next evidence path is checked before the caller waits again.
      }
    }
    return false;
  }

  async function readResult(directory) {
    try {
      const value = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
      if (!TERMINAL.has(value.state) && value.state !== "outcome_unknown")
        fail("invalid operation result");
      return {
        state: value.state,
        ...(value.reason ? { reason: value.reason } : {}),
        exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
        stdoutBytes: Number.isSafeInteger(value.stdoutBytes) ? value.stdoutBytes : 0,
        stderrBytes: Number.isSafeInteger(value.stderrBytes) ? value.stderrBytes : 0,
        sessionCaptureDropped: value.sessionCaptureDropped === true,
        ...receiptMetadata(value),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return null;
    }
  }

  async function linuxStartTime(pid) {
    try {
      const value = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(") ") + 2).split(" ");
      if (["Z", "X"].includes(fields[0])) return null;
      return fields[19] ?? null;
    } catch {
      return null;
    }
  }

  async function processExists(identity) {
    const { pid, startTime } = identity;
    // Recorded without a start time on Linux: the process was already gone when its identity
    // was published, so it is never reported as live and its result file is the authority.
    if (process.platform === "linux" && startTime === null) return false;
    try {
      process.kill(pid, 0);
      return startTime === null || (await linuxStartTime(pid)) === startTime;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }

  async function readProcessIdentity(directory, fileName = "pid") {
    const value = JSON.parse(await readFile(join(directory, fileName), "utf8"));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 1)
      fail("invalid operation process identity");
    if (value.startTime !== null && !/^[0-9]+$/.test(value.startTime)) {
      fail("invalid operation process start time");
    }
    return value;
  }

  async function readOptionalProcessIdentity(directory, fileName) {
    try {
      return await readProcessIdentity(directory, fileName);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Whether this operation belongs to an earlier life of the environment. A command's processes do not
   * survive a codespace restart while its state directory does, so a recorded life that is not the
   * current one is what separates a restart from a supervisor that failed inside this life.
   */
  async function lostWithEnvironment(directory) {
    const recorded = await readFile(join(directory, "environment"), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!recorded) return false;
    const current = await environmentIdentity();
    return Boolean(current) && recorded.trim() !== current;
  }

  async function inspect(request) {
    const directory = validateBase(request);
    try {
      await access(directory, constants.R_OK);
      const proof = await executionMetadata(directory);
      const cancellation = await readCancellation(directory, request);
      if (cancellation?.noStart && proof?.startedAt !== undefined)
        fail("cancellation contradicts a proved launch");
      if (
        request.requestDigest !== undefined &&
        proof?.requestDigest !== undefined &&
        request.requestDigest !== proof.requestDigest
      )
        fail("operation inspection intent mismatch");
      const result = await readResult(directory);
      if (result) return result;
      if (cancellation?.noStart) {
        if (proof?.startedAt !== undefined) fail("cancellation contradicts a proved launch");
        return {
          state: "not_started",
          exitCode: null,
          stdoutBytes: 0,
          stderrBytes: 0,
          sessionCaptureDropped: false,
          ...receiptMetadata(cancellation),
        };
      }
      const running = () => ({
        state:
          proof?.requestDigest !== undefined && !proof.startedAt ? "outcome_unknown" : "running",
        ...receiptMetadata(proof),
      });
      const identity = await readOptionalProcessIdentity(directory, "pid");
      if (identity && (await processExists(identity))) return running();
      const runnerIdentity = await readOptionalProcessIdentity(directory, "runner-pid");
      if (runnerIdentity && (await processExists(runnerIdentity))) return running();
      const publishedAfterRunnerExit = await readResult(directory);
      if (publishedAfterRunnerExit) return publishedAfterRunnerExit;
      if (await lostWithEnvironment(directory))
        return { state: "interrupted", ...receiptMetadata(proof) };
      // A marker can be visible before its accepted runner publishes proof or PID.
      // Missing publication also cannot determine a historical command's outcome.
      return { state: "outcome_unknown", ...receiptMetadata(proof ?? cancellation) };
    } catch (error) {
      if (error?.code === "ENOENT")
        return {
          state: "absent",
          ...(request.requestDigest === undefined ? {} : { requestDigest: request.requestDigest }),
        };
      throw error;
    }
  }

  async function cancel(request) {
    const directory = validateBase(request);
    if (request.requestDigest !== undefined && !/^[a-f0-9]{64}$/.test(request.requestDigest))
      fail("invalid cancellation request");
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await persistDirectory(directory);
    // Cancellation is control authority, so its gate does not reopen or extend admission.
    const gate = await acquireKernelLock(join(directory, "admission.lock"));
    try {
      const proof = await executionMetadata(directory);
      if (
        request.requestDigest !== undefined &&
        proof?.requestDigest !== undefined &&
        proof.requestDigest !== request.requestDigest
      )
        fail("operation cancellation intent mismatch");
      const previous = await readCancellation(directory, request);
      const current = await inspect(request);
      if (
        current.state !== "not_started" &&
        TERMINAL.has(current.state) &&
        (await readResult(directory))
      )
        return current;
      const noStart =
        previous?.noStart === true ||
        current.state === "not_started" ||
        (proof?.startedAt === undefined && (created || proof?.launchAttempted === false));
      const intent = {
        noStart,
        ...(request.requestDigest === undefined ? {} : { requestDigest: request.requestDigest }),
      };
      await writeDurableJson(directory, "cancel-intent.json", intent);
      if (noStart) return publishNotStarted(directory, intent);
      // An attempted launch without durable proof is ambiguous even if its gate owner crashed.
      if (current.state !== "running")
        return { state: "outcome_unknown", ...receiptMetadata(proof ?? intent) };
      const identity = await readProcessIdentity(directory);
      // The live launch owner observes this private intent and signals its own
      // group. A recorded PID is status evidence, never cancellation authority.
      await writeDurableJson(directory, "cancel-requested", true);
      await new Promise((resolveValue) => setTimeout(resolveValue, 350));
      const completed = await readResult(directory);
      if (completed) return completed;
      if (await processExists(identity))
        return { state: "running", ...receiptMetadata(await executionMetadata(directory)) };
      const runnerIdentity = await readOptionalProcessIdentity(directory, "runner-pid");
      if (runnerIdentity && (await processExists(runnerIdentity)))
        return { state: "running", ...receiptMetadata(proof) };
      // Lost owners cannot prove their command or descendants terminated. Only
      // the surviving result collector may publish actual terminal completion.
      return { state: "outcome_unknown", ...receiptMetadata(proof) };
    } finally {
      gate.release();
    }
  }

  function stageStream(path, source, expected, marker) {
    return stageFileStream(repositoryRoot, path, source, expected, marker);
  }

  return {
    validateCommand: (request) => {
      validateExecution(request);
      validateSessionEnvironment(request.env);
    },
    execute: (request, inputDescriptor) => execute(request, binding, inputDescriptor),
    inspect,
    cancel,
    environmentIdentity,
    operationDirectory,
    fileRequest: async (request, marker, directory) =>
      executeFileRequest(
        await repositoryRootForFile({ repositoryFullName: binding.repositoryFullName }),
        request,
        marker,
        directory,
        binding,
      ),
    withRegularFile: (path, work, options) => withRegularFile(repositoryRoot, path, work, options),
    stageStream,
    commitStaged,
    cleanupStaged,
    writeDurableJson,
    persistDirectory,
    recoverFileTransaction: (directory) => recoverFileTransaction(directory, repositoryRoot),
    cleanupFileTransaction: (directory) => cleanupFileTransaction(directory, repositoryRoot),
    withFileCommitLock,
    parentDirectory: (path) => parentDirectory(repositoryRoot, path),
    currentFile: (path, options) => currentFile(repositoryRoot, path, options),
    validateExpected,
    directoryIdentity,
    fileIdentity,
    descriptorPath,
    writeAll,
    syncDirectory,
    hashRegular,
    version,
    verifyEntryIdentity,
    verifyBinding: () =>
      verifyRepository({ repositoryFullName: binding.repositoryFullName, cwd: "." }),
    verifyBindingIdentity,
  };
}
