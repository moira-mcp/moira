import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  binaryTransportSchema,
  binaryControlsSchema,
} from "../../workflow-engine/src/extensions/binary-transport.ts";

function refusal() {
  return new Error("Installed extension binary artifact or invocation is invalid");
}

/** Installed code is immutable private input, never a project path or delivery file. */
async function install(directory, artifact, channelId) {
  if (
    !/^[a-f0-9]{64}$/.test(artifact.digest) ||
    createHash("sha256").update(artifact.bytes).digest("hex") !== artifact.digest
  )
    throw refusal();
  const value = JSON.parse(Buffer.from(artifact.bytes).toString("utf8"));
  const channel = value.manifest?.communicationChannels?.find((entry) => entry.id === channelId);
  if (value.version !== 1 || !channel || !Array.isArray(value.files)) throw refusal();
  const transport = binaryTransportSchema.parse(channel.binaryTransport);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.uid !== process.getuid?.() ||
    root.mode & 0o077
  )
    throw refusal();
  const temporary = await mkdtemp(join(directory, ".extension-"));
  const complete = temporary + ".ready";
  try {
    const paths = new Set();
    for (const file of value.files) {
      if (
        typeof file.path !== "string" ||
        isAbsolute(file.path) ||
        file.path.includes("\\") ||
        file.path.split("/").some((part) => !part || part === "." || part === "..") ||
        paths.has(file.path) ||
        typeof file.data !== "string"
      )
        throw refusal();
      paths.add(file.path);
      const target = join(temporary, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(file.data, "base64");
      if (bytes.toString("base64") !== file.data) throw refusal();
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (!paths.has("handler.mjs")) throw refusal();
    await rename(temporary, complete);
    return { path: complete, identity: await lstat(complete), channel, transport };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** One binary invocation owns one child and byte pipe; no bytes cross JSON or cloud runner IPC. */
export async function deliverOwnerExtension(options) {
  const installed = await install(options.directory, options.artifact, options.channelId);
  let child;
  let failure;
  let result;
  let closed;
  let supervisorOutcome;
  let source;
  let sourceTask;
  const sends = new Set();
  const operations = new Set();
  const controller = new globalThis.AbortController();
  const abort = () => {
    controller.abort();
    child?.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) throw refusal();
    if (!installed.channel.capabilities?.[options.source.metadata.kind]) throw refusal();
    child = spawn(
      options.helperPath ?? fileURLToPath(new URL("./process-group-helper", import.meta.url)),
      [await realpath(process.execPath), options.handlerHost],
      {
        cwd: installed.path,
        env: {
          NODE_ENV: "production",
          MOIRA_EXTENSION_ENTRYPOINT: join(installed.path, "handler.mjs"),
        },
        stdio: ["ignore", "ignore", "ignore", "pipe", "ignore", "ignore", "ipc", "pipe"],
      },
    );
    closed = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        supervisorOutcome = { code, signal };
        resolve();
      }),
    );
    const finished = new Promise((resolve) => {
      child.once("error", () => {
        failure ??= refusal();
        resolve();
      });
      child.once("close", () => {
        if (!result) failure ??= new Error("Owner extension exited before confirming its result");
        resolve();
      });
      child.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        if (result) return;
        if (message.kind === "source-open") {
          if (sourceTask) {
            failure ??= refusal();
            abort();
            return;
          }
          sourceTask = (async () => {
            source = await options.source.open(controller.signal);
            await pipeline(Readable.from(source.stream), child.stdio[7], {
              signal: controller.signal,
            });
          })().catch((error) => {
            if (!result) failure ??= error;
          });
        } else if (message.kind === "send") {
          const task = (async () => {
            const operation = installed.transport.operations.find(
              (entry) => entry.id === message.operationId,
            );
            if (!operation || typeof message.id !== "string" || operations.has(operation.id))
              throw refusal();
            operations.add(operation.id);
            const controls = binaryControlsSchema.parse(message.controls);
            const outcome = await options.send(operation.id, controls, controller.signal);
            if (child.connected)
              child.send({ kind: "send-result", id: message.id, ok: true, result: outcome });
          })().catch((error) => {
            failure ??= error;
            if (child.connected) child.send({ kind: "send-result", id: message.id, ok: false });
          });
          sends.add(task);
        } else if (message.kind === "result") {
          result = message;
          resolve();
        }
      });
    });
    const settings = Object.fromEntries(
      (installed.channel.settings ?? []).flatMap((key) =>
        key in options.settings ? [[key, options.settings[key]]] : [],
      ),
    );
    child.send({
      kind: "invoke",
      channelId: options.channelId,
      message: options.message,
      metadata: options.source.metadata,
      settings,
    });
    await finished;
    await Promise.all(sends);
    controller.abort();
    child.stdio[7]?.destroy();
    child.stdio[3]?.end();
    await closed;
    await sourceTask;
    if (supervisorOutcome.signal !== null || supervisorOutcome.code === 254)
      throw Object.assign(new Error("Owner extension process settlement is unconfirmed"), {
        code: "OWNER_DELIVERY_UNCONFIRMED",
      });
    if (failure) throw failure;
    if (result?.ok !== true || operations.size === 0)
      throw new Error("Installed owner binary handler did not confirm delivery");
  } finally {
    controller.abort();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdio[3]?.end();
      child.kill("SIGTERM");
      await closed;
    }
    options.signal?.removeEventListener("abort", abort);
    if (source) {
      await source.close();
      await source.settled;
    }
    if (
      supervisorOutcome?.signal === null &&
      supervisorOutcome.code >= 0 &&
      supervisorOutcome.code !== 254
    ) {
      const current = await lstat(installed.path);
      if (current.ino === installed.identity.ino && current.dev === installed.identity.dev)
        await rm(installed.path, { recursive: true });
    }
  }
}
