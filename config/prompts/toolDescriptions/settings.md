Read or update settings visible to the current user

Actions:

- get: Read one exact `key`, one `category`, or all visible values. Do not combine key and category.
- set: Update one existing setting by exact key; validation, encryption, and access rules apply.
- list: List visible setting definitions, optionally filtered by category.

Encrypted values are masked. Admin-only settings are hidden from non-admin users.

Examples:

- settings({ action: "get", key: "ui.theme" }) - read one setting
- settings({ action: "get", category: "notifications" }) - read one category
- settings({ action: "get" }) - read all visible values
- settings({ action: "list", category: "notifications" }) - discover valid keys
- settings({ action: "set", key: "ui.theme", value: "dark" }) - update an existing key
