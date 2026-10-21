/** Returned addresses and captured preconditions. These values never grant authority. */
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const request = /^(?:ws1-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => integer(value) && value > 0;
const matches = (pattern) => (value) => typeof value === "string" && pattern.test(value);
const oneOf =
  (...values) =>
  (value) =>
    values.includes(value);
const optional = (validate) => (value) => value === undefined || validate(value);
function object(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(([key, validate]) => validate(value[key]))
  );
}
const controller = (value) =>
  object(value, { deviceId: matches(uuid), connectionId: matches(uuid) });
export function isOwnerSelector(value) {
  if (!value || typeof value !== "object") return false;
  switch (value.kind) {
    case "local":
      return object(value, {
        kind: oneOf("local"),
        deviceId: matches(uuid),
        spaceId: matches(uuid),
        operationMarker: matches(/^moira-[a-f0-9]{24}$/),
      });
    case "github":
      return object(value, { kind: oneOf("github"), resourceId: matches(uuid) });
    case "controller":
      return object(value, {
        kind: oneOf("controller"),
        deviceId: matches(uuid),
        connectionId: matches(uuid),
      });
    default:
      return false;
  }
}
export const OPERATION_KINDS = [
  "command",
  "file-change",
  "lifecycle",
  "repository",
  "pull-request",
  "delivery",
  "session",
  "unknown",
];
const operationKind = oneOf(...OPERATION_KINDS);
const decimal = matches(/^(?:0|[1-9][0-9]*)$/);
const timestamp = matches(/^-?(?:0|[1-9][0-9]*)$/);
const identity = (value) =>
  object(value, {
    dev: decimal,
    ino: decimal,
    nlink: decimal,
    size: decimal,
    mtimeNs: timestamp,
    ctimeNs: timestamp,
    birthtimeNs: optional(timestamp),
  });
const path = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  new globalThis.TextEncoder().encode(value).length <= 4096 &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  !/^(?:\/|[A-Za-z]:)/.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const provider = oneOf("local-sandboxes", "github-codespaces");
const schemas = {
  "workspace-identity": (value) =>
    object(value, {
      resourceId: matches(uuid),
      provider,
      deviceId: optional(matches(uuid)),
    }),
  workspace: (value) =>
    object(value, {
      resourceId: matches(uuid),
      provider,
      deviceId: optional(matches(uuid)),
      generation: integer,
    }),
  controller,
  target: (value) =>
    object(value, {
      provider,
      repositoryId: (id) => typeof id === "string" && id.length > 0,
      controller: optional(controller),
    }),
  installation: (value) =>
    object(value, { controller, installationId: matches(/^[1-9][0-9]{0,39}$/) }),
  operation: (value) =>
    object(value, {
      owner: isOwnerSelector,
      requestId: matches(request),
      kind: operationKind,
      journal: optional(oneOf("repository-create")),
    }) &&
    (value.journal === undefined ||
      (value.owner.kind === "controller" && value.kind === "repository")),
  process: (value) =>
    object(value, {
      owner: isOwnerSelector,
      requestId: matches(/^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    }),
  file: (value) =>
    object(value, {
      owner: isOwnerSelector,
      binding: matches(digest),
      path,
      version: (version) => object(version, { size: integer, sha256: matches(digest) }),
      identity,
    }),
  "file-cursor": (value) =>
    object(value, {
      file: (reference) => isReference(reference, "file"),
      offset: integer,
      line: positive,
    }),
  "output-cursor": (value) =>
    object(value, {
      process: (reference) => isReference(reference, "process"),
      stream: oneOf("stdout", "stderr"),
      offset: integer,
    }),
};
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function encoded(value) {
  const bytes = new globalThis.TextEncoder().encode(canonical(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function encodeReference(kind, value) {
  if (!Object.hasOwn(schemas, kind) || !schemas[kind](value))
    throw new Error("INVALID_WORKSPACE_REFERENCE");
  return `moira-${kind}:v1:${encoded(value)}`;
}
export function decodeReference(reference, expectedKind) {
  if (typeof reference !== "string") throw new Error("INVALID_WORKSPACE_REFERENCE");
  const match = /^moira-([a-z-]+):v1:([A-Za-z0-9_-]+)$/.exec(reference);
  if (!match || !Object.hasOwn(schemas, match[1]) || (expectedKind && match[1] !== expectedKind))
    throw new Error("INVALID_WORKSPACE_REFERENCE");
  const binary = globalThis.atob(match[2].replaceAll("-", "+").replaceAll("_", "/"));
  const value = JSON.parse(
    new globalThis.TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    ),
  );
  if (!schemas[match[1]](value) || encoded(value) !== match[2])
    throw new Error("INVALID_WORKSPACE_REFERENCE");
  return value;
}
export function isReference(reference, expectedKind) {
  try {
    decodeReference(reference, expectedKind);
    return true;
  } catch {
    return false;
  }
}
