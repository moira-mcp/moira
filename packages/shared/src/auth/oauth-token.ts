import { createHash } from "node:crypto";

/** The OAuth provider stores opaque credentials as unpadded base64url SHA-256. */
export function oauthTokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
