/**
 * HTML / JSON-LD escaping primitives, ported from the interim
 * `web-backend/src/routes/marketplace-pages.ts` so the new render package matches its
 * security hardening exactly. These guard the two injection surfaces the package emits
 * outside of React's auto-escaping: `<head>` meta attributes (built as strings) and the
 * `<script type="application/ld+json">` block.
 */

/** Escape a value for safe inclusion in HTML text or a double/single-quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Make a JSON string safe to embed inside a `<script>` element: escape `<` so a value
 * like `</script>` cannot break out of the tag. (U+2028/U+2029 need no handling — the
 * block is parsed as JSON-LD data, not executed as a JS string literal.)
 */
export function jsonLdSafe(json: string): string {
  return json.replace(/</g, "\\u003c");
}

/** Serialize a JSON-LD object to a `<`-escaped string ready for a `<script>` block. */
export function serializeJsonLd(data: Record<string, unknown>): string {
  return jsonLdSafe(JSON.stringify(data));
}
