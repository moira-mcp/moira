import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { ValidationError } from "../errors/index.js";

export const DEFAULT_REVISION_PREVIEW_CHARS = 100;
const MAX_PREVIEW_CHARS = 1000;

function previewLength(chars: number): number {
  if (!Number.isSafeInteger(chars) || chars < 0 || chars > MAX_PREVIEW_CHARS) {
    throw new ValidationError(
      `Preview length must be an integer between 0 and ${MAX_PREVIEW_CHARS}`,
    );
  }
  return chars;
}

/** A byte prefix retains embedded NUL and enough UTF-8 text for the UTF-16 preview contract. */
export function revisionPreviewPrefix(
  content: SQLWrapper,
  chars = DEFAULT_REVISION_PREVIEW_CHARS,
): SQL<Buffer | null> {
  return sql<Buffer | null>`substr(CAST(${content} AS BLOB),1,${4 * (previewLength(chars) + 1)})`;
}

/** The prior substring/suffix policy, applied only to bounded text selected by SQLite. */
export function renderRevisionPreview(
  prefix: Buffer | string | null,
  chars = DEFAULT_REVISION_PREVIEW_CHARS,
): string {
  previewLength(chars);
  const content = Buffer.isBuffer(prefix) ? prefix.toString("utf8") : (prefix ?? "");
  return content.length > chars ? `${content.substring(0, chars)}...` : content;
}
