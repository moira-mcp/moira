Manage persistent notes with versioning and tagging

Actions:

- list: List a page of notes with optional tag filter and key search
- get: Get note content by key (with optional version)
- save: Create or update a note
- delete: Soft delete a note
- history: Get version history for a note
- stats: Get usage statistics (quota)

Usage:

- Notes persist across workflow executions
- Each user has isolated note storage
- Version history is retained according to the active server policy
- Tags enable grouping and filtering
- `list` uses `limit` and `offset`; compare the returned notes with `total` to continue pagination when needed
- Use `stats` for the current total storage limit and usage. Per-note and retained-version limits are enforced by the server and may be administrator-configured.

Examples:

- notes({ action: "list" }) - first page of notes
- notes({ action: "list", tag: "preferences" }) - filter by tag
- notes({ action: "list", limit: 50, offset: 50 }) - another page of notes
- notes({ action: "get", key: "user-prefs" }) - get note
- notes({ action: "save", key: "user-prefs", value: "...", tags: ["preferences"] }) - save note
- notes({ action: "history", key: "user-prefs" }) - version history
- notes({ action: "stats" }) - quota usage

Key format: alphanumeric, underscore, hyphen (1-100 chars)
