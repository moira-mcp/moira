import { createHash } from "node:crypto";
import { mkdir, lstat, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { canonicalJson } from "../../shared/src/utils/canonical-json.ts";
import {
  communicationOwnerScopeSchema,
  communicationOwnerSubmitSchema,
  communicationOwnerPreparationSchema,
  communicationVendorResultSchema,
  communicationOwnerReceiptSchema,
} from "../../shared/src/communication-owner-protocol.ts";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.ts";
import { writeDurableJson, persistDirectory } from "./file-primitives.mjs";
import { readPrivateOwnerJson } from "./private-json.mjs";
import { nativeFileBytes, nativeFileIdentity } from "./native-source.mjs";
import { operationState } from "../../shared/src/codespaces/workspace-operation-state.mjs";

function refused(code, status = 409) {
  return Object.assign(new Error(code), { publicCode: code, status });
}
function hash(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}
function deliveryDescription(input, file) {
  const name = file.fileName;
  const safeName =
    typeof name === "string" &&
    name.length <= 255 &&
    !/[\\/]/.test(name) &&
    [...name].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      ? name
      : undefined;
  const label = input.action === "publish" ? "Publish file" : `Deliver ${input.kind}`;
  return safeName ? `${label} ${safeName}` : label;
}
function immutableInput(input) {
  const source =
    input.source.type === "native"
      ? {
          type: "native",
          file: nativeFileIdentity(input.source.file),
        }
      : input.source.type === "inline"
        ? { ...input.source, data: undefined, dataDigest: hash(input.source.data) }
        : input.source;
  return { ...input, source };
}

/** Read retained admission metadata without creating an owner, collecting or contacting a vendor. */
export async function findOwnerCommunication({ stateRoot, scope }, selection = {}) {
  const root = join(stateRoot, "communication");
  const info = await lstat(root).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { operations: [] };
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root
  )
    throw refused("UNSAFE_COMMUNICATION_STATE");
  if (selection.cursor !== undefined && !WORKSPACE_REQUEST_ID_PATTERN.test(selection.cursor))
    throw refused("INVALID_OPERATION_CURSOR", 400);
  const entries = (await readdir(root))
    .filter(
      (name) => name.endsWith(".json") && WORKSPACE_REQUEST_ID_PATTERN.test(name.slice(0, -5)),
    )
    .sort();
  const operations = [];
  let last;
  for (const name of entries) {
    const requestId = name.slice(0, -5);
    if (selection.cursor && requestId <= selection.cursor) continue;
    const record = await readPrivateOwnerJson(join(root, name));
    if (!record || record.version !== 1 || record.requestId !== requestId)
      throw refused("UNSAFE_COMMUNICATION_STATE");
    const same =
      record.scope?.kind === scope?.kind &&
      (scope?.kind === "workspace"
        ? record.scope.resourceId === scope.resourceId
        : canonicalJson(record.scope) === canonicalJson(scope));
    if (!same) continue;
    last = requestId;
    const description = record.descriptor?.description ?? "Original owner delivery";
    if (selection.kind && selection.kind !== "delivery") continue;
    if (selection.query && !description.toLowerCase().includes(selection.query.toLowerCase()))
      continue;
    operations.push({
      requestId,
      kind: "delivery",
      description,
      ...(record.descriptor?.createdAt ? { createdAt: record.descriptor.createdAt } : {}),
      state: operationState(record),
    });
    if (operations.length === 50) break;
  }
  return {
    operations,
    ...(last && entries.some((name) => name.slice(0, -5) > last) ? { nextCursor: last } : {}),
  };
}

/** One immutable source and durable delivery journal, shared by workspace and controller owners. */
export async function createOwnerCommunication({
  stateRoot,
  scope,
  publications,
  transport,
  sourceProxy,
  sourceOpener,
  renderProgress,
  renderMaterialize,
  deliverExtension,
  extensionArtifact,
  handlerHost,
  extensionHelperPath,
  admit,
}) {
  scope = scope ? communicationOwnerScopeSchema.parse(scope) : undefined;
  let enabled = Boolean(scope);
  const samePrincipal = (left, right) =>
    left &&
    right &&
    left.kind === right.kind &&
    (left.kind === "workspace"
      ? left.resourceId === right.resourceId &&
        left.environmentIdentity === right.environmentIdentity
      : canonicalJson(left) === canonicalJson(right));
  const configure = (next = {}) => {
    const selected = next.scope ? communicationOwnerScopeSchema.parse(next.scope) : undefined;
    if (selected && scope && !samePrincipal(selected, scope))
      throw refused("COMMUNICATION_SCOPE_REFUSED", 403);
    if (selected) scope = selected;
    enabled = Boolean(selected);
    transport = next.transport;
    extensionArtifact = next.extensionArtifact;
  };
  const root = join(stateRoot, "communication");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    (await realpath(root)) !== root
  )
    throw refused("UNSAFE_COMMUNICATION_STATE");
  await persistDirectory(root);
  const active = new Map();
  const shutdown = new globalThis.AbortController();
  let closing = false;
  const read = async (requestId, history = false) => {
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId ?? ""))
      throw refused("INVALID_REQUEST_ID", 400);
    const record = await readPrivateOwnerJson(join(root, requestId + ".json"));
    if (
      record &&
      (record.requestId !== requestId ||
        !(history && scope?.kind === "workspace" && record.scope?.kind === "workspace"
          ? record.scope.resourceId === scope.resourceId
          : samePrincipal(record.scope, scope)) ||
        record.version !== 1)
    )
      throw refused("COMMUNICATION_SCOPE_REFUSED", 403);
    return record;
  };
  const inspect = async (requestId) => {
    const record = await read(requestId, true);
    if (!record) return { requestId, state: "absent" };
    return {
      requestId,
      state: record.outcome ? "completed" : active.has(requestId) ? "accepted" : "unconfirmed",
      ...(record.outcome ? { outcome: record.outcome } : {}),
      stages: record.stages,
    };
  };
  const tokenFor = (reference, scope) => {
    const owner = scope.kind === "controller" ? scope.deviceId : scope.resourceId;
    const prefix = `owner-file://${scope.kind}/${owner}/`;
    if (
      !reference.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]{43}$/.test(reference.slice(prefix.length))
    )
      throw refused("COMMUNICATION_SOURCE_REFUSED", 403);
    return reference.slice(prefix.length);
  };
  const prepareSource = async (source, stream, scope, publications) => {
    if (source.type === "publication") {
      const opened = await publications.openSource(
        tokenFor(source.referenceId, scope),
        shutdown.signal,
      );
      try {
        return Object.fromEntries(
          Object.entries(opened).filter(([key]) => !["settled", "close"].includes(key)),
        );
      } finally {
        await opened.close();
        await opened.settled;
      }
    }
    let body, fileName, mimeType, close, settled;
    try {
      if (source.type === "native") {
        const opened = await nativeFileBytes(source.file, {
          sourceOpener,
          proxy: sourceProxy,
          signal: shutdown.signal,
        });
        body = opened.body;
        close = () => opened.close();
        settled = opened.settled;
        fileName = source.file.fileName ?? "attachment";
        mimeType = source.file.mimeType ?? opened.mimeType ?? "application/octet-stream";
      } else if (source.type === "inline") {
        if (
          source.data.length % 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)
        )
          throw refused("SOURCE_REFUSED", 422);
        body = (async function* () {
          for (let offset = 0; offset < source.data.length; offset += 65536) {
            const part = source.data.slice(offset, offset + 65536),
              bytes = Buffer.from(part, "base64");
            if (bytes.toString("base64") !== part) throw refused("SOURCE_REFUSED", 422);
            yield bytes;
          }
        })();
        fileName = source.fileName;
        mimeType = source.mimeType;
      } else if (source.type === "progress") {
        if (!renderProgress) throw refused("PROGRESS_RENDERER_UNAVAILABLE", 503);
        const bytes = await renderProgress(source.descriptor, {
          signal: shutdown.signal,
          cacheRoot: join(root, "cache"),
        });
        body = (async function* () {
          yield bytes;
        })();
        fileName = "workflow-progress.png";
        mimeType = "image/png";
      } else if (source.type === "materialize-text-set") {
        if (!renderMaterialize) throw refused("MATERIALIZE_RENDERER_UNAVAILABLE", 503);
        const opened = await renderMaterialize(source.files, { signal: shutdown.signal });
        body = opened;
        close = () => opened.close();
        settled = opened.settled;
        fileName = "materialize.tar";
        mimeType = "application/x-tar";
      } else {
        if (!stream) throw refused("SOURCE_REFUSED", 422);
        body = (async function* () {
          let received = 0;
          for await (const chunk of stream) {
            received += chunk.byteLength;
            if (received > source.file.size) throw refused("SOURCE_REFUSED", 422);
            yield chunk;
          }
          if (received !== source.file.size) throw refused("SOURCE_REFUSED", 422);
        })();
        fileName = source.file.fileName;
        mimeType = source.file.mimeType;
      }
      return await publications.capture({
        stream: body,
        fileName,
        mimeType,
        sourceIdentity: { inputDigest: hash(immutableInput({ source })) },
      });
    } finally {
      try {
        await close?.();
      } finally {
        await settled;
      }
    }
  };
  const submit = async (value, { stream } = {}) => {
    const input = communicationOwnerSubmitSchema.parse(value);
    const selectedScope = scope;
    const selectedEnabled = enabled;
    const selectedPublications = enabled ? publications.snapshot() : undefined;
    const selectedTransport = transport;
    const selectedArtifact = extensionArtifact;
    if (input.expectedScope && canonicalJson(input.expectedScope) !== canonicalJson(scope))
      throw refused("COMMUNICATION_SCOPE_REFUSED", 403);
    const inputDigest = hash(immutableInput(input));
    const previous = await read(input.requestId);
    if (previous) {
      if (previous.inputDigest !== inputDigest) throw refused("COMMUNICATION_REQUEST_CONFLICT");
      return inspect(input.requestId);
    }
    if (active.has(input.requestId)) {
      const running = active.get(input.requestId);
      if (running.inputDigest !== inputDigest) throw refused("COMMUNICATION_REQUEST_CONFLICT");
      return running.work;
    }
    if (closing) throw refused("COMMUNICATION_OWNER_UNAVAILABLE", 503);
    if (!selectedEnabled) throw refused("COMMUNICATION_OWNER_UNAVAILABLE", 503);
    const work = (async () => {
      // Acquisition is preparation: a refused source has no admitted vendor operation.
      const file = await prepareSource(input.source, stream, selectedScope, selectedPublications);
      if (shutdown.signal.aborted || closing) throw refused("SOURCE_REFUSED", 422);
      const record = {
        version: 1,
        scope: selectedScope,
        requestId: input.requestId,
        inputDigest,
        descriptor: {
          kind: "delivery",
          description: deliveryDescription(input, file),
          createdAt: Date.now(),
        },
        file,
        stages: [],
      };
      const save = () => writeDurableJson(root, input.requestId + ".json", record);
      let channels = [];
      if (input.action === "deliver") {
        if (!selectedTransport) throw refused("COMMUNICATION_TRANSPORT_UNAVAILABLE", 503);
        channels = communicationOwnerPreparationSchema.parse(
          await selectedTransport.prepare(
            {
              scope: selectedScope,
              requestId: input.requestId,
              channelIds: input.channelIds,
              kind: input.kind,
              text: input.text,
              format: input.format,
              silent: input.silent,
              workflowFrame: input.workflowFrame,
              file: { fileName: file.fileName, mimeType: file.mimeType, size: file.size },
            },
            shutdown.signal,
          ),
        ).channels;
      }
      record.channels = channels.map(({ channelId, authorityDigest, bundleDigest }) => ({
        channelId,
        authorityDigest,
        ...(bundleDigest ? { bundleDigest } : {}),
      }));
      const perform = async () => {
        await save();
        try {
          for (const channel of channels) {
            const send = async (operationId, controls, signal = shutdown.signal) => {
              const existing = record.stages.find(
                (stage) =>
                  stage.channelId === channel.channelId && stage.operationId === operationId,
              );
              if (existing) {
                if (existing.status !== "delivered")
                  throw refused("WORKSPACE_OUTCOME_UNCONFIRMED", 503);
                return existing.result;
              }
              const textStage = channel.provider === "telegram" && operationId === "send_message";
              const source = textStage
                ? {
                    async *[Symbol.asyncIterator]() {},
                    close: async () => {},
                    settled: Promise.resolve(),
                  }
                : await selectedPublications.openSource(
                    tokenFor(file.referenceId, selectedScope),
                    signal,
                  );
              const stage = { channelId: channel.channelId, operationId, status: "accepted" };
              try {
                record.stages.push(stage);
                await save();
                const control = {
                  scope: selectedScope,
                  requestId: input.requestId,
                  channelId: channel.channelId,
                  authorityDigest: channel.authorityDigest,
                  kind: input.kind,
                  text:
                    channel.provider === "telegram" && !textStage && input.text.length > 1024
                      ? ""
                      : input.text,
                  format: input.format,
                  silent: input.silent,
                  workflowFrame: input.workflowFrame,
                  file: {
                    fileName: file.fileName,
                    mimeType: file.mimeType,
                    size: textStage ? 0 : file.size,
                  },
                  ...(operationId ? { operationId } : {}),
                  ...(channel.bundleDigest ? { bundleDigest: channel.bundleDigest } : {}),
                  ...(controls ? { controls } : {}),
                };
                let complete = false;
                const checkedSource = {
                  ...source,
                  async *[Symbol.asyncIterator]() {
                    for await (const bytes of source) yield bytes;
                    complete = true;
                  },
                };
                const result = communicationVendorResultSchema.parse(
                  await selectedTransport.send(control, checkedSource, signal),
                );
                if (result.status === "delivered" && !complete)
                  throw refused("WORKSPACE_OUTCOME_UNCONFIRMED", 503);
                await source.close();
                await source.settled;
                stage.status = result.status;
                stage.result = result;
                await save();
                if (result.status !== "delivered")
                  throw refused(
                    result.status === "unconfirmed"
                      ? "WORKSPACE_OUTCOME_UNCONFIRMED"
                      : "COMMUNICATION_DELIVERY_REFUSED",
                    result.status === "unconfirmed" ? 503 : 409,
                  );
                return result;
              } catch (error) {
                if (stage.status === "accepted") {
                  stage.status = error.deliveryOutcome === "refused" ? "refused" : "unconfirmed";
                  await save();
                }
                throw error;
              } finally {
                await source.close();
                await source.settled;
              }
            };
            if (channel.provider === "extension") {
              if (!deliverExtension || !selectedArtifact || !channel.bundleDigest)
                throw refused("COMMUNICATION_EXTENSION_UNAVAILABLE", 503);
              await deliverExtension({
                artifact: await selectedArtifact(
                  channel.channelId,
                  channel.bundleDigest,
                  selectedScope,
                  shutdown.signal,
                ),
                directory: join(root, "extensions"),
                handlerHost,
                helperPath: extensionHelperPath,
                channelId: channel.channelId,
                source: {
                  metadata: {
                    kind: input.kind,
                    filename: file.fileName,
                    mimeType: file.mimeType,
                    size: file.size,
                    sha256: file.sha256,
                  },
                  open: async (signal) => {
                    const value = await selectedPublications.openSource(
                      tokenFor(file.referenceId, selectedScope),
                      signal,
                    );
                    return { stream: value, close: value.close, settled: value.settled };
                  },
                },
                message: { text: input.text, format: input.format, silent: input.silent },
                settings: channel.settings ?? {},
                signal: shutdown.signal,
                send,
              });
              if (
                !record.stages.some(
                  (stage) => stage.channelId === channel.channelId && stage.status === "delivered",
                )
              )
                throw refused("COMMUNICATION_DELIVERY_REFUSED");
            } else {
              await send();
              if (input.text.length > 1024) await send("send_message");
            }
          }
          record.outcome = {
            ok: true,
            result: {
              file,
              ...(input.action === "deliver"
                ? {
                    status: channels.length ? "delivered" : "no_configured_channels",
                    channels: record.stages,
                  }
                : {}),
            },
          };
          await save();
        } catch (error) {
          const unknown =
            error?.code === "OWNER_DELIVERY_UNCONFIRMED" ||
            error?.publicCode === "OWNER_DELIVERY_UNCONFIRMED" ||
            record.stages.some((stage) => ["accepted", "unconfirmed"].includes(stage.status));
          record.outcome = {
            ok: false,
            error: {
              code: unknown ? "WORKSPACE_OUTCOME_UNCONFIRMED" : "COMMUNICATION_DELIVERY_REFUSED",
              message: unknown
                ? "Collect the original delivery; its vendor outcome is unconfirmed."
                : "The owner could not complete this delivery.",
            },
          };
          try {
            await save();
          } catch {
            throw refused("WORKSPACE_OUTCOME_UNCONFIRMED", 503);
          }
        }
        return inspect(input.requestId);
      };
      return admit
        ? communicationOwnerReceiptSchema.parse(
            await admit(input.requestId, inputDigest, perform, record.descriptor),
          )
        : perform();
    })();
    active.set(input.requestId, { inputDigest, work });
    try {
      return await work;
    } finally {
      active.delete(input.requestId);
    }
  };
  return {
    configure,
    submit,
    inspect,
    find: (selection) => findOwnerCommunication({ stateRoot, scope }, selection),
    async close() {
      closing = true;
      shutdown.abort();
      await Promise.allSettled([...active.values()].map((entry) => entry.work));
    },
  };
}
