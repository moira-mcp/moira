# Logs, audit and metrics

Use structured diagnostic logs to explain failures, audit rows to record domain actions, and metrics to summarize behavior. These have different persistence and identity rules; none substitutes for an execution/workspace original receipt. HTTP/UI response shapes live in [the API reference](../reference/http-api.md).

## Service logs and error boundaries

Application code uses `createLogger({component: Component.…})` from shared logging; production `console.*` is restricted by ESLint. Entrypoints set the global service (`web-backend`, `mcp-server`); AsyncLocalStorage contributes request/user identity. Production uses JSON, development readable text. `LOG_LEVEL` controls verbosity, and configured `LOG_FILE` adds bounded file output. Use actual Compose service names when reading logs:

```bash
docker compose logs --tail 100 moira
```

Add stable structured fields and pass the original error object rather than interpolating secrets or serializing entire request state. Throw at the domain owner; catch/classify/log once at the serving boundary. Operational input, authentication, authorization, missing-resource and conflict errors are warnings; unexpected database/configuration/external/internal failures are errors. A known refusal must not disappear merely because its user-facing message is sanitized, or be upgraded into a stack-bearing error solely because it is unsuccessful.

Request context carries request ID, operation, sanitized input and selected resource IDs. The service logger attaches the input snapshot only at error level. Use [sanitizeInput](../../packages/shared/src/logging/sanitize-input.ts) before storing diagnostic input; arbitrary logger metadata is not automatically safe. Current sanitization removes sensitive-name fields, masks email and bounds nested/string/total snapshots. It is not permission to log credentials or private source content.

HTTP request logging sanitizes tokenized paths and the GitHub callback query; generic error diagnostics must not reintroduce them through query/params. Body-debug logging is a separate path: [request-body-logger.ts](../../packages/web-backend/src/middleware/request-body-logger.ts) excludes auth, password/temporary-password and public-workflow inputs and truncates serialized bodies. It is not a universal deep-redaction filter. Review new sensitive endpoints against both paths. Private issuer/controller/broker routes have their own admission and logging placement; do not mount a global body logger ahead of them.

Sources: [logger.ts](../../packages/shared/src/logging/logger.ts), [request context](../../packages/shared/src/logging/context.ts), [HTTP boundary](../../packages/web-backend/src/middleware/error-middleware.ts), [MCP registration](../../packages/mcp-server/src/tools/register-tools.ts).

## Audit writes

[AuditAction](../../packages/shared/src/audit/actions.ts) owns action names; [AuditRepository](../../packages/shared/src/database/repositories/audit-repository.ts) owns rows/filtering. Use `logAuditEvent` with an HTTP request or `logAuditEventDirect` for service/MCP/background context, and await the write. HTTP attribution uses the client IP resolved through trusted proxies, GeoIP country, user-agent and service-derived source. This is stored personal data, not automatic IP anonymization.

Put business actions at the service boundary shared by all callers. Avoid duplicate route/service events: use the service's existing audit-suppression option only where the caller deliberately supplies the single authoritative event. Do not add a global audit disable switch. Preserve the domain's transaction boundary: approval and temporary-password recovery append audit with their state changes; extension settings mutate value and masked audit together, rolling back on insert failure. An ordinary later audit helper call does not retroactively make a preceding mutation atomic.

For retriable background events, use `logAuditEventDirectOnce` with the domain's durable dedupe key and repository `logOnce`. The unique non-null key collapses concurrent/restarted repeats; only a newly inserted row increments its associated metric. Never infer that every action is deduplicated, place async work inside a synchronous SQLite transaction, or claim a queued delivery guarantee. `computeChanges` prepares explicit changed fields; sensitive values must be replaced with safe markers such as `[encrypted]` before audit persistence.

Audit metadata should identify the action/outcome and safe resource identity, not credentials, raw command bodies, native input or full files. Workspace security/lifecycle audit records remain observations; original command/delivery/custody journals decide whether an effect ran. Execution failed-attempt records likewise do not prove genuine completion or authorize replay. See [execution](../reference/execution.md) and [workspaces](../reference/workspaces.md#recovery-and-collection).

## Metrics

[shared metrics](../../packages/shared/src/metrics/index.ts) owns the registry and existing business instrumentation. Express installs `metricsMiddleware()`; service composition starts `createMetricsServer(port, serviceName)` for internal `/metrics` and `/health`. Keep its listener internal to the deployment. Adding metrics does not justify exposing installation diagnostics publicly.

HTTP labels use the dispatched route template (`/api/workflows/:id`), never the raw path. Requests without a matched route share `<unmatched>`; mount paths must not contain dynamic identities. Execution-mutation attempts, materialize outcomes and cloud codespace metrics use their existing closed operation/outcome/reason/provider/action/code vocabularies. Those families do not gain user, resource or operation identities from request data.

Workflow instrumentation has an existing identity dimension: `moira_workflow_executions_total` labels by `status` and `workflow_id`, and `moira_workflow_step_duration_seconds` by `workflow_id` and `node_type`. The executor, graph engine and stop service actively supply that workflow ID. Their series therefore depend on the workflows observed; the closed-label guarantee above does not apply to every business metric. Preserve that current contract when interpreting dashboards or changing instrumentation. Do not add tokens, input text, arbitrary URLs, error messages or further identity dimensions as an incidental diagnostic change; use protected structured records for those investigations.

Distinguish starts, real completions, refusals, intentional stops and unresolved attempts. Increment at the actual domain commit/insert boundary; repeated receipt reads and audit dedupe hits must not count as new effects. Unavailable measurements remain unknown, not zero. Analytics' observed activity, registration, completion cohorts and time windows are separate contracts in [HTTP analytics](../reference/http-api.md#analytics).

## Browser and email diagnostics

The frontend [client logger](../../packages/web-frontend/src/services/client-logger.ts) forwards bounded client records through `/api/logs/client` and `/batch`; server-side validation/rate limits remain authoritative. Keep browser logs free of session/native-link secrets and scope stale errors to the request that produced them. Client URLs/stacks and audit metadata may contain personal information; assess retention and export access in the deployment rather than assuming anonymization.

Email failures preserve provider/error classification and masked recipient diagnostics. Test-provider logs can contain verification/reset URLs: access them only as test evidence, never public delivery proof. `real` capability reports configured delivery, not evidence that an individual message arrived. Read [email configuration](../operator/configuration.md#email-delivery) before diagnosing unavailable actions.

## Guest workspace daemon diagnostics

The detached service owns `~/.local/state/moira/workspace-service/daemon.log`, `.log.1` and `.log.2` in the guest, each bounded to 1 MiB. [daemon-diagnostics.mjs](../../packages/workspace-service/src/daemon-diagnostics.mjs) rotates synchronously and bounds oversized existing files on restart; stdout/stderr/Node warnings share that sink. It verifies inherited kernel lock/descriptor identity before opening private ordinary owned files; symlink/hard-link substitution or writer failure refuses service instead of using unbounded inherited output.

These are service diagnostics, not command stdout/stderr or custody journals. Retrieve process output through `codespace_terminal` (`output`) or:

```bash
moira-workspace output "$PROCESS_REF" --stream stdout
moira-workspace output "$PROCESS_REF" --stream stderr
```

Rotation must not delete original results, immutable comparison metadata, unresolved input/custody or active recovery membership. Terminal input cleanup has its own evidence and reader-settlement rules in [workspaces](../reference/workspaces.md#commands-files-and-publications).
