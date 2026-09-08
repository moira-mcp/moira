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
