# Web UI architecture

The React application in `packages/web-frontend/` presents workflows, runs and owned resources.
Use [UI patterns](ui-patterns.md) when adding controls or data regions. User procedures belong to
the portable [flow](../../packages/mcp-server/src/help/content/guides/flow-page.md),
[run](../../packages/mcp-server/src/help/content/guides/run-page.md) and
[overview](../../packages/mcp-server/src/help/content/guides/run-overview.md) guides; this page
describes the implementation boundaries a contributor must preserve.

## Routes

`src/routes/routeTable.ts` is the route inventory. `App.tsx` maps its stable IDs to lazy page
modules, applying the configured app base path. Standalone authentication/consent pages sit outside
the application layouts; main routes use `MainAppLayout`, administrator routes `AdminLayout`.
Main routes require sign-in. Administrator routes require the administrator role and any declared
deployment capability. Hiding a sidebar item is not backend authorization.

Every route declares a screen tour or an explicit exemption/deferred-coverage reason. Add the
route and its guide decision together; do not maintain another route list in documentation.
The ordinary header exposes its screen tour. Process pages retain their compact header and
diagram toolbar instead of replacing them with a generic page title.

Layout-level Suspense retains the sidebar, guide provider and outlet while route code loads.
Form, editor, Markdown-preview, history and diagram code use local boundaries so loading a panel
does not remove its draft or independent controls. `LazyAuthView` loads the actual auth form inside
`AuthLayout`; the global `AuthProvider` supplies error interception and the shared auth client.

Private holdings compose `ReadScopeBoundary`, `PrivateReadScopeBoundary` and route admission.
Uncertain session/capability authority hides and makes private content inert while retaining
same-owner drafts. Confirmed account/backend replacement resets private state. Public sign-in
operations remain outside that private ownership key so their own successful continuation can
finish. Auth/invite completion waits for the existing session-settlement mechanism, and automatic
cleanup revokes the originally observed session, not whichever account becomes current later.
See [authentication](../reference/authentication.md); do not add a second page-local session model.

## Data and mutation ownership

`services/api-client.ts` owns the browser's HTTP adapters and `services/product-fetch.ts` the
configured product request boundary. API DTOs remain local frontend representations. Authored
workflow types enter through the type-only `types/workflow-types.ts` facade over engine types;
loaded workflow identity is required there even where a draft authored graph can omit its ID.
Do not import a server package barrel into the browser to obtain a type.

The shared safe-read boundary combines the complete observed authority (account, accepted session
observation and capabilities), backend identity and normalized URL/query. Its owners are
[read-scope](../../packages/web-frontend/src/services/read-scope.ts),
[ConditionalReadStore](../../packages/web-frontend/src/services/conditional-read-store.ts) and
the [API client's read adapter](../../packages/web-frontend/src/services/api-client.ts).
Identical in-flight reads may share one request. Every independent read still checks the source
over HTTP; retained data's age is a memory bound, not a freshness TTL or permission to skip that
check. Only the adapter's explicit stable-list allowlist retains bounded successful response
wrappers with ETags. A 304 restores the wrapper only for its matching full key; it cannot borrow
another query's or authority's representation. Detail/context, secrets, session, admission and
volatile reads do not become retained stable representations.

Mutations retire the read generation before dispatch and again on settlement, including failed or
partial effects. Session/backend/capability changes also retire it, preventing an older flight from
publishing into the new generation. A retired read may re-enter for a fresh source check only when
its original complete identity is still current and it is the same original request. It must not
adopt replacement authority. This narrow retirement recovery is not automatic retry of ordinary
HTTP/network failures. Preserve the [HTTP conditional-read contract](../reference/http-api.md#conditional-lists)
when extending the adapter rather than adding a page-local cache or retry path.

Compose `useResource` and the existing request/owner guards. Accepted result data and its resource
key stay together; requested controls are not evidence that a response belongs to that request.
The [retained-result contract](ui-patterns.md#retained-results-and-drafts) also applies to settings,
detail panels and operational cards. Confirmed mutations supersede older reads. A delayed success,
failure or timer from a retired owner cannot replace data, clear pending state or redirect the
current operation.

Settings values preserve field presence: an intentional empty prompt or `false` override is not a
missing value, and clearing a scope is a distinct operation. Keep draft inputs separate from
accepted values. User Settings owns its task/subview hashes and retained hidden tabs;
administrator settings owns section query navigation through presentation-only `SettingsNav`.
Activate the owning view before following a section hash or guide target.

Development environments, GitHub connection and local-computer settings refresh independently.
Repository/controller targets and VM inventory also own separate loading, error, retained-result
and retry state, so an unresolved inventory does not remove the creation form or its draft.
Checking one card uses addressed observation rather than refreshing every VM. A collected effect
snapshot remains visible if that read fails, but requires a fresh observation before another
lifecycle action. Completed success without a projectable snapshot retains its original reference
and a separate confirmation message; it neither falls back to a full inventory nor enables repeat
creation. An existing card's old state is not presented as that effect's result. Authority refusal
remains a refused read, not a successful confirmation with an observation warning.
Neither a card refresh nor a historical receipt replaces the captured observation
in an open delete confirmation.
Show desired/pending and effective owner state separately. An unavailable or uncertain original
operation remains associated with that operation; refreshing discovery must not silently replay
creation, publication or another external effect. Their authority and recovery contracts live in
[workspaces](../reference/workspaces.md).

## Workflow editor

`pages/FlowPage.tsx` composes definition detail, revision-bound derived process, view selection and
the editor. A refreshed definition cannot be paired with an older process response: while the
matching projection is pending, derive it from the current definition through the engine's
browser-safe process entry. An unsaved draft is derived and validated as that draft. The flow map
is a run-less projection; it must not invent visit history, a cursor, execution facts or a task title.

The edit draft is an immutable operation log over the saved definition. Use the engine's
`authoring` operations and consequence previews rather than a second graph mutation model.
Structural edits, connection changes, renames and removals must preserve their actual dependent
fields. A connection gesture commits the final intended target, rather than an intermediate hover.
Save against the loaded revision; a conflict retains the draft and offers explicit reconciliation.
Validation and dry-run results belong to the exact current draft identity and cannot enable saving
a subsequently changed draft. The workflow transformer is an adapter to the canonical authored
types; retain valid authored fields and keep UI-only layout data separate.

The steps view reads authored execution order. Map and technical graph share diagram primitives,
but a workflow without authored progress still has its technical graph and node/registry panels.
Selected view, block and edit state belong to the page URL. Ordinary navigation preserves valid
choices; a change of workflow clears incompatible private results and edit state.

## Run presentation

`ExecutionInspector` serves user and administrator routes through injected reads and permissions.
Context editing and answering the waiting step are separate capabilities: the administrator view
can allow an answer while leaving context read-only. Keep guarded writes attached to the current
execution and metadata revisions, not a route-wide assumption of edit permission.

Run facts come from the engine progress projection: block statuses, passes, route visits, current
variables and waiting state. The whole-run projection drives navigation; a historical cursor
requests its own projection for the selected visit. Clearing a cursor retires its deferred read.
All detail, definition, progress, lock history and write continuations belong to a committed run
lifetime, including navigation A→B→A. A same-run title update preserves the loaded graph, DOM and
scroll. Task title, workflow name and arbitrary execution note remain distinct.

A stopped run retains its reason, recorded route and partial progress without a fake successful
frontier, active pulse or live wait. Shared stop controls own their revision/decision contract;
each page retains its own refresh owner. Conflict requires a current-state read and another owner
decision, and a lost reply is not permission to manufacture a different mutation.

Overview/live updates use the existing scoped stores and stream/poll fallback. Reconcile the
accepted filtered page; do not treat an event from another scope as a replacement page. Lifecycle
retirement removes stale subscriptions and prevents old responses from affecting the current view.
Keep backend ordering, cursor/reset and continuation semantics at
[execution](../reference/execution.md), rather than deriving alternate statuses in a component.

## Diagrams

The technical graph, process map, steps view, contents and detail panels compose
`components/diagram/`, `components/run/` and `components/workflow/`. Engine `process` and
`progress-visual` entries own process derivation, layout geometry and shared fact wording. The
browser renders that model; it does not create additional execution routes from display edges.

Acquire layout code through the shared `loadLayoutEngine` loader. Each layout owns its mutable
engine instance; warming a constructor performs no layout and a failed warmup must not poison
later acquisition. Keep the existing measured layout/settled boundary before fitting a camera or
capturing a diagram. Ordinary list/authentication pages do not need diagram code eagerly.

Shared focus, reveal and request primitives connect the views. A view switch must preserve the
meaningful selected block/node; a request to reveal inside a transformed canvas goes through its
viewport, not only `scrollIntoView`. The interaction vocabulary and accessible states are defined
once in [UI patterns](ui-patterns.md#process-diagrams).

## Guides

Guide declarations live beside their screens; `guides/registry.ts`, `topics.ts` and `types.ts` own
discovery, required topics and declaration shape. Use stable step IDs, literal `guideAnchor` names
and the shared locale keys. A changed control or explanation requires a deliberate step revision
decision; a documentation-only rewrite does not change guide progress.

The page supplies a memoized controller through `useGuidePage`: current view/role and operations
that reveal the requested panel, section, current block, playbook node or sidebar. The runner owns
preparation, bounded target settling, scrolling/camera reveal, focus return and announcements.
Optional declared absence and narrow-screen exclusions skip without a phantom card/history stop;
a missing required target remains explainable and can attach when late content arrives. Keep
cards reachable inside their modal's scope, with fixed navigation and scrollable long content.

The URL carries guide/step and full-tour continuation. User progress is merged through the shared
user-setting store against the latest server value, preserving unknown fields and concurrent
device changes. Changed-step tours record seen revisions without finishing a whole tour or
overwriting its resume point. The full tour uses the existing no-run fallback instead of selecting
an arbitrary other user's run.

The flow tutorial uses engine authoring lesson checks and the page's saved/draft surface. A lesson
is recorded only when its saved definition passes and no unsaved edits remain; a stale save is not
evidence. The optional run lesson needs an observed completed run of the reader's copy containing
the expected answer. The runner announces a passing result and exposes Next rather than silently
advancing.

When changing a guide, update both languages and run `npm run guides:snapshot` as required by the
project. The guide registry, coverage and locale suites check route coverage, anchors, topics,
view preparation and revision copy. Use the existing browser guide/tutorial cases for interaction;
do not replace them with a documentation heading inventory.

## Extension and verification

Follow [UI patterns](ui-patterns.md#adding-or-changing-a-surface). Put user instructions in the
existing paired portable topic and implementation constraints here only when they explain a
decision a contributor must make. Keep current DTO/schema/component details at their source,
not in another copied table.

Use the root npm test entrypoints and affected frontend suites; see
[the testing guide](../../tests/TESTING-GUIDE.md). Inspect actual browser interactions and both
language layouts for visible changes, including private holding, a failed local refresh, keyboard
use, narrow screens and reduced motion where affected. The existing webpack build owns public
configuration and deferred bundle boundaries; inspect its real emitted modules if a change risks
bringing server code into the browser.
