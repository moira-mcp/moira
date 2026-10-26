import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { TextDecoder } from "node:util";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { canonicalJson } from "../utils/canonical-json.js";
import { entityRevision, revisionPayload } from "./schema.js";
import type * as schema from "./schema.js";
import { revisionPreviewBytes } from "./revision-preview.js";

type Payload = typeof revisionPayload.$inferSelect;
type Database = BetterSQLite3Database<typeof schema>;

function corruptPayload(): never {
  throw new Error("Revision payload is missing or corrupt");
}

/** Complete canonical JSON is compressed independently; no earlier revision is needed. */
export function readRevisionPayload(payload: Payload | null, entityId: string): string {
  if (
    !payload ||
    payload.entityType !== "workflow" ||
    payload.entityId !== entityId ||
    payload.codec !== "gzip-json-v1" ||
    !Number.isSafeInteger(payload.decodedSize) ||
    payload.decodedSize <= 0
  )
    corruptPayload();
  try {
    const bytes = gunzipSync(payload.data, { maxOutputLength: payload.decodedSize });
    if (
      bytes.length !== payload.decodedSize ||
      createHash("sha256").update(bytes).digest("hex") !== payload.digest
    )
      corruptPayload();
    const content = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(content);
    if (canonicalJson(parsed, "ordinal") !== content) corruptPayload();
    return JSON.stringify(parsed, null, 2);
  } catch {
    corruptPayload();
  }
}

/** The caller owns the revision transaction, including payload insertion and its reference. */
export function storeWorkflowRevisionPayload(db: Database, entityId: string, content: string) {
  const parsed: unknown = JSON.parse(content);
  const compact = canonicalJson(parsed, "ordinal");
  const bytes = Buffer.from(compact, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const readable = JSON.stringify(JSON.parse(compact), null, 2);
  const found = db
    .select()
    .from(revisionPayload)
    .where(
      and(
        eq(revisionPayload.entityType, "workflow"),
        eq(revisionPayload.entityId, entityId),
        eq(revisionPayload.digest, digest),
      ),
    )
    .get();
  if (found) {
    // A matching digest must never conceal damaged stored bytes.
    readRevisionPayload(found, entityId);
    return { id: found.id, readable, size: Buffer.byteLength(readable) };
  }
  const id = randomUUID();
  db.insert(revisionPayload)
    .values({
      id,
      entityType: "workflow",
      entityId,
      digest,
      codec: "gzip-json-v1",
      data: gzipSync(bytes),
      decodedSize: bytes.length,
      preview: revisionPreviewBytes(readable),
    })
    .run();
  return { id, readable, size: Buffer.byteLength(readable) };
}

/** Forward conversion is atomic and idempotent; historical identity and authorship stay intact. */
export function migrateWorkflowRevisionPayloads(db: Database): void {
  db.transaction(
    () => {
      const legacy = db
        .select({
          id: entityRevision.id,
          entityId: entityRevision.entityId,
          content: entityRevision.content,
        })
        .from(entityRevision)
        .where(
          and(
            eq(entityRevision.entityType, "workflow"),
            isNull(entityRevision.payloadId),
            isNotNull(entityRevision.content),
          ),
        )
        .all();
      for (const row of legacy) {
        const payload = storeWorkflowRevisionPayload(db, row.entityId, row.content!);
        db.update(entityRevision)
          .set({ content: null, payloadId: payload.id })
          .where(eq(entityRevision.id, row.id))
          .run();
      }
    },
    { behavior: "immediate" },
  );
}
