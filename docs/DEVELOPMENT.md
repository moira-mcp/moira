# Development Guide

## Setup

```bash
nvm use          # Reads repository .nvmrc and selects Node 24.20.0
npm install

# Local environment — copy the template, then set BETTER_AUTH_SECRET.
# .env.local drives docker:restart and the container-backed test suites.
cp .env.local.example .env.local

# Docker
npm run docker:restart    # Build → Start → Wait for ready (reads .env.local)
npm run docker:stop       # Stop container

# Tests
npm test                  # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests
npm run test:api          # API tests (Docker required)
npm run test:e2e          # E2E tests (Docker required)

# Code Quality
npm run fix               # ESLint + Prettier fix all files

```

The web application is developed through its Docker image. The Moira Local
companion is a separate host executable and must be built for its supported host.

### Moira Local companion

Run its commands from the repository root:

```bash
npm run local:build
npm run local -- --help
npm run typecheck:local
npm run workspace:verify:guest
```

`local:build` emits the CLI, independent guard, fixed runtime API, configuration bundle,
native ownership/credential helpers and verified workspace payload under `packages/local/dist`.
Do not copy a single JavaScript entry without its companion assets.
`workspace:verify:guest` packages the common Linux service and exercises actual installation,
startup acknowledgment, Unix health/CLI, binary files, repository ownership and shutdown in an
offline container. It is not proof of microVM isolation or physical SDK lifecycle.
Building mutable checkout assets does not replace a running host owner. `npm run local -- install`
stages the complete immutable closure, including its copied Node executable, under the selected
state's `service-releases/`. The macOS login registration starts the active release in a dedicated
security session; ordinary staging does not reload that registration or replace an active owner.
`npm run local -- run` starts or connects and returns. `service-status` reports the actual running
release and staged selection, readiness and failure independently of client lifetime.
Keep initialized companion state, SDK HOME/storage/profile, credentials,
grants and VM disks at their existing paths. Do not copy stale ignored worker outputs as release assets.
Host runtime validation requires the supported macOS SDK and locally approved
state. Linux VM execution fails closed before creation.

The common workspace service owns ordinary command/file/session execution in both providers.
The Local controller owns physical lifecycle/settings through private Unix HTTP and live routing;
The selected paired controller performs GitHub fixed trusted bootstrap and provider management;
cloud services do not run an SSH connector.
Neither is a command transport. Changes to lifecycle or guest behavior must preserve
durable replay receipts, independent kernel ownership and unknown-outcome fences;
an injected test runtime does not establish physical SDK isolation. Use root
Testfold scripts for focused tests in `tests/integration/local/` and device/provider
integration tests. Before database migration, integration global setup builds current
host programs with `build-local-programs.js`, native helpers with `build-local-native.js`
and controller owner programs with `build-workspace-service.js`. It does not download
guest archives or GitHub toolchains or package renderer dependencies. Complete payload
packaging and the packaged guest verifier remain separate checks; this prerequisite
does not run the SDK or validate a microVM.
Host `create OWNER/REPO --ref BRANCH`, `start SPACE_ID`, `stop SPACE_ID` and
`remove SPACE_ID --confirm` use the running owner controller. Raw `request` envelopes are
unsupported. Supply `--request-id ws1-<lowercase UUID>` to choose a lifecycle identity;
otherwise the CLI chooses one and prints it before observing the effect. After a lost reply,
run `collect REQUEST_ID` with that original identity instead of repeating the mutation.
Existing owner-admitted VMs and their `~/.local/bin/moira-workspace` CLI remain subject to
local grants and enabled permission while cloud transport is unavailable. Confirmed authority refusal
does not permit offline fallback. Fresh host create requires cloud route registration and
initial Git credential authority; a verified Git identity cache is restricted to existing
VMs. MCP requires a live authenticated owner and queues no offline lifecycle/settings work.
Current account/device/repository authority gates remote admission and routing. Controller
management retains its own local approval guards; existing offline work retains its finite
owner grants, while fresh creation requires cloud registration. Readiness is configuration
observation, not an administrative stop/control surface.
Use host `recover` for explicit local custody recovery. Active lifecycle/command/mutation IDs
use ws1; repository-admission UUIDs are a different domain.

The persistent service contains the daemon/controller, native guard and broker/tunnel. Client exit
and native observation release do not authorize physical stop; `released` is not `settled`.
Explicit physical-owner replacement uses `maintenance --confirm` only within an approved interruption.
Collect its printed original identity with `collect REQUEST_ID`; never manufacture a fresh update
after a lost reply. It preserves VM/disk identities and intended state, confirms exact old custody
settlement, selects the staged release, then reports per-VM restored/unavailable outcomes without
command replay. Unconfirmed settlement blocks replacement. Native setup/login/recovery can instead
use `maintenance --pause --confirm` and, after the original receipt is `paused`, resume using
`maintenance --resume --request-id ORIGINAL_REQUEST_ID --confirm`. Commands such as
`login --new-store` still require disabled work; a pause does not enable work.

Cold-owner startup observes surviving workers and recovers only verified known intended-running
VMs. Login startup after a host reboot requires the original storage and available SDK credentials;
it does not preserve guest boot identity or replay pre-reboot work. Runner markers and native receipts
include kernel boot identity, with exact profile checks and the physical gate retained. A retained
legacy owner/endpoint requires explicit backed-up initial cutover, never PID-only adoption or manual
lock removal. See [owner updates and recovery](CODESPACES.md#owner-web-control-and-bundle-updates).

The native machine-Keychain helper verifies the effective no-idle-timeout interval and sleep-lock
policy only for the owned SDK store, including an existing store after successful saved-password
unlock. Do not infer policy from the native `useLockInterval` boolean alone, change personal Keychain
selection, print passwords, or rotate an unreadable store automatically. Dedicated-session startup
does not replace a genuine vendor authentication requirement.

The Local build bundles the common fixed Git/typed PR primitive into the trusted host
broker. It uses private repository/action-scoped child credentials from the live issuer;
Git bytes go directly to GitHub, not through a cloud Git executor. Preserve the existing
Basic guest-to-host admission, repository/grant checks and network budget when changing
this adapter. There is no manual `git-token` setup or broad-token fallback. Old private
token bytes are not active authority and must not be erased during binding migration.

`moira-local status --json` lists token-free `credentialRequests`.
`moira-local collect ORIGINAL_SECURITY_REQUEST_ID` uses pure issuer collection, never
new issuance or Git/PR replay. Collection of a live stream is metadata-only; orphan
retirement requires the existing runner-lock and confirmed owner-absence proof.
Retain original identities across custody/outcome/disposal uncertainty and await actual
upstream closure before disposal. Local permission has no work deadline; the child's actual
provider and parent expiration still bound use. An unrelated settings revision preserves unchanged
credential authority; device/resource/grant revocation still retires affected children.
Do not assume that parent revocation automatically revokes a derived child.

### Common workspace payload

Materialize resolution in the workflow engine produces authorized path/content strings.
Keep Note/Playbook expansion and the final paused-node/context recheck in that text boundary.
The owner alone encodes those strings, writes the tar through its packaged `tar-stream`
runtime, stages and publishes the immutable result. Repeat archive requests collect the
original scope-bound receipt before resolving text; the context fallback remains owner-free
with its 256 KiB budget. Do not restore cloud Buffer files or archive quotas.

The owner release also carries `owner-renderer.mjs`, the binary extension handler host and process-group supervisor. Renderer dependencies are private packaged Sharp/libvips and font assets, independent of project `node_modules` and cloud authentication/database configuration. `renderOwnerProgress` sets its packaged font configuration before loading the rasterizer. Local host assets use the `owner-runtime` directory; the guest uses its installed `service` assets. Preserve the complete release and asset manifest rather than copying a JavaScript entry alone.

Binary-extension packaging uses the existing esbuild/registry path: installed handler code, canonical manifest and declared regular assets form one immutable artifact. The private owner installs only its checked digest and runs `binaryHandler` under the packaged supervisor. Native/platform or unresolved dynamic dependencies that cannot form the supported owner artifact are refused before delivery admission.

```bash
npm run workspace:build
npm run workspace:package -- --arch x64
npm run workspace:package -- --arch arm64
node scripts/prepare-workspace-feature.js
```

The payload contains owned Node.js 24.21.0 and ripgrep 15.2.0 for Linux glibc x64/arm64 and does not
use the project's Node executable or PATH. The public OCI image
`ghcr.io/moira-mcp/moira-workspace-service` and optional Dev Container Feature
`ghcr.io/moira-mcp/features/workspace-service` install identical payloads. Feature preparation
stages the complete Feature under ignored `agent_temp_files_local/workspace-feature/`; do not
publish the source-only Feature directory. A project can retain its own image/runtime and add
the Feature. Provider bootstrap also installs/upgrades an existing environment in place without
container recreation or VM-disk replacement. Root and nonroot guests require repository ownership
to equal the service UID. Confirmed startup checks the selected release and Unix service health.

Pinned build inputs use `scripts/acquire-pinned-archive.js`: native HTTPS streaming with verified
TLS and HTTPS-only redirects, an exclusive candidate and integrity verification before atomic cache
publication. Matching cached archives are verified before reuse; failed candidates are removed
without replacing an existing corrupt cache. Node/ripgrep SHA-256 pins and private owner dependency
integrity values remain authoritative.

The same package contains the GitHub trusted broker and typed PR client. Ordinary
workspace `git fetch`/`git push` use its managed fixed origin; the broker verifies both
canonical and effective fetch/push destinations before binding. Original OAuth/refresh
credentials remain cloud-private; repository/action-scoped children remain broker memory
and are excluded from project files, command arguments, environment and logs. The guest
uses the existing same-UID trust boundary, not a sandbox against authorized commands.

The installed `moira-workspace` CLI supports:

```bash
moira-workspace pull-request-create --request-id ws1-00000000-0000-4000-8000-000000000001 pr-input.json
# Collect the original result without resubmitting the create input:
moira-workspace pull-request-create --request-id ws1-00000000-0000-4000-8000-000000000001
moira-workspace pull-request-get 1
moira-workspace pull-request-find feature/example main
```

Choose a fresh original ID for each authorized create. `pr-input.json` contains
`head`, `base`, `title`, optional `body` and `draft`; it contains no token, repository
override or provider URL. An uncertain creation requires original receipt collection
and exact head/base inspection, not automatic recreation. Security acquisition has its
own original request identity; its uncertainty before vendor dispatch is not a PR
mutation result. Direct CLI calls and MCP use the same owner operations and receipts.

See [System architecture](SYSTEM.md#local-codespace-composition-and-ownership),
[API contracts](API.md#local-device-enrollment-and-controller-api) and
[Codespaces](CODESPACES.md) for runtime setup and recovery.

### Code Quality

**Linting and Formatting:**

- ESLint 9 flat config (`eslint.config.js`)
- Prettier with astro plugin (`.prettierrc`, `.prettierignore`)
- Pre-commit hook runs lint-staged (ESLint + Prettier)

**ESLint Rules:**

- Production: `@typescript-eslint/no-explicit-any: error`, `no-console: error`
- Tests/scripts: `any` allowed, console allowed
- `no-restricted-syntax`: blocks direct `process.env` access (use config module)
- E2E tests: `no-restricted-imports` enforces `./fixtures.js` over `@playwright/test`

**CI Checks (GitHub Actions):**

```bash
npx eslint .          # ESLint
npx prettier --check . # Prettier
```

**Configuration files:**

- `eslint.config.js` - ESLint 9 flat config (unified for all packages)
- `.prettierrc` - Prettier settings
- `.prettierignore` - Excluded from Prettier
- `.husky/pre-commit` - Git hook running lint-staged

### Dependency compatibility boundaries

`npm outdated` must have no available update inside the declared ranges before a
dependency-refresh pull request is complete. Dependabot groups minor and patch
version updates; scheduled major version updates are excluded and must be initiated
by a maintainer because they can change product or tooling contracts. Security
updates remain independent of that version-update allowlist. The following intentional boundaries explain every current
direct major hold and state when it can be removed:

| Boundary                                                                                                                                      | Current reason                                                                                                                                                                             | Removal trigger                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-auth@1.6.22`, `@daveyplate/better-auth-ui@3.2.8`, and `@hookform/resolvers@5.2.2`                                                     | Better Auth 1.7 removes the `mcp` plugin export used by Moira; Auth UI 3.4 resolves incompatible `better-call` peers; Resolvers 5.9 requires optional `ajv-formats@2` while Moira uses v3. | Replace the removed MCP plugin API and upgrade together only after a clean install has no peer override and auth UI/API/E2E/MCP tests pass.                                |
| React 18, its type packages, `@xyflow/react@12.11.3`, TanStack Table 8, Smart Edge 4, Motion 12, i18next 25/react-i18next 16, and Lucide 0.x  | The current UI is React 18; Tremor declares React 18 support. Xyflow 12.11.4 imports a symbol absent from its exact system package. The other listed majors are UI migrations.             | Use a release after 12.11.4 whose React/system exports agree; migrate the remaining UI stack with a clean peer graph, build, component tests, and desktop/mobile E2E.      |
| ESLint 9, Astro ESLint parser/plugin 1.x, React Hooks plugin 5, Globals 16, TypeScript 5, Vite 7, webpack-cli 5, and current loader majors    | ESLint 10 is outside `eslint-plugin-import`'s peer range; TypeScript 7 is outside the current ts-jest and typescript-eslint ranges; the other majors change the same build/lint surface.   | Upgrade only when every plugin advertises the target peer range and lint, typecheck, docs, frontend, and Docker builds pass without compatibility flags.                   |
| Brevo 3, Better SQLite 12, Helmet 7, Diff 8, Winston Daily Rotate File 4, Zod 3, Concurrently 8, Open 10, and current CSS/style loader majors | Their latest releases are breaking API or runtime majors and are not required by an open security advisory.                                                                                | Give each owning runtime/build boundary a focused migration with compile/runtime tests; security updates may cross the boundary immediately when the advisory requires it. |
| `@types/node@24`                                                                                                                              | The shipped and CI runtime is Node 24; newer type majors describe APIs unavailable in that runtime.                                                                                        | Move with the corresponding Node runtime upgrade and full CI/Docker verification.                                                                                          |

Pinned `allowScripts` entries in the root manifest are a supply-chain allowlist for
the exact installed versions of native/tooling packages. A version change must add
the new exact entry only after reviewing the package script; stale entries are
removed in the same dependency refresh.

Dependabot ignores scheduled minor version updates for the currently incompatible
Better Auth/Auth UI/Resolvers stack and only the exact broken Xyflow 12.11.4
release. Patch updates outside those exclusions remain eligible. Dependabot's
`update-types` restrictions apply to version updates, not security updates. Remove
an ignore entry in the same change that proves its replacement passes the
corresponding removal trigger above.

### Docker Build Configuration

**Build IDs for cache isolation:**

The local build uses a `local` BUILD_ID for BuildKit cache isolation
(`docker compose up -d --build`).

**BUILD_INFO file:**

Every Docker image contains `/app/BUILD_INFO` with build metadata:

```
commit: <source commit or commit-dirty-content-hash>
build_time: <ISO-8601 UTC build time>
build_id: local
app_base_path: /
configuration: runtime-env
```

Public release builds pass the checked-out commit and current build time. A
dirty development build must use a dirty content identity rather than labeling
changed bytes as the clean commit.

Check the running version:

```bash
docker compose exec moira cat /app/BUILD_INFO
```

## Workflow Files

### Folder Structure

```
workflows/
├── production/
│   └── flows/            # Public catalog; UUID-named workflow JSON files
└── README.md
```

### Catalog Structure

- `workflows/production/flows/<uuid>.json` → one file per flow, named by its UUID. Each file carries
  catalog metadata `owner` (owning user id) and `visibility` (`public` | `private`). Identity is
  `(owner, slug)` — a slug is unique only per owner. The bundled folder ships the **public** catalog;
  private flows are supplied as an additional catalog directory merged via `WORKFLOWS_DIRS` (below).
- Personal exports and local backups stay outside Git. They are not catalog sources or public
  examples and must not be placed below `workflows/`.

**Multiple catalog directories.** The catalog can be loaded from more than one base directory.
`WORKFLOWS_DIRS` (colon-separated, PATH-style) lists the directories to merge; it falls back to the
single `WORKFLOWS_DIR`, then to the bundled default `./workflows/production`. Directories are merged
by `readWorkflowCatalogs()` and de-duplicated by `(owner, slug)` — a **later** directory overrides an
earlier one on a collision, so a directory listed last can extend or shadow earlier ones. Unset →
single bundled directory (default).

### Migration Process

At Docker container startup, `scripts/migrate-workflows-in-docker.ts` runs:

1. Enumerates and validates the complete merged catalog via
   `readWorkflowCatalogs(getWorkflowsDirs())`.
2. Compares each incoming entry with the persistent previous bundled baseline and the current
   database state, including removals, lifecycle state, graph, visibility, and declared previous
   slugs.
3. Plans every identity before writing. Upstream-only changes advance the managed workflow; user-only
   changes are preserved; two-sided self-host changes retain previous/current/incoming candidates in
   a local recovery bundle and fail initialization.
4. Reports every paused run the update would leave unable to continue, naming its workflow,
   execution and paused node, while the stored definitions are still the old ones. Advisory: it never
   fails a deploy. A run invalidated by a replacement is repairable afterwards through
   `session diagnose` and `session recover`; a run whose workflow is being removed is not, because no
   definition remains to resume against, and the report says which it is.
5. Applies a conflict-free plan and all baseline changes in one SQLite transaction after verifying
   that the captured workflow and baseline inputs are still current.
6. Exits non-zero on unresolved conflicts. The self-host startup guard restores the coherent
   database and prompt manifest while retaining the local bundle, then stops the container without
   an automatic restart loop; SaaS deployment preflight stops before production swap.

See `docs/WORKFLOWS.md` for candidate resolution, stale-evidence checks, removal/tombstone behavior,
and the destructive `--force` escape hatch.

### Prompt Migration

At startup, `scripts/prompt-migration.ts` syncs the runtime-configurable prompt, reminder, error,
and validation files from `config/prompts/` into the `globalSetting` table:

- **Fresh key:** Inserts the file value when the DB key does not exist. If a DB value predates the manifest, records its hash as the baseline without overwriting it.
- **Subsequent deploys:** Compares the DB value with the last deployed manifest hash. An unchanged DB value is updated from the file; a manually edited DB value is preserved and reported as a conflict.
- **Removed agent/model override:** Deletes its DB row only when the value still matches the last deployed hash. A manually edited override remains in the DB and is reported as a conflict.
- **Static tool descriptions:** Typed default and agent/model variants live in
  `packages/mcp-server/src/tools/tool-descriptions.ts` and are outside prompt migration. Legacy
  description rows and their manifest entries are removed from the database.
- **Null safety:** Treats a null `globalSetting.value` as an empty string for hashing.
- **Atomicity:** All DB writes wrapped in `db.transaction()`.

Manifest stored beside the SQLite database as `data/prompt-manifest.json` in the default layout.

### Adding New Workflows

```bash
# Add a public flow to the OSS catalog (file name = UUID). Set `owner` and `visibility` in the JSON:
#   "owner": "system-moira", "visibility": "public"
WORKFLOW_UUID=00000000-0000-4000-8000-000000000000
cp my-workflow.json "workflows/production/flows/${WORKFLOW_UUID}.json"

# Rebuild Docker to apply
npm run docker:restart
```

Private deployment workflows belong in the private repository's additional catalog, not in the OSS
tree. Configure additional catalog roots through `WORKFLOWS_DIRS`.

### Workflow CLI

```bash
WORKFLOW_UUID=00000000-0000-4000-8000-000000000000

# View structure
moira-workflow "workflows/production/flows/${WORKFLOW_UUID}.json" structure --graph

# Search nodes
moira-workflow "workflows/production/flows/${WORKFLOW_UUID}.json" search "pattern"

# Edit node
moira-workflow "workflows/production/flows/${WORKFLOW_UUID}.json" update node-id --directive "new text"
```

## Project Structure

```
src/graph/core/     # UniversalGraphExecutor, ContextManager, EdgeResolver
src/graph/handlers/ # StartHandler, AgentDirectiveHandler, ConditionHandler, EndHandler, TelegramHandler
src/graph/storage/  # DatabaseRepository, InMemoryRepository (IDataRepository implementations)
src/graph/types/    # TypeScript definitions
packages/mcp-server/src/tools/     # MCP tool implementations
packages/mcp-server/src/tools/tool-schemas.ts      # Canonical side-effect-free input schemas
packages/mcp-server/src/tools/tool-descriptions.ts # Typed static description data and variants
packages/mcp-server/src/tools/tool-definitions.ts  # Pure MCP contract, reference model, and revision
packages/mcp-server/src/tools/tool-bindings.ts     # Exhaustive lazy executable bindings and adapters
packages/mcp-server/src/help/      # Portable EN/RU help sources and client presentation contract
packages/mcp-server/src/messages/  # Centralized English messages (i18n ready)
src/server.ts       # StreamableHTTPServerTransport (stateless mode)
packages/web-backend/           # Express API server (internal port 4201)
packages/web-frontend/src/      # React UI components (static build served by nginx)
config/             # Docker deployment configuration
├── traefik-self-host.yml  # Workspace Upgrade route → backend; other traffic → nginx
├── Dockerfile          # Multi-stage build: deps → frontend/docs/backend builds → runtime-deps (prod only) → runtime
├── supervisord.conf    # Process manager (init-database → services)
├── nginx.conf          # Reverse proxy configuration
├── environment.env     # Environment variables template
├── docker-deploy.sh    # Deployment automation script
└── prompts/            # Runtime-configurable prompts and messages
    ├── systemPrompt.md
    ├── systemReminder.md
    ├── errorMessages.json
    ├── validationHelp.json
    └── agents/           # Agent-specific prompt overrides
        └── {agent}/      # e.g., chatgpt/, cursor/
            ├── systemPrompt.md
            ├── systemReminder.md
            └── models/{model}/  # Model-level overrides
                └── *.md
tests/unit/         # Component tests
tests/integration/  # Workflow execution tests
scripts/
├── run-migrations.ts         # Drizzle ORM migrations
├── migrate-workflows-in-docker.ts  # Workflow JSON → DB migration
├── self-host-startup-guard.sh # Automatic self-host DB/manifest backup and failure restore
├── init-database.sh          # Migration wrapper with sentinel files
└── wait-for-init.sh          # Service startup gate (polls for sentinel)
```

## MCP HTTP Transport Architecture

### Streamable HTTP Transport (2025-03-26)

- **State-of-the-art**: Latest MCP specification transport
- **Stateless Mode**: Each request creates new transport (serverless compatible)
- **Single Endpoint**: POST `/mcp` for all JSON-RPC communication
- **Direct Tools**: MCP tools integrated in single process
- **Environment Variables**: Configured via process.env

### Transport Configuration

```typescript
// Stateless mode (no session management)
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless for scalability
});
```

### Tool Execution Flow

```
HTTP POST /mcp → JSON-RPC → Pure Tool Contract → Executable Binding → Direct Tool Logic → JSON Response
```

### Environment Variables Pattern

```bash
# Set on HTTP server process
TELEGRAM_BOT_TOKEN=token
TELEGRAM_DEFAULT_CHAT_ID=chat_id

# Used by MCP server and tools via process.env
```

### Best Practices (2025)

- **Stateless Design**: No in-memory session storage for horizontal scaling
- **Service Integration**: Tools integrated in main process
- **Explicit Consent**: Tool descriptions treated as untrusted content
- **JSON-RPC 2.0**: Proper error handling with structured responses

## Node Handler Development

### Interface

```typescript
interface INodeHandler {
  getNodeType(): string;
  execute(
    node: GraphNode,
    context: ExecutionContext,
    input?: unknown,
  ): Promise<NodeExecutionResult>;
}
```

### Implementation Pattern

```typescript
export class MyNodeHandler implements INodeHandler {
  getNodeType(): string {
    return "my-node-type";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    // Validation
    if (!isMyNode(node)) {
      throw new Error("Invalid node type");
    }

    // Processing logic

    // Return result
    return NodeResultBuilder.continue(node.id, "success", outputData);
  }
}
```

### Result Types

```typescript
NodeResultBuilder.pause(nodeId); // Pause for user input
NodeResultBuilder.continue(nodeId, outputPath, data); // Continue to next node
NodeResultBuilder.complete(nodeId, finalData); // End workflow
NodeResultBuilder.error(nodeId, errorMessage); // Fail execution
```

## Handler Behavior (Code Facts)

### StartNodeHandler

- **Auto-execution** - immediately continues
- **Data merge** - combines initialData + input → context
- **Output path** - always 'default'

### AgentDirectiveHandler

- **Pause behavior** - pauses for user input when no input provided
- **Template processing** - processes templates in directive/completionCondition
- **Validation** - validates input against inputSchema; a rejected submission is logged and pauses
  again at the same node with sanitized feedback that does not echo the rejected payload
- **Routing** - after validation, the node's `expressions` run and its `cases` are evaluated
  against the context with the answer merged; the first holding case selects its output, otherwise
  `success`

### ConditionHandler

- **Auto-execution** - immediately routes and continues
- **Operators** - eq, neq, gt, gte, lt, lte, contains, exists, and, or, not
- **Output paths** - `expressions` first, then `cases` in authored order; the first case whose
  condition holds selects its output, otherwise `default`
- **Context access** - resolves {{contextPath}} references

### TelegramNotificationHandler

- **Auto-execution** - sends message and continues
- **Template processing** - processes templates in message
- **Rate limiting** - built-in Telegram API compliance
- **Error handling** - graceful degradation on failures with actionable error messages via messageQueue
- **Error classification** - `classifyTelegramError()` and `getActionableTelegramErrorMessage()` provide structured error types and user-friendly messages

### UserNotificationHandler

- **Auto-execution** - delegates ordinary text to `UserCommunicationService` and binary sources to the selected communication owner
- **Channel selection** - the service selects enabled configured adapters for the execution user
- **Aggregate result** - stores sanitized delivery, partial, no-channel, or total-failure state under the node ID
- **Routing** - total attempted failure follows `connections.error` when authored; other outcomes use `default`
- **Recovery** - invocation/visit-bound original delivery IDs retain owner channel stages without resending after uncertainty
- **Attachments** - the owner decodes inline bytes and renders progress; optional progress failure preserves text delivery, while explicit attachment failure cannot claim file delivery
- **Frame** - current execution revision and task identity are revalidated before vendor dispatch
- **Authority boundary** - generic nodes cannot choose a provider, recipient, destination, or credential

### EndNodeHandler

- **Auto-execution** - collects data and completes
- **Data collection** - finalOutput array or all variables
- **Completion signal** - returns 'complete' action

### ExpressionNodeHandler

- **Auto-execution** - evaluates expressions and continues
- **Sandboxed parser** - custom arithmetic parser, NOT JavaScript eval
- **Operations** - `+`, `-`, `*`, `/`, parentheses, string/boolean literals
- **Assignment** - safe bare targets such as `result = a + b`
- **Member reads** - own-property paths and bounded fixed or variable array indexes such as `tasks[current_index].action`
- **Registry validation** - assignments must name declared globals and satisfy their JSON Schemas before publication
- **Error handling** - invalid arithmetic, paths, indexes, targets, or values route to `error` without partial writes

### LockHandler

- **Trusted delivery prerequisite** - loads the current user's Telegram bot token and chat ID and validates client construction before generating an agent-path PIN
- **Two-phase activation** - generates a 6-digit PIN with `crypto.randomInt`, stores only its scrypt hash (`scrypt$<saltHex>$<hashHex>`) as pending, sends the plaintext PIN to the configured chat with an inline approve button, and activates the exact lock only after delivery succeeds
- **Failure behavior** - missing or malformed settings fail before PIN generation; send or activation failure leaves the exact attempt pending or `delivery_failed`, neither of which is visible as an active/public lock or published as `_lockId`
- **Agent projection** - the workflow handler and MCP lock action receive only `lockId`; no agent-facing result, error, or log contains the generated PIN
- **Human compatibility** - the authenticated Web creation route uses the separate human operation that returns its one-time PIN to the execution owner while persisting only the hash
- **Unlock sources** - workflow step input with a user-supplied PIN, MCP lock action, Web owner/admin action, or Telegram callback
- **Single connection** - only "unlocked" path (no rejection or expiration)

## Testing

### Test Structure

```typescript
describe("Feature", () => {
  let executor: UniversalGraphExecutor;
  let repository: InMemoryRepository;

  beforeEach(async () => {
    // Global helper - no imports needed
    const setup = await createTestExecutor();
    repository = setup.repository;
    executor = setup.executor;
  });

  test("should execute workflow", async () => {
    const workflow = await repository.getWorkflowGraph("test-workflow", TEST_USER_ID);
    const processId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    const result = await executor.executeStep(processId, input);
    expect(result).toContain("expected");
  });
});
```

### Test Commands

```bash
npm test                          # All tests

# By category
npm run test:unit                 # Unit tests (in-memory)
npm run test:workflow             # Workflow scenarios (test-integration.db)
npm run test:integration          # Integration (test-integration.db)
npm run test:api                  # API (Docker required)
npm run test:mcp-tools            # MCP tools (Docker required)
npm run test:e2e                  # E2E browser (Docker required)

# One file (run Testfold with the repository's Node 24 runtime)
npm run test:e2e -- --file tests/e2e/admin-panel.spec.ts
```

Full documentation: `tests/TESTING-GUIDE.md`

## Web UI Development Process

### Startup Sequence

```bash
npm install            # Install dependencies first
npm run docker:restart # Build and start Docker container
```

**Result:** All services available at `http://localhost:${DOCKER_PORT}` (from `.env.local`).

### Verification Steps

1. Check health: `curl http://localhost:${DOCKER_PORT}/startup-ready`
2. Open UI: `http://localhost:${DOCKER_PORT}/`
3. **MANDATORY**: Run E2E tests after ANY changes: `npm run test:e2e`

## Web UI Testing Protocol

### After ANY Web UI Changes

```bash
# 1. Rebuild Docker
npm run docker:restart

# 2. MANDATORY: E2E tests
npm run test:e2e
```

**Testing checklist:**

- [ ] Workflow list loads
- [ ] Workflow visualization displays
- [ ] Node details work on click
- [ ] Backend API responds correctly

## Frontend-Backend Architecture

### Docker Container

The app's frontend, backend and MCP processes run inside its Docker container managed by
supervisord. Supported public Compose additionally runs static Traefik ingress on the same host port:

- **Port**: DOCKER_PORT from .env.local
- **Frontend**: `/app/*` → static files (nginx)
- **Backend API**: `/api/*` → Express server
- **MCP Server**: `/mcp/*` → MCP HTTP server

**Service Startup Order:**

```
container-entrypoint → Supervisor → self-host-startup-guard → init-database → sentinel → services
```

`scripts/container-entrypoint.sh` clears stale terminal sentinels before Supervisor exists, so a
same-container restart cannot admit a waiter from the previous run. Supervisor then invokes
`scripts/self-host-startup-guard.sh` before `scripts/init-database.sh`. In
self-host mode, an existing SQLite database and its prompt manifest are copied coherently into three
rotating slots under `data/.moira-startup-backups/`; a failed initialization restores that state, and
a persistent pending marker recovers an interrupted initialization before the next backup. First start
uses a marker without a fake DB backup so failure or interruption removes its incomplete state. SaaS
bypasses this guard because its copied-DB preflight
and swap are owned by deployment infrastructure. In self-host mode the outer guard exclusively owns
both terminal sentinels: it clears stale values before backup, suppresses child publication, commits
`/tmp/init-success` only after the recovery marker transitions to committed, and publishes
`/tmp/init-failed` only after restore. All services (`mcp-server`,
`backend-api`, `nginx`) wait through `scripts/wait-for-init.sh`; `/tmp/init-failed` keeps them stopped.

### Request Flow

```
Browser → Traefik → nginx:80 → ordinary internal services
Workspace HTTP/1.1 Upgrade → Traefik → backend:3001
```

`config/traefik-self-host.yml` supplies the separate workspace route without an established-stream
idle/transfer deadline or Docker socket. The application has no separately published port in
this Compose topology. Compose defaults `TRUST_PROXY` to 2; preserve an explicit operator override
for another proxy topology. The global app default remains loopback. Guest agents connect outbound;
direct guest CLI calls use the private Unix socket and do not require the cloud to be online.

## Debugging

### Storage Inspection

```bash
ls -la .graph-storage/executions/              # Active processes
cat .graph-storage/executions/<uuid>.json      # Process state
jq '.globalContext.variables' <uuid>.json      # Context variables
```

### Execution Tracing

```bash
# Check Docker logs for debugging
docker logs ${DOCKER_CONTAINER_NAME}
```

### Common Issues

**Template Variables Null**

- Cause: Variable not in context when template processed
- Fix: Check variable availability timing

**Validation Failures**

- Cause: Input doesn't match inputSchema
- Fix: Review schema requirements vs actual input

**Connection Errors**

- Cause: Invalid node ID in connections
- Fix: Verify all connection targets exist

**Condition Failures**

- Cause: Type mismatch in operands
- Fix: Ensure consistent types (string vs number)

## Code Standards

### TypeScript

- Strict mode enabled
- No `any` types
- Proper interface implementation
- Type guards for node types
- Exhaustive switch/if-else checks using `never` type for all dispatch patterns (e.g., node type handlers). Every switch/map must have a default branch with `const _exhaustive: never = value` to catch unhandled cases at compile time.

### Error Handling

**Unified Error Hierarchy** (`@mcp-moira/shared`):

```typescript
import {
  ValidationError, // 400 - invalid input
  NotFoundError, // 404 - resource not found
  AuthenticationError, // 401 - invalid credentials
  AuthorizationError, // 403 - insufficient permissions
  ConflictError, // 409 - resource conflict
  RateLimitError, // 429 - rate limit exceeded
  DatabaseError, // 500 - DB failures
  ConfigurationError, // 500 - missing config
  ExternalServiceError, // 502 - external API failures
  InternalError, // 500 - unexpected errors
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";

// Throw typed errors (execution layer)
throw new ValidationError("Invalid workflow ID", { workflowId });
throw new NotFoundError("Workflow not found", { workflowId });

// Normalize unknown errors (boundary layer)
const appError = normalizeError(unknownError);

// Check error type for logging level
const level = isOperationalError(error) ? "warn" : "error";
```

**Error Types**:

- `isOperational=true` (WARN): Expected errors - validation, not found, auth
- `isOperational=false` (ERROR): Programmer errors - DB, config, internal

**For node handlers** (workflow-engine):

```typescript
// Return structured errors, don't throw
return NodeResultBuilder.error(nodeId, "Specific error message");

// Log errors properly
this.logger.error("Operation failed", error, { context });
```

### Context Management

```typescript
// Safe context updates
context.variables.newField = value;
context.nodeStates[nodeId] = nodeData;

// Avoid full replacement
// context.variables = {}; // WRONG - loses data
```

## Rebuild and Restart

The contributor container runs a baked image. Backend, frontend, engine, prompt,
documentation, and bundled workflow changes require rebuilding the image. Test
files run on the host and do not require a container rebuild unless the application
code or fixture state they exercise changed.

The local helper bind-mounts `workflows/` for catalog development, but startup
migrations load bundled definitions into SQLite. Rebuild and recreate the container
before container-backed verification so the image, database, and catalog agree.

```bash
npm run docker:stop     # Stop container
npm run docker:restart  # Rebuild and restart
```

## Testing Strategy

### Development Testing

```bash
npm run docker:restart  # Rebuild Docker
npm run test:e2e        # Run E2E tests
# Access: http://localhost:${DOCKER_PORT}/app
```

### MCP Servers

| Server        | URL                                   | Purpose                  |
| ------------- | ------------------------------------- | ------------------------ |
| `moira-local` | `http://localhost:${DOCKER_PORT}/mcp` | Local Docker development |

### Test Execution

```bash
npm test                  # All tests
npm run test:api          # API tests
npm run test:mcp-tools    # MCP tests
npm run test:e2e          # E2E browser tests
```

Docker commands route through configured context: `tests/utils/docker-command.ts`.

### MCP Version Check

Server validates the computed MCP tool-contract revision after authentication and account admission
for both OAuth access tokens and persistent API tokens. New authorization and API-token issuance
leave `toolsVersion` null; successful MCP initialization records acceptance. OAuth refresh creates
a successor access-token row with the predecessor's exact revision.

**Behavior:**

- Token revision matches `MCP_TOOLS_REVISION` → request proceeds
- Token revision differs or is null and the request is ordinary → HTTP 426 Upgrade Required
- Token revision differs or is null and the request is an SDK-valid singleton `initialize` → the
  exact credential is stamped before the successful result is emitted
- Invalid, revoked, expired, blocked, pending, or applicable unverified credentials fail before the
  revision gate

**After the contract revision changes:**

```bash
# Client receives HTTP 426 with upgrade_required and reconnect/reinitialize guidance.

# In Claude Code:
/mcp reconnect moira-local  # Local Docker
```

Reconnect or reinitialize with the currently valid OAuth or persistent credential. Reconnecting
does not itself rotate a token. Automatic OAuth refresh may rotate access tokens independently; the
successor inherits the predecessor's exact current, stale, or null revision. Notifications,
malformed requests, batches, and initialize errors do not stamp a credential.

**Revision source:** the deterministic pure contract in `tool-definitions.ts`, including every
static default and agent/model description variant. `MCP_TOOLS_REVISION` is computed once when the
MCP contract loads; `shared` persists only the revision accepted by each credential. Tool
descriptions are not database settings. The root package version remains the server release
identity.

SQLite migration `0021_static_tool_descriptions` removes retired database-backed description rows
and adds nullable `apiToken.toolsVersion`. Existing persistent-token IDs, hashes, ownership,
revocation, and expiry remain unchanged; their null revision requires the next successful MCP
initialize before ordinary requests proceed.

## Validation Rules (Code Facts)

### Graph Validation

- **Required nodes** - At least one start and one end node
- **Unique IDs** - All node IDs must be unique
- **Connection targets** - All connection references must exist
- **Node types** - Only supported types allowed

### Performance Warnings

- **20+ agent-directive nodes** - Warning in validator (not limit)

### Agent Input Rejection

- Invalid agent input never advances the graph.
- The engine returns the same node with schema-derived corrective feedback and no rejected-payload
  echo.
- A workflow that needs a bounded business retry policy must model it explicitly with ordinary
  expression, condition, and decision nodes after valid submissions.
