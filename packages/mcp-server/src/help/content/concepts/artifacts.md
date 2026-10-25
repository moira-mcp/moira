---
title: Artifacts
description: Static HTML hosting for workflow outputs - reports, dashboards, and visualizations with public URLs
---

Artifacts provide static HTML hosting for workflow outputs. Upload HTML content (reports, dashboards, visualizations) and receive public URLs for sharing. JavaScript runs inside a sandboxed frame with a Moira branding bar. Origin layout depends on deployment configuration; use the returned URL. Public artifacts must not contain credentials or confidential data.

## Use Cases

- **Reports**: Generate analysis reports accessible via URL
- **Dashboards**: Create interactive HTML dashboards (JavaScript runs in-page)
- **Visualizations**: Host charts, graphs, and data visualizations with the data
  embedded in the HTML (application API calls are blocked)
- **Documentation**: Publish generated documentation
- **Previews**: Share work-in-progress outputs with stakeholders

## MCP Tool

For a generated HTML file, use the [token upload](#upload-tokens): obtain an upload URL,
send the local file over HTTP as multipart field `file`, then retain the returned artifact URL.
The `upload` action accepts inline HTML when HTTP file upload is unavailable.

The `artifacts` MCP tool provides these actions:

```json
artifacts({ action: "token", ttlMinutes: 60 })
artifacts({ action: "upload", name: "report.html", content: "<html>...</html>" })
artifacts({ action: "update", uuid: "abc-123", content: "<html>...</html>" })
artifacts({ action: "delete", uuid: "abc-123" })
artifacts({ action: "list", limit: 10 })
artifacts({ action: "stats" })
```

| Action   | Purpose                          |
| -------- | -------------------------------- |
| `token`  | Get a URL for HTTP file upload   |
| `upload` | Inline fallback, returns URL     |
| `update` | Update existing artifact content |
| `delete` | Remove an artifact               |
| `list`   | List artifacts with pagination   |
| `stats`  | Quota usage statistics           |

### Inline Upload Fallback

When HTTP file upload is unavailable, create an artifact from inline HTML. Use the returned URL;
its origin is configured by the deployment.

```json
artifacts({
  action: "upload",
  name: "analysis-report.html",
  content: "<html><body><h1>Report</h1></body></html>"
})
→ {
    uuid: "d0a925d6-7dd8-49ba-b90c-d03b43062d20",
    url: "https://d0a925d6-7dd8-49ba-b90c-d03b43062d20.{STATIC_DOMAIN}/",
    name: "analysis-report.html",
    size: 52,
    expiresAt: "2024-03-01T10:00:00Z"
  }
```

Optional `executionId` links artifact to a workflow execution for tracking.

### Update

Replace content of an existing artifact:

```json
artifacts({
  action: "update",
  uuid: "d0a925d6-7dd8-49ba-b90c-d03b43062d20",
  content: "<html><body><h1>Updated Report</h1></body></html>"
})
```

### List

Retrieve artifacts with pagination:

```json
artifacts({ action: "list", limit: 10, offset: 0 })
→ {
    artifacts: [{
      uuid: "d0a925d6-...",
      url: "https://d0a925d6-....{STATIC_DOMAIN}/",
      name: "report.html",
      size: 1024,
      createdAt: "2024-01-15T10:00:00Z"
    }],
    total: 5
  }
```

### Quotas and retention

Check `stats` for the effective storage quota, artifact-count quota and `maxFileSizeBytes`.
The file limit measures decoded HTML in UTF-8 bytes, rather than its escaped JSON representation.
An administrator can override it per user; an unset override inherits the global
`artifacts.max_file_size_mb` setting, then the 5 MiB default. One MiB is 1,048,576 bytes.
Storage and count quotas are independent. Each returned `expiresAt` is authoritative for that
artifact; a missing-page response does not establish a particular retention period.

```json
artifacts({ action: "stats" })
→ {
    totalArtifacts: 5,
    totalSize: 51200,
    storageLimit: 104857600,
    countLimit: 50,
    maxFileSizeBytes: 5242880,
    storageUsedPercent: 0.05,
    countUsedPercent: 10
  }
```

## Upload Tokens

Generate a one-time token to publish a local HTML file without copying its contents into an MCP
argument. Creating the token does not publish the file.

```json
artifacts({ action: "token", ttlMinutes: 30 })
→ {
    token: "xyz-789",
    expiresAt: "2024-01-15T10:30:00Z",
    uploadUrl: "https://{MOIRA_HOST}/api/public/artifacts/upload/xyz-789"
  }
```

Upload via HTTP:

```bash
curl -X POST "$UPLOAD_URL" \
  -F 'file=@/absolute/path/report.html;type=text/html'
```

Set `UPLOAD_URL` to the exact `uploadUrl` returned by the token action. To associate an execution,
add `-F "executionId=$EXECUTION_ID"`, where `EXECUTION_ID` is the actual existing owned execution ID
returned by `start`. Omit it when no association is needed. The filename supplies
the artifact name. JSON `{name, content, executionId?}` is also accepted. Confirm HTTP 201 and
retain the response's actual `url`; the upload URL is a credential, not the public artifact URL.

Tokens expire after the specified TTL and are marked used after successful creation. A content
refusal does not consume a valid token. This sequential behavior does not guarantee atomic
exactly-once creation under concurrent uploads. Reconcile a lost response before another attempt.

## Security

Artifacts may contain JavaScript, so each one is sandboxed at multiple layers:

- **Configured artifact URL** — use the `url` returned by upload or list. Deployments configured
  with per-artifact subdomains isolate storage, cookies, and Service Workers between artifact
  origins; the exact host and path come from deployment configuration.
- **Sandboxed frame** — artifact content runs inside an `<iframe sandbox="allow-scripts">`
  (no `allow-same-origin`, no forms, no top-navigation, no popups) within a
  Moira-controlled wrapper page. Scripts run, but cannot reach the wrapper.
- **Restricted connections** — `connect-src 'none'` blocks fetch/XHR/WebSocket/beacon,
  and forms are blocked. HTTPS images and the explicitly allowed script/style/font resources
  can still load. This is not a guarantee against all outbound requests or disclosure; embed
  visualization data and never publish secrets.
- **First-visit warning** — viewers see an interstitial noting the content is
  user-generated and not endorsed by Moira before the artifact is shown.

| Protection             | Value                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| Frame CSP              | scripts allowed; `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'` |
| Frame sandbox          | `allow-scripts` only                                                           |
| X-Content-Type-Options | `nosniff`                                                                      |
| Origin isolation       | deployment-configured artifact URL                                             |

:::caution
JavaScript runs but **application connections are blocked** — `fetch`, `XHR`, and `WebSocket` are blocked. Use
artifacts for self-contained interactive content (dashboards, calculators, visualizations with
embedded data), not for anything that needs to call a server.
:::

## Branding and reporting

Every artifact is shown inside a wrapper page with a fixed footer bar:

- **Attribution** — a "Created with Moira" link. Because the footer lives in the
  wrapper (a separate document from the artifact), artifact content cannot
  overlap or remove it.
- **Report** — a "Report" link lets viewers flag abusive content for review.
  Administrator notification uses their enabled, configured communication channels and is best effort;
  absence or failure of delivery does not invalidate the report submission.

The wrapper chrome (the first-visit warning and the footer) is shown in English
or Russian based on the viewer's browser language, with an EN/RU toggle in the
bottom-right corner. This affects only the Moira wrapper, never the artifact
content itself.

Abusive artifacts can be taken down by administrators, after which they
immediately stop being served.

## Workflow Integration

### Workspace Pattern

Use artifacts with the workspace pattern to organize workflow outputs:

```
./project-analysis/
├── step-1/
│   └── data-collection.md
├── step-2/
│   └── analysis.md
└── artifacts/
    ├── dashboard.html      # → upload as artifact
    └── summary-report.html # → upload as artifact
```

### Linking to Executions

Pass `executionId` in the multipart or JSON upload body to link a token upload to an execution.
For inline MCP upload, use the action argument:

```json
artifacts({
  action: "upload",
  name: "execution-report.html",
  content: "...",
  executionId: "exec-abc-123"
})
```

Linked artifacts appear in the execution inspector UI.

## Web UI

Artifacts are managed through the web interface at `/app/artifacts`:

- Browse artifacts with name, size, URL, and expiration date
- Upload new artifacts with HTML editor
- Edit existing artifact content
- Copy public URL to clipboard
- Open artifacts in new tab
- Delete artifacts
- Monitor quota usage with visual indicator

## Related

- [MCP Tools Reference](/docs/reference/tools/) — `artifacts` tool actions and schemas
- [Workflow Creation](/docs/guides/workflow-creation/) — Workspace pattern for organizing outputs
