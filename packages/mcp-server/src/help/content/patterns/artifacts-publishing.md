---
title: Artifacts Publishing Pattern
description: Publish HTML content with shareable public URLs
---

## Purpose

Publish static HTML content accessible via public URL. Generate reports, dashboards, and shareable documents that users can view in a browser.

Node examples are fragments of a containing workflow: named producers and connection targets must exist. Answers are producer-local: the notification below reads `generate-and-upload.report_url`; an alternative upload needs its corresponding consumer path. Publishing HTML does not prove notification delivery and requires authority to make the content public.

## When to Use

| Use Case              | Example                                                |
| --------------------- | ------------------------------------------------------ |
| **Reports**           | Purchase analysis, research results, comparison tables |
| **Dashboards**        | Status pages, metrics visualization                    |
| **Shareable content** | Documents, presentations, portfolios                   |
| **Notifications**     | Generate a report and send its URL to the user         |
| **User deliverables** | Anything user needs to view in browser                 |

:::caution
Don't use artifacts for temporary data (use notes), structured JSON storage (use notes), binary
files, frequently changing content, or authenticated content.
:::

## Structure

```
[generate-data] → [create-html] → [upload-artifact] → [share-url]
```

## Implementation

The simple examples below show the success path only: advance only after confirmed acceptance and an actual returned URL. On refusal or an uncertain outcome, remain paused or use the explicit route in Handle Errors. Missing authority does not permit a publication attempt.

### Local File and Token Upload

Prefer publishing a saved HTML file: obtain an upload URL with `artifacts({ action: "token" })`,
then POST multipart field `file` using the actual local path. Do not read the file into an MCP
argument. If linking an execution, send `executionId` in the HTTP body, not the token request.

```bash
curl -X POST "$UPLOAD_URL" \
  -F 'file=@/absolute/path/report.html;type=text/html'
```

Set `UPLOAD_URL` to the exact returned `uploadUrl`; treat it as a credential. To associate an
execution, add `-F "executionId=$EXECUTION_ID"`, where `EXECUTION_ID` is the actual existing owned
execution ID returned by `start`. Omit the field when no association is needed.
Confirm HTTP 201 and save the response's `url`, not `uploadUrl`.
Token creation alone is not publication. A refused content upload leaves a valid token usable;
successful creation consumes it. This sequential contract does not guarantee atomic exactly-once
creation for concurrent requests. Reconcile an uncertain result before retrying.

### Inline Fallback

Use inline MCP upload when the agent cannot send the saved file over HTTP:

```json
{
  "id": "generate-and-upload",
  "type": "agent-directive",
  "directive": "Generate HTML report from analysis data.\n\n**Data:**\n{{note:analysis-results}}\n\nCreate responsive HTML with Tailwind CDN.\n\nUpload using:\nartifacts({ action: \"upload\", name: \"report.html\", content: \"<html>...\" })\n\nSave the returned `url` as report_url.",
  "completionCondition": "Report uploaded and URL obtained",
  "inputSchema": {
    "type": "object",
    "required": ["report_url"],
    "properties": {
      "report_url": { "type": "string" }
    }
  },
  "connections": { "success": "notify-user" }
}
```

### Token-based Upload Pattern

Use this node in the containing workflow when a previous node has saved the file:

```json
{
  "id": "upload-via-token",
  "connections": { "success": "notify-token-user" },
  "type": "agent-directive",
  "completionCondition": "Actual HTML upload accepted and returned URL captured",
  "directive": "Publish the saved HTML file within existing authority.\n\n1. Get token: artifacts({ action: \"token\", ttlMinutes: 30 })\n2. POST to the returned uploadUrl as multipart/form-data with file=@{{create-html.file_path}}; do not copy file content into MCP arguments. If needed, add executionId as an HTTP form field.\n3. Inspect the actual HTTP response; only a confirmed successful upload and returned artifact url permit success. Reconcile uncertain outcomes before retrying.\n4. Save the returned url as report_url.",
  "inputSchema": {
    "properties": {
      "report_url": { "type": "string" }
    },
    "required": ["report_url"]
  }
}
```

### Conditional Based on Capabilities

Route based on the agent's ability to create a local file and upload it over HTTP; the capability
producer must set `can_upload_file_http` from both requirements:

```json
{
  "id": "check-file-access",
  "type": "condition",
  "cases": [
    {
      "when": {
        "operator": "eq",
        "left": { "contextPath": "collect-capabilities.can_upload_file_http" },
        "right": true
      },
      "output": "can-create-files"
    }
  ],
  "connections": {
    "can-create-files": "generate-file-then-upload",
    "default": "generate-and-upload-direct"
  }
}
```

## MCP Tool Usage

The inline upload examples in this section are the fallback; use the file/token route above for
saved HTML. Update replaces an existing artifact through MCP.

### Upload Artifact

```typescript
artifacts({
  action: "upload",
  name: "purchase-report.html",
  content: `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 p-8">
  <h1 class="text-2xl font-bold">Report</h1>
</body>
</html>`,
  executionId: "00000000-0000-4000-8000-000000000001", // Optional: link to workflow
});
```

Response:

```json
{
  "uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "url": "https://a1b2c3d4-e5f6-7890-abcd-ef1234567890.{STATIC_DOMAIN}/",
  "name": "purchase-report.html",
  "size": 1234,
  "expiresAt": "2025-02-28T10:00:00.000Z"
}
```

The MCP result is flat metadata. The URL above illustrates configured subdomain hosting; use the
actual returned `url` rather than constructing it. HTTP upload has its separate `data` envelope.

### Update Artifact

```typescript
artifacts({
  action: "update",
  uuid: "a1b2c3d4-e5f6-4890-abcd-ef1234567890",
  content: "<html>...updated...</html>",
  name: "report-v2.html", // Optional
});
```

### Check Quota

```typescript
artifacts({
  action: "stats",
});
// Returns: totalArtifacts, totalSize, storageLimit, countLimit,
// maxFileSizeBytes, storageUsedPercent, countUsedPercent
```

### List Artifacts

```typescript
artifacts({
  action: "list",
  limit: 20,
});
```

## Quotas and Limits

Use `stats` for effective storage/count quotas and `maxFileSizeBytes`, measured as decoded HTML
UTF-8 bytes. A user-specific file-size override takes precedence over global
`artifacts.max_file_size_mb`, then the 5 MiB default; clearing it restores inheritance.
Storage and count remain separate quotas. Treat each returned `expiresAt` as authoritative;
the missing-artifact page does not establish a fixed lifetime.
The `ttlMinutes` input schema states the accepted upload-token lifetime range.

:::tip
Check quota before upload with `artifacts({ action: "stats" })`. Delete only artifacts whose removal is authorized; a quota warning is not permission to delete another deliverable.
:::

## HTML Generation Tips

### Use Tailwind CDN

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-gray-50 min-h-screen">
    <!-- Content -->
  </body>
</html>
```

### Responsive Layout

```html
<div class="container mx-auto px-4 py-8">
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    <!-- Cards -->
  </div>
</div>
```

### Product Card

```html
<div class="bg-white rounded-lg shadow-md p-6">
  <h3 class="text-lg font-semibold">Product Name</h3>
  <p class="text-gray-600 mt-2">Description</p>
  <div class="mt-4 flex justify-between items-center">
    <span class="text-2xl font-bold text-green-600">$999</span>
    <a
      href="https://store.com/product"
      class="bg-blue-500 text-white px-4 py-2 rounded"
      target="_blank"
      rel="noopener noreferrer"
    >
      Buy Now
    </a>
  </div>
</div>
```

### Comparison Table

```html
<table class="w-full border-collapse">
  <thead>
    <tr class="bg-gray-100">
      <th class="border p-3 text-left">Product</th>
      <th class="border p-3 text-left">Price</th>
      <th class="border p-3 text-left">Rating</th>
    </tr>
  </thead>
  <tbody>
    <tr class="hover:bg-gray-50">
      <td class="border p-3">Product A</td>
      <td class="border p-3">$599</td>
      <td class="border p-3">4.5/5</td>
    </tr>
  </tbody>
</table>
```

## Integration with Notifications

Combine with a channel-neutral user notification:

```json
{
  "id": "notify-user",
  "type": "user-notification",
  "message": "Report ready: {{generate-and-upload.report_url}}",
  "format": "plain",
  "connections": { "default": "end", "error": "end" }
}
```

## Real Example

From a purchase analysis workflow:

```json
{
  "id": "create-report",
  "connections": { "success": "notify-report-user" },
  "completionCondition": "Report reflects the actual analysis and publication is authorized and accepted",
  "type": "agent-directive",
  "directive": "Create and save a local HTML report with product recommendations.\n\n**Analysis data:**\n{{note:purchase-{{executionId}}-03-analysis}}\n\nGenerate responsive HTML:\n- Product cards with images, prices, links\n- Comparison table\n- Recommendation summary\n\nWithin publication authority, obtain artifacts({ action: \"token\" }) and POST the local file to the returned uploadUrl as multipart field file, with executionId=\"{{executionId}}\" in the HTTP body. Save the confirmed response url as report_url. If HTTP upload is unavailable, use inline artifacts upload with name, content and executionId. On refusal or uncertain outcome follow the explicit error-handling pattern; never invent a URL.",
  "inputSchema": {
    "properties": {
      "report_url": { "type": "string" }
    },
    "required": ["report_url"]
  }
}
```

## Best Practices

### Descriptive Names

```typescript
// Good
artifacts({ action: "upload", name: "purchase-analysis-2025-01-31.html", content: htmlContent });

// Bad
artifacts({ action: "upload", name: "report.html", content: htmlContent });
```

### Link to Execution

For token uploads, add `executionId` to the HTTP form or JSON body. The equivalent inline fallback is:

```typescript
artifacts({
  action: "upload",
  name: "report.html",
  content: htmlContent,
  executionId: context.executionId,
});
```

Benefits:

- Track which execution created which artifact
- Query artifacts by execution
- Execution association does not imply automatic deletion when it is archived

### Handle Errors

The upload owner records what actually happened, then routes on its node-local answer. The success notification reads this owner's URL; it does not reuse the earlier direct-upload example's value. Add the following nodes to a containing workflow whose `end` target exists:

```json
[
  {
    "id": "upload-report",
    "type": "agent-directive",
    "directive": "Publish the HTML report only within existing authority and inspect the actual upload response. Report uploaded only when acceptance and the returned URL are established. Record refused for an explicit refusal, and uncertain when a timeout or lost response leaves acceptance unknown. Give the observed reason for refused or uncertain; do not invent a URL. Before retrying an uncertain operation, reconcile its actual result. If reconciliation establishes an already accepted artifact, return its authoritative URL without uploading again.",
    "completionCondition": "The observed upload outcome is recorded honestly, with an accepted URL or the actual refusal/uncertainty reason",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "upload_outcome": { "type": "string", "enum": ["uploaded", "refused", "uncertain"] },
        "report_url": { "type": "string", "minLength": 1 },
        "upload_reason": { "type": "string", "minLength": 1 }
      },
      "required": ["upload_outcome"],
      "if": {
        "properties": { "upload_outcome": { "const": "uploaded" } },
        "required": ["upload_outcome"]
      },
      "then": {
        "required": ["report_url"],
        "not": { "required": ["upload_reason"] }
      },
      "else": {
        "required": ["upload_reason"],
        "not": { "required": ["report_url"] }
      }
    },
    "cases": [
      {
        "when": {
          "operator": "neq",
          "left": { "contextPath": "upload-report.upload_outcome" },
          "right": "uploaded"
        },
        "output": "upload-blocked"
      }
    ],
    "connections": {
      "success": "notify-upload-result",
      "upload-blocked": "handle-upload-error"
    }
  },
  {
    "id": "notify-upload-result",
    "type": "user-notification",
    "message": "Report ready: {{upload-report.report_url}}",
    "format": "plain",
    "connections": { "default": "end", "error": "end" }
  },
  {
    "id": "handle-upload-error",
    "type": "agent-directive",
    "directive": "The upload outcome is {{upload-report.upload_outcome}}. Observed reason: {{upload-report.upload_reason}}. Preserve the report and explain the actual blocker to the user. Diagnose an explicit refusal, or reconcile whether an uncertain upload was accepted before considering another attempt. Resolve only within existing authority. If a required decision, access or authoritative outcome remains unavailable, stay paused and obtain it through the supported user-input mechanism; do not submit a successful completion or blindly retry.",
    "completionCondition": "The refusal cause is resolved or the uncertain outcome is authoritatively reconciled, and a specific authorized continuation through the upload owner is justified; otherwise remain paused",
    "connections": { "success": "upload-report" }
  }
]
```

An empty answer is invalid here. A schema-valid `refused` or `uncertain` answer takes the authored `upload-blocked` route; only `uploaded` reaches the success notification. The schema checks the submitted shape, not the truth of an upload claim. The reconciliation owner must not complete while its blocker remains unresolved; a retry is justified by a resolved cause or established outcome, not by a new counter value.

A tool error inside an agent-directive does not by itself select reserved `connections.error`. That control output is distinct from this explicit observed-outcome route. Public token upload accepts POST multipart/form-data with field `file` or JSON `{name, content}`; observe size limits, expiry and one-time token use.

## Anti-patterns

### Using Artifacts for Data Storage

Use notes for JSON data, artifacts for presentable HTML only.

### Not Checking Quotas

Always check `stats` before large uploads. Handle quota exceeded errors.

### Non-responsive HTML

Use Tailwind or media queries. Fixed-width layouts break on mobile.

## Related Patterns

- [Notes Persistence](/docs/patterns/notes-persistence/) - For structured data storage
- [Workspace](/docs/patterns/workspace/) - For file organization
