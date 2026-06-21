Manage persistent notes with versioning and tagging

Actions:

- list: List notes with optional tag filter and key search
- get: Get note content by key (with optional version)
- save: Create or update a note
- delete: Soft delete a note
- history: Get version history for a note
- stats: Get usage statistics (quota)

Usage:

- Notes persist across workflow executions
- Each user has isolated note storage
- Version history preserved for all changes
- Tags enable grouping and filtering

Examples:

- notes({ action: "list" }) - all notes
- notes({ action: "list", tag: "preferences" }) - filter by tag
- notes({ action: "get", key: "user-prefs" }) - get note
- notes({ action: "save", key: "user-prefs", value: "...", tags: ["preferences"] }) - save note
- notes({ action: "history", key: "user-prefs" }) - version history
- notes({ action: "stats" }) - quota usage

Key format: alphanumeric, underscore, hyphen (1-100 chars)
Size limits: 100KB per note, 1MB total per user
