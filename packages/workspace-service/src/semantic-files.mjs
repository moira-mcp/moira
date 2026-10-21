import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  encodeReference,
  decodeReference as decodedReference,
  isReference,
} from "../../shared/src/codespaces/workspace-references.mjs";
import { safeRelativePath, sameFileIdentity } from "./file-primitives.mjs";
import { utf8Window } from "./utf8-window.mjs";
import { canonicalJson } from "../../shared/src/utils/canonical-json.ts";

export function semanticRefusal(code, extra = {}) {
  throw Object.assign(new Error(code), { publicCode: code, status: 409, ...extra });
}
export function positive(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) semanticRefusal("INVALID_TEXT_WINDOW");
  return value;
}
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);
const decodeReference = (reference, kind) => {
  if (!isReference(reference, kind)) semanticRefusal("INVALID_WORKSPACE_REFERENCE");
  return decodedReference(reference, kind);
};

/** Owner-only text projection over the existing confined descriptor and commit primitives. */
export function createSemanticFiles({ engine, owner, selector, binding }) {
  const bindingIdentity = createHash("sha256")
    .update(
      JSON.stringify({
        repository: binding.repositoryFullName,
        root: binding.root,
        dev: binding.dev,
        ino: binding.ino,
      }),
    )
    .digest("hex");
  const fileReference = (value) =>
    encodeReference("file", {
      owner: selector(),
      binding: bindingIdentity,
      path: value.path,
      version: { size: value.stat.size, sha256: value.sha256 },
      identity: value.stat.identity,
    });
  const decodeFile = (reference, path) => {
    const file = decodeReference(reference, "file");
    if (!equal(file.owner, selector())) semanticRefusal("FOREIGN_OWNER_REFERENCE");
    if (
      file.binding !== bindingIdentity ||
      (path !== undefined && file.path !== safeRelativePath(path))
    )
      semanticRefusal("FILE_REFERENCE_CONFLICT");
    return file;
  };
  const expectedFile = (reference, path) => {
    const file = decodeFile(reference, path);
    return { exists: true, ...file.version, identity: file.identity };
  };
  const observe = async (path, work) =>
    engine.withRegularFile(safeRelativePath(path), async (handle, size) => ({
      sha256: await engine.hashRegular(handle, size),
      ...(await work(handle, size)),
    }));
  const verifyObservation = (file, value) => {
    if (
      file &&
      (file.version.sha256 !== value.sha256 ||
        file.version.size !== value.stat.size ||
        !sameFileIdentity(file.identity, value.stat.identity))
    )
      semanticRefusal("FILE_REFERENCE_CONFLICT");
  };
  const bytes = async (handle, size, offset = 0, length = size - offset) => {
    const chunks = [];
    let read = 0;
    while (read < length) {
      const part = Buffer.alloc(Math.min(64 * 1024, length - read));
      const value = await handle.read(part, 0, part.length, offset + read);
      if (!value.bytesRead) semanticRefusal("FILE_CHANGED");
      read += value.bytesRead;
      chunks.push(part.subarray(0, value.bytesRead));
    }
    return Buffer.concat(chunks, read);
  };
  const stat = async (request) => {
    const value = await owner.file({ action: "stat", path: request.path });
    if (value.stat.type !== "file") return value;
    const current = {
      path: value.stat.path,
      sha256: value.stat.version.sha256,
      stat: {
        size: value.stat.size,
        identity: value.stat.identity,
        mtimeMs: value.stat.modifiedAt,
      },
    };
    return {
      stat: {
        path: current.path,
        type: "file",
        size: current.stat.size,
        modified_at: current.stat.mtimeMs,
        file: fileReference(current),
      },
    };
  };
  const read = async (request) => {
    const window = request.window ?? {};
    if (window.cursor && (window.start_line !== undefined || window.max_lines !== undefined))
      semanticRefusal("INVALID_TEXT_WINDOW");
    let cursor, file;
    if (window.cursor) {
      cursor = decodeReference(window.cursor, "file-cursor");
      file = decodeFile(cursor.file, request.path);
    }
    const maximum = positive(request.max_bytes, 64 * 1024);
    const startLine = cursor?.line ?? positive(window.start_line, 1);
    const lines = positive(window.max_lines, Number.MAX_SAFE_INTEGER);
    const value = await observe(request.path, async (handle, size) => {
      let offset = cursor?.offset ?? 0;
      if (!cursor && startLine > 1) {
        let line = 1;
        while (offset < size && line < startLine) {
          const chunk = await bytes(handle, size, offset, Math.min(64 * 1024, size - offset));
          let consumed = 0;
          for (; consumed < chunk.length && line < startLine; consumed++)
            if (chunk[consumed] === 10) line++;
          offset += consumed;
        }
      }
      if (offset > size) semanticRefusal("INVALID_TEXT_WINDOW");
      const selected = await bytes(handle, size, offset, Math.min(size - offset, maximum + 3));
      let end = selected.length,
        count = 0;
      for (let index = 0; index < selected.length; index++)
        if (selected[index] === 10 && ++count === lines) {
          end = index + 1;
          break;
        }
      const decoded = utf8Window(selected.subarray(0, end), maximum);
      if (decoded.minimum_bytes)
        semanticRefusal("TEXT_WINDOW_TOO_SMALL", { minimum_bytes: decoded.minimum_bytes });
      if (decoded.binary) semanticRefusal("BINARY_TEXT_REQUIRES_DOWNLOAD");
      const nextLine = startLine + (decoded.text.match(/\n/g)?.length ?? 0);
      return { text: decoded.text, offset, consumed: decoded.bytes, nextLine };
    });
    verifyObservation(file, value);
    const reference = fileReference(value),
      next = value.offset + value.consumed;
    return {
      text: value.text,
      file: reference,
      start_line: startLine,
      next_line: value.nextLine,
      total_bytes: value.stat.size,
      ...(next < value.stat.size
        ? {
            next_cursor: encodeReference("file-cursor", {
              file: reference,
              offset: next,
              line: value.nextLine,
            }),
          }
        : {}),
    };
  };
  const original = async (path, expected) => {
    if (expected && (typeof expected.text === "string") === (typeof expected.file === "string"))
      semanticRefusal("INVALID_FILE_PRECONDITION");
    const reference = expected?.file ? decodeFile(expected.file, path) : undefined;
    const value = await observe(path, async (handle, size) => ({
      bytes: await bytes(handle, size),
    }));
    verifyObservation(reference, value);
    const decoded = utf8Window(value.bytes, value.bytes.length);
    if (decoded.binary) semanticRefusal("BINARY_TEXT_REQUIRES_DOWNLOAD");
    if (expected?.text !== undefined && expected.text !== decoded.text)
      semanticRefusal("FILE_PRECONDITION_CONFLICT");
    return {
      ...value,
      text: decoded.text,
      expected: {
        exists: true,
        size: value.stat.size,
        sha256: value.sha256,
        identity: value.stat.identity,
      },
    };
  };
  const replace = async (request, requestId, intent) => {
    if (!request.expected || typeof request.text !== "string" || !request.text.isWellFormed())
      semanticRefusal("INVALID_FILE_REPLACEMENT");
    const current = await original(request.path, request.expected);
    return owner.write({
      requestId,
      path: request.path,
      expected: current.expected,
      source: [Buffer.from(request.text)],
      intent,
    });
  };
  const patch = async (request, requestId, intent) => {
    if (!Array.isArray(request.files) || !request.files.length)
      semanticRefusal("INVALID_TEXT_PATCH");
    const files = [];
    for (const input of request.files) {
      const current = await original(input.path, input.expected);
      if (!Array.isArray(input.replacements) || !input.replacements.length)
        semanticRefusal("INVALID_TEXT_PATCH");
      const edits = [];
      for (const replacement of input.replacements) {
        if (
          typeof replacement.old_text !== "string" ||
          !replacement.old_text.length ||
          !replacement.old_text.isWellFormed() ||
          typeof replacement.new_text !== "string" ||
          !replacement.new_text.isWellFormed() ||
          ![undefined, "one", "all"].includes(replacement.occurrence)
        )
          semanticRefusal("INVALID_TEXT_PATCH");
        const positions = [];
        let offset = 0;
        for (;;) {
          const index = current.text.indexOf(replacement.old_text, offset);
          if (index < 0) break;
          positions.push(index);
          offset = index + replacement.old_text.length;
        }
        if (!positions.length || (replacement.occurrence !== "all" && positions.length !== 1))
          semanticRefusal("TEXT_MATCH_CONFLICT");
        for (const index of positions)
          edits.push({
            start: Buffer.byteLength(current.text.slice(0, index)),
            end: Buffer.byteLength(current.text.slice(0, index + replacement.old_text.length)),
            text: replacement.new_text,
          });
      }
      edits.sort((a, b) => a.start - b.start);
      if (edits.some((edit, index) => index && edit.start < edits[index - 1].end))
        semanticRefusal("TEXT_PATCH_OVERLAP");
      files.push({ path: input.path, expected: current.expected, edits });
    }
    return owner.patch({ requestId, files, intent });
  };
  return { stat, read, replace, patch, expectedFile, fileReference };
}
