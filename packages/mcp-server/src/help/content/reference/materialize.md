---
title: Materialize Files
description: Deliver bounded registry-backed files to an agent through a one-use tar archive
---

A `materialize` node delivers workflow-authored files to the agent filesystem without placing their
rendered bodies in the step response. Moira issues a short-lived archive command, pauses the
execution, and advances only after the agent runs the command and submits an empty completion.

Use this node for stable files owned by the workflow definition, such as instructions, standards,
or empty directory skeletons. Files whose contents depend on the agent's analysis remain the
responsibility of the agent-directive that produces them.

## Define the node

Store reusable text in a string entry of `variableRegistry`, then reference it with `from`:

```json
{
  "variableRegistry": {
    "workspace_reference": {
      "type": "string",
      "description": "Instructions delivered to the workspace",
      "default": "# Workspace reference\n\nFollow the project contract."
    }
  },
  "nodes": [
    {
      "id": "materialize-workspace",
      "type": "materialize",
      "basePath": "{{workspace_path}}",
      "files": [
        { "path": "reference.md", "from": "workspace_reference" },
        { "path": "plans/.keep", "content": "" }
      ],
      "connections": {
        "success": "work",
        "error": "materialize-failed"
      }
    }
  ]
}
```

| Property              | Required | Contract                                                                                           |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `basePath`            | Yes      | Templated destination directory; its rendered value must be non-empty and contain no NUL character |
| `files`               | Yes      | Between 1 and 100 archive entries                                                                  |
| `files[].path`        | Yes      | Templated safe path relative to `basePath`                                                         |
| `files[].from`        | One of   | Name of a string registry entry whose current `default` supplies the file body                     |
| `files[].content`     | One of   | Must be exactly `""`; creates an empty skeleton file                                               |
| `connections.success` | Yes      | Successor after an empty completion input                                                          |
| `connections.error`   | No       | Route for a presentation-time validation, configuration, database, or grant-issuance error         |

Every file must declare exactly one of `from` and `content`. Non-empty inline `content` is rejected;
use one registry entry as the source of truth instead.

## Run the generated command

When the node is presented, Moira renders `basePath` and the path summary, creates a five-minute
grant, and returns a POSIX command with every argument already shell-quoted:

```bash
mkdir -p -- '<basePath>' && curl -sSf -- '<one-use-url>' | tar -x -C '<basePath>'
```

Run the emitted command exactly. The URL is an opaque bearer credential: do not reconstruct, edit,
log, or share it. After extraction succeeds, complete the step with `null` or `{}`. No other input
shape is accepted.

Calling `session({ action: "current_step" })` while the execution is paused issues a fresh command
and grant without advancing the graph. Completing the step does not prove that extraction happened,
so make the successor verify any file that is required for its work.

## Archive and path contract

Moira reloads the current workflow when the URL is requested. It renders each path and each
registry-backed body using the execution context bound to the grant, then creates an uncompressed tar
archive. An edit made after the command was issued can therefore change archive paths or contents,
but cannot change the destination embedded in that command.

Archive entries contain only paths relative to `basePath`; the destination itself is not included.
Both declared and rendered paths must be normalized, non-empty, relative, and unique. Moira rejects
NUL characters, absolute or backslash-rooted paths, empty segments, and `.` or `..` segments.

Resource limits are enforced on rendered UTF-8 content:

- no more than 100 files;
- no more than 1 MiB per file;
- no more than 10 MiB total uncompressed content.

Files are emitted with mode `0644`. The engine validates `basePath`, but it does not confine the
destination to a project directory. Workflow authors must derive it from a trusted workspace path,
and agents must inspect the emitted destination before running the command.

## Grant and error behavior

The five-minute grant is stored server-side and bound to the current user, execution, and node. The
execution must still be running and waiting at that same materialize node. A valid grant is claimed
atomically only after the archive has been rendered successfully, so it can be used for exactly one
successful download. Request logging redacts the credential from the materialize URL.

| Failure                                                                                                                    | Result                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Invalid node definition, rendered destination, configuration, database access, or grant issuance while presenting the step | Follow `connections.error` when present; otherwise the execution surfaces the error  |
| Invalid, expired, already used, or incorrectly bound URL                                                                   | HTTP 401 with `Invalid or expired materialize token`                                 |
| Invalid rendered archive path, missing registry source, template failure, or size-limit violation                          | HTTP 400 with `Materialize archive could not be generated`; the grant is not claimed |
| Local `curl`, pipe, filesystem, or `tar` failure                                                                           | The agent reports the blocker and does not complete the step                         |

:::caution
`connections.error` cannot catch a download or extraction failure because those operations happen
after the step has already been presented. There is no textual fallback for file bodies.
:::

## Apply it in Workflow Management Flow

Workflow Management Flow resolves the workspace once, then materializes its stable bootstrap files
before routing to create or edit work:

```text
get-action-type
  -> materialize-workspace-bootstrap
  -> route-action-type
       | create -> gather-workflow-requirements
       | edit   -> prepare-edit-workflow
```

Its materialize declaration is equivalent to:

```json
{
  "id": "materialize-workspace-bootstrap",
  "type": "materialize",
  "basePath": "{{workspace_path}}",
  "files": [
    { "path": "process-id.txt", "from": "workspace_process_id_file" },
    { "path": "workflow-authoring-reference.md", "from": "workflow_authoring_reference" }
  ],
  "connections": { "success": "route-action-type" }
}
```

The preceding owner writes the global `workspace_path`. Registry defaults supply the execution ID
and the authoring reference. Later create and edit owners write dynamic requirements, provenance,
plans, and review reports; they do not rewrite these stable bootstrap files.

## Convert a manual bootstrap

To replace an agent directive that manually writes stable workflow-authored files:

1. Move each stable body into one string `variableRegistry` default.
2. Have an existing early responsibility return the trusted global path used by `basePath`.
3. Insert one `materialize` node after that owner and before the first consumer.
4. Remove only the corresponding static-file instructions from later directives. Keep dynamic file
   creation with the responsibility that determines the content.
5. Validate the workflow and test the emitted command, archive entries, rendered bodies, and the
   success and failure routes.

## Related

- [Nodes](/docs/concepts/nodes/)
- [Workspace Pattern](/docs/patterns/workspace/)
- [Dynamic Files](/docs/patterns/dynamic-files/)
- [Workflow Validation](/docs/reference/validation/)
