import { createHmac, timingSafeEqual } from "node:crypto";
import { CodespaceResourceError } from "./resource-types.js";

export interface CodespaceFileBootstrapClaims {
  kind: "bootstrap";
  userId: string;
  resourceId: string;
  provider: string;
  resourceGeneration: number;
  authorizationGeneration: number;
  environmentIdentity: string;
  operationId: string;
  expiresAt: number;
}

export interface CodespaceFileTransferClaims extends Omit<CodespaceFileBootstrapClaims, "kind"> {
  kind: "transfer";
  transferId: string;
  direction: "guest_to_server" | "server_to_guest";
  size: number;
  sha256: string;
}

export type CodespaceFileCapabilityClaims =
  CodespaceFileBootstrapClaims | CodespaceFileTransferClaims;

const COMMON_KEYS = [
  "kind",
  "userId",
  "resourceId",
  "provider",
  "resourceGeneration",
  "authorizationGeneration",
  "environmentIdentity",
  "operationId",
  "expiresAt",
];
const HASH = /^[a-f0-9]{64}$/;

function refuse(): never {
  throw new CodespaceResourceError(
    "CODESPACE_AUTHORIZATION_REQUIRED",
    "File capability is invalid or expired",
  );
}

function validate(value: unknown, now: number): CodespaceFileCapabilityClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const claims = value as Record<string, unknown>;
  const transfer = claims.kind === "transfer";
  const keys = transfer
    ? [...COMMON_KEYS, "transferId", "direction", "size", "sha256"]
    : COMMON_KEYS;
  if (
    (!transfer && claims.kind !== "bootstrap") ||
    Object.keys(claims).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(claims, key)) ||
    ["userId", "resourceId", "provider", "operationId", ...(transfer ? ["transferId"] : [])].some(
      (key) =>
        typeof claims[key] !== "string" ||
        !claims[key] ||
        Buffer.byteLength(claims[key] as string) > 256 ||
        [...(claims[key] as string)].some(
          (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
        ),
    ) ||
    !["resourceGeneration", "authorizationGeneration", "expiresAt"].every(
      (key) => Number.isSafeInteger(claims[key]) && Number(claims[key]) > 0,
    ) ||
    Number(claims.expiresAt) <= now ||
    typeof claims.environmentIdentity !== "string" ||
    !HASH.test(claims.environmentIdentity) ||
    (transfer &&
      (!Number.isSafeInteger(claims.size) ||
        Number(claims.size) < 0 ||
        typeof claims.sha256 !== "string" ||
        !HASH.test(claims.sha256) ||
        !["guest_to_server", "server_to_guest"].includes(String(claims.direction))))
  )
    refuse();
  return claims as unknown as CodespaceFileCapabilityClaims;
}

/** Narrow file-only credentials; current provider authority is checked separately on every use. */
export class CodespaceFileCapabilities {
  constructor(
    private readonly signingKey: string,
    private readonly now: () => number = Date.now,
  ) {
    if (Buffer.byteLength(signingKey) < 32)
      throw new Error("File capability signing key is unavailable");
  }

  issue(claims: CodespaceFileCapabilityClaims): string {
    validate(claims, this.now());
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `csf1.${payload}.${this.signature(payload).toString("base64url")}`;
  }

  read(token: string): CodespaceFileCapabilityClaims {
    if (typeof token !== "string" || token.length > 4096) refuse();
    const match = /^csf1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) refuse();
    const actual = Buffer.from(match[2], "base64url");
    const expected = this.signature(match[1]);
    if (
      actual.length !== expected.length ||
      actual.toString("base64url") !== match[2] ||
      !timingSafeEqual(actual, expected)
    )
      refuse();
    try {
      const bytes = Buffer.from(match[1], "base64url");
      if (bytes.toString("base64url") !== match[1]) refuse();
      return validate(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        this.now(),
      );
    } catch {
      return refuse();
    }
  }

  private signature(payload: string): Buffer {
    return createHmac("sha256", this.signingKey)
      .update("moira/codespace-files/v1\0")
      .update(payload)
      .digest();
  }
}
