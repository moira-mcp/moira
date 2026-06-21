Get, set, or list user and admin settings

Actions:

- get: Get specific setting value
- set: Update setting value (user settings only)
- list: List all available settings

Examples:

- settings({ action: "list" }) - all settings
- settings({ action: "get", key: "notifications.telegram" })
- settings({ action: "set", key: "notifications.telegram", value: true })
