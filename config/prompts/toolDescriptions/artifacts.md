Manage static HTML artifacts with public URLs

Actions:

- upload: Create new HTML artifact, returns UUID and public URL
- update: Update existing artifact content
- delete: Delete an artifact
- list: List user's artifacts with pagination
- stats: Get quota usage statistics
- token: Generate one-time upload token for HTTP API

Usage:

- Use the returned `url`; its host/path is determined by deployment configuration.
- Content is HTML and MAY contain JavaScript. It runs inside a sandboxed iframe
  with NO network access (no fetch/XHR/WebSocket) and no form submission — use
  for self-contained interactive content (dashboards, calculators,
  visualizations with data embedded in the HTML), not anything that calls a server.
- A "Created with Moira" footer and a Report control are shown around the
  artifact; viewers see a first-visit "user-generated content" warning.
- Tokens enable CI/CD integration via HTTP API
- Use `stats` for the current storage and artifact-count limits.
- File-size and retention policy are enforced by the server and may be administrator-configured. Upload and list responses include effective expiry metadata.

Examples:

- artifacts({ action: "upload", name: "report.html", content: "<html>...</html>" }) - create artifact
- artifacts({ action: "upload", name: "results.html", content: "...", executionId: "abc123" }) - link to execution
- artifacts({ action: "list" }) - list artifacts
- artifacts({ action: "stats" }) - quota usage
- artifacts({ action: "token", ttlMinutes: 60 }) - get upload token
- artifacts({ action: "update", uuid: "...", content: "..." }) - update content
- artifacts({ action: "delete", uuid: "..." }) - delete artifact
