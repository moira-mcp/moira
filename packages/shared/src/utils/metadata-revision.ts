import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

/** Opaque optimistic-concurrency token for one independently mutable metadata target. */
export function metadataRevision(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
