/**
 * Comparison of two revisions of the same versioned entity.
 *
 * The result is a sequence of parts in reading order: unchanged text, text only the later revision
 * has, and text only the earlier one had. A reader renders it; nothing here decides how it looks.
 *
 * Line granularity matches how the product already shows differences between versions of a note or
 * an MCP prompt, so one comparison reads the same wherever it is displayed.
 */

import { diffLines } from "diff";

/** One run of text in a comparison, classified by which revision contains it. */
export interface RevisionDiffPart {
  value: string;
  /** Present only in the later revision. */
  added: boolean;
  /** Present only in the earlier revision. */
  removed: boolean;
}

/** Compare the content of two revisions; absent content compares as empty. */
export function compareRevisionContent(
  before: string | null,
  after: string | null,
): RevisionDiffPart[] {
  return diffLines(before ?? "", after ?? "").map((change) => ({
    value: change.value,
    added: change.added === true,
    removed: change.removed === true,
  }));
}
