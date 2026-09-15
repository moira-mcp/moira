import { Buffer } from "node:buffer";

export const CONNECTOR_MAX_REQUEST_BYTES = 24 * 1024 * 1024;
export const CONNECTOR_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
export const CONNECTOR_MAX_CONTROL_OUTPUT_BYTES = 64 * 1024;
export const CONNECTOR_MAX_CREDENTIAL_BYTES = 512;

function encode(value, maximumBytes, label) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > maximumBytes) throw new Error(`${label} exceeded its bound`);
  return bytes;
}

function decode(bytes, maximumBytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes) {
    throw new Error(`${label} exceeded its bound`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

export function encodeConnectorRequest(value) {
  return encode(value, CONNECTOR_MAX_REQUEST_BYTES, "Connector request");
}

export function decodeConnectorRequest(bytes) {
  return decode(bytes, CONNECTOR_MAX_REQUEST_BYTES, "Connector request");
}

export function encodeConnectorResponse(value) {
  return encode(value, CONNECTOR_MAX_RESPONSE_BYTES, "Connector response");
}

export function decodeConnectorResponse(bytes) {
  return decode(bytes, CONNECTOR_MAX_RESPONSE_BYTES, "Connector response");
}

export function validGitHubUserCredential(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= CONNECTOR_MAX_CREDENTIAL_BYTES &&
    /^gh[uis]_[A-Za-z0-9_]+$/.test(value)
  );
}

const SSH_CONFIG_DIRECTIVES = new Set([
  "User",
  "ProxyCommand",
  "UserKnownHostsFile",
  "StrictHostKeyChecking",
  "LogLevel",
  "ControlMaster",
  "IdentityFile",
]);

/**
 * Accept exactly the SSH configuration `gh codespace ssh --config` generates for one
 * Codespace under the worker's private HOME: one host block, a ProxyCommand that runs
 * the reviewed gh binary for that Codespace over stdio, and an identity file that is
 * gh's own automatically generated key inside that HOME. Every other directive
 * (LocalCommand, RemoteCommand, Include, Match, foreign key paths) is refused.
 */
export function validateCodespaceSshConfig(config, { home, resourceName }) {
  if (typeof config !== "string" || typeof home !== "string" || typeof resourceName !== "string") {
    return false;
  }
  const identityFile = `${home}/.ssh/codespaces.auto`;
  const lines = config
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const hostMatch = lines[0].match(/^Host\s+cs\.([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.\S+$/);
  if (!hostMatch || hostMatch[1] !== resourceName) return false;
  let proxy = false;
  let identity = false;
  for (const line of lines.slice(1)) {
    const match = line.match(/^([A-Za-z]+)(?:\s*=\s*|\s+)(.+)$/);
    if (!match || !SSH_CONFIG_DIRECTIVES.has(match[1])) return false;
    const [, directive, value] = match;
    if (directive === "Host") return false;
    if (directive === "ProxyCommand") {
      if (value !== `/usr/bin/gh cs ssh -c ${resourceName} --stdio -- -i ${identityFile}`) {
        return false;
      }
      proxy = true;
    }
    if (directive === "IdentityFile") {
      if (value !== identityFile) return false;
      identity = true;
    }
  }
  return proxy && identity;
}
