---
title: Materialize Files
description: Deliver bounded registry-backed files through a short-lived reusable tar grant
---

A `materialize` node delivers workflow-authored files to the agent filesystem, keeping their rendered
bodies out of the step response. Moira issues a short-lived archive command, pauses the execution,
and advances only after the agent submits an empty completion. A host that cannot run that command
delivers through the context fallback described below and completes the step the same way.

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
mkdir -p -- '<basePath>' && curl -sSf -- '<reusable-url>' | tar -x -C '<basePath>'
```

Run the emitted command exactly. The URL is an opaque bearer credential: do not reconstruct, edit,
log, or share it. The same command may be retried during its five-minute lifetime while the
execution is still waiting on this node. After extraction succeeds, complete the step with `null`
or `{}`. No other input shape is accepted.

The generated directive states the lifetime and retry behavior, warns that advancing the execution
invalidates the URL, names the context-delivery fallback below as conditional on this host being
unable to run the command, and explains that delivery does not prove reading on either route. Calling
`session({ action: "current_step" })` while the execution is paused issues a fresh command and grant
without advancing the graph. A later directive must still explicitly require the agent to read each
materialized file it uses.

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
execution must still be running and waiting at that same materialize node. The server reauthorizes
every request against those bindings, so the same grant supports repeated downloads during the
absolute five-minute window but stops working immediately after the execution advances. Request
logging redacts the credential from the materialize URL.

| Failure                                                                                                                    | Result                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid node definition, rendered destination, configuration, database access, or grant issuance while presenting the step | Follow `connections.error` when present; otherwise the execution surfaces the error                                                                    |
| Invalid, expired, or incorrectly bound URL                                                                                 | HTTP 401 with `Invalid or expired materialize token`                                                                                                   |
| Invalid rendered archive path, missing registry source, template failure, or size-limit violation                          | HTTP 400 with `Materialize archive could not be generated`                                                                                             |
| Local `curl`, pipe, filesystem, or `tar` failure                                                                           | Unreachable network qualifies for the context fallback; a local filesystem or `tar` failure is a blocker the agent reports without completing the step |
| Context delivery of a set larger than 256 KiB                                                                              | The tool answers with a named refusal and delivers no files                                                                                            |

:::caution
`connections.error` cannot catch a download or extraction failure because those operations happen
after the step has already been presented.
:::

## Deliver into the agent's context instead

A host that cannot run a shell command or reach the network in the current turn has a second route:

```text
session({ action: "materialize", executionId: "<process-id>" })
```

It returns the same rendered bodies the archive would have contained, one text block per file headed
by that file's path, and writes nothing to a filesystem. It takes no grant: the server resolves the
grant of the node's current presentation from the caller's own execution, so the archive URL never
has to travel through the response.

This route spends context, so it is the fallback rather than the default, and the presented directive
says so. Prefer the emitted command whenever the host can run it.

Its authorization is the archive channel's: the same user, the same execution still waiting at that
same node, the same context revision, the same five-minute window. Every refusal answers with one
message that does not say which condition failed, so a refusal never reveals whether an execution
belongs to someone else.

Because the bodies land in a context window rather than on a disk, this route also refuses a set
larger than 256 KiB in total, well below the archive limits above. It refuses rather than truncating:
a shortened file is indistinguishable from a complete one to the agent reading it, and the emitted
command remains available for a set that large.

Delivery still does not prove reading. Read each delivered file that a later directive requires,
then complete the step with `null` or `{}` as usual.

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
