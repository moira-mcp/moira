/**
 * The documentation page for the reader's language.
 *
 * The documentation site (`packages/docs`, Starlight) serves English at its root — `/docs/...` — and
 * every other language under its own prefix — `/ru/docs/...`. Links in the application and the
 * help URLs the server sends are written as root paths; this maps one to the reader's language.
 */

/** Languages the documentation site serves under their own prefix (its non-root locales). */
const PREFIXED_DOCS_LANGUAGES = new Set(["ru"]);

/**
 * `path` in the documentation for `language` (an i18next code such as `ru` or `ru-RU`).
 *
 * Only a root documentation path (`/docs` or `/docs/...`) is mapped; anything else — an external
 * URL, a path already carrying a language prefix, an application route — is returned unchanged.
 */
export function localizedDocsPath(path: string, language: string | undefined): string {
  if (!(path === "/docs" || path.startsWith("/docs/"))) return path;
  const base = language?.toLowerCase().split("-")[0];
  return base && PREFIXED_DOCS_LANGUAGES.has(base) ? `/${base}${path}` : path;
}
