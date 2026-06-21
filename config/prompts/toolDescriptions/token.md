Generate temporary token for uploading/downloading large workflows

Scope: ONLY for file-based workflow import/export. For normal workflow operations use manage() tool.

Actions:

- upload: Generate token for uploading workflow via HTTP
- download: Generate token for downloading workflow

Usage:

- Upload tokens allow external tools to upload workflow JSON files
- Download tokens require workflowId
- Tokens expire after ttlMinutes (default: 60)

Examples:

- token({ action: "upload" })
- token({ action: "download", workflowId: "john/my-flow" })

Related: Use manage() for creating/editing workflows directly
