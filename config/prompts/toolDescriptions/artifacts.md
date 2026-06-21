Manage static HTML artifacts with public URLs

Actions:

- upload: Create new HTML artifact, returns UUID and public URL
- update: Update existing artifact content
- delete: Delete an artifact
- list: List user's artifacts with pagination
- stats: Get quota usage statistics
- token: Generate one-time upload token for HTTP API

Usage:

- Each artifact is served on its OWN origin: {uuid}.{{ARTIFACTS_DOMAIN}}/
  (per-artifact subdomain — browser-isolated storage/cookies/ServiceWorker).
- Content is HTML and MAY contain JavaScript. It runs inside a sandboxed iframe
  with NO network access (no fetch/XHR/WebSocket) and no form submission — use
  for self-contained interactive content (dashboards, calculators,
  visualizations with data embedded in the HTML), not anything that calls a server.
- A "Created with Moira" footer and a Report control are shown around the
  artifact; viewers see a first-visit "user-generated content" warning.
- Default TTL is 30 days
- Tokens enable CI/CD integration via HTTP API

Quotas:

- Max file size: 5MB
- Max total storage: 100MB per user
- Max artifacts: 50 per user

Examples:

- artifacts({ action: "upload", name: "report.html", content: "<html>...</html>" }) - create artifact
- artifacts({ action: "upload", name: "results.html", content: "...", executionId: "abc123" }) - link to execution
- artifacts({ action: "list" }) - list artifacts
- artifacts({ action: "stats" }) - quota usage
- artifacts({ action: "token", ttlMinutes: 60 }) - get upload token
- artifacts({ action: "update", uuid: "...", content: "..." }) - update content
- artifacts({ action: "delete", uuid: "..." }) - delete artifact
