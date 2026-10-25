# Documentation ownership

The [documentation entry](../README.md) routes readers by task. Contributor guides explain how to
change the project, references describe current contracts, operator guides describe installation
actions, and portable help teaches users and agents to use Moira. Keep each subject with one owner.

## Write current, useful instructions

State behavior verified against code, configuration or an assigned source of truth. Include the
commands, settings, paths, error handling and cross-references a reader needs to act. Define
project terms before using them. Use clear headings without section numbers and relative links
within the repository.

Preserve meaningful constraints when consolidating: authority, ownership, absent versus unknown
outcomes, recovery, intentional empty values and evidence limits are contracts, not incidental
verbosity. Link to canonical types, schemas and configuration rather than maintaining another
interface, route, environment-variable or tool inventory. An overview should direct a reader to
the detailed owner instead of copying its paragraphs.

Keep development history in Git and work in issue trackers. Do not commit plans, roadmaps,
backlogs, handoff diaries, execution identifiers, copied logs, review rounds or test totals as
project documentation. Before removing an unresolved record, establish its current applicability
and tracker owner. Public product tasks belong to the public tracker; private operations, policy
and custody remain private. Historical proposals are not automatically accepted requirements.
Keep required legal notices and attribution.

Temporary process evidence belongs in the project's locally ignored agent workspace, outside the
delivered documentation. Do not create a replacement tracked archive for removed plans.

## Portable runtime help sources

English semantic help lives under `packages/mcp-server/src/help/content/`; Russian counterparts
live under its `ru/` directory. Topic frontmatter owns runtime identity and descriptive metadata.
Localized MDX pages under `packages/docs/src/content/docs/` retain matching Starlight frontmatter
and import their semantic Markdown through `@mcp-moira/mcp-server/help-content/*`.

Keep runtime-visible text, examples and related links in the semantic source. Do not place Astro
imports or JSX in portable Markdown, or create another website copy. Presentation-only components
belong to the thin MDX wrapper. Keep authored headings in the semantic source; fragment-only
wrappers compose the imported Markdown heading metadata through the existing MDX processor.

Quick start and MCP clients compose `.before.md` and `.after.md` around the client setup insertion.
Client identities, native configurations, installation links and EN/RU setup, authentication and
verification text belong to `packages/shared/src/mcp-clients/`. Its pure presentation API serves
the dashboard, Starlight documentation and private landing; each keeps its own native controls.
The MCP help adapter renders that same presentation as Markdown. Keep official vendor links with
each client and check them before changing its instructions. Use this composition instead of
copying configuration output or client-specific prose into another guide or locale file.

Use `{MCP_URL}`, `{MOIRA_URL}`, `{STATIC_DOMAIN}` and supported `{{MCP_DEEPLINK:…}}` tokens for
configured addresses. Runtime and public consumers use the shared portable-token renderer. Use
locale-absolute website links (`/docs/…/` and `/ru/docs/…/`) where semantic sources target rendered
pages; filesystem-relative sibling links do not necessarily resolve at the rendered URL.

The MCP `help` tool discovers English semantic sources directly. It does not strip JSX or serve a
language parameter. Russian sources are the website translation; changes to user behavior must
remain semantically aligned in both languages.

## Default and effective instructions

The sole English file default is `config/prompts/systemPrompt.md`. English agent instructions
import it directly, and runtime help reads the same file independently of working directory after
its portable introduction. The Russian website imports
`packages/docs/src/content/docs/docs/SYSTEM-PROMPT-RU.md`; maintain that translation with the English
source.

Those references are not an installation's effective initialization instructions. The settings
service reads model → agent → default from the database, choosing the first non-null value and
preserving an intentional empty string. It does not fall back to the file reference. Startup file
reconciliation belongs to the [bundled catalog and prompt reference](../reference/bundled-catalog.md#prompt-files-and-database-settings).

## Typed tool facts

Tool names, schemas, examples and static description variants belong to the MCP server's existing
typed contract and its imported owners. Runtime discovery, tool help and the public reference
consume that projection. Do not copy it into a Markdown inventory or maintain another exporter.

```bash
node --import tsx scripts/export-mcp-context.ts
```

From the repository root this writes ignored `mcp-tools-context.json` in the current directory.
It contains the complete static projection and derived revision, including declared description
variants and native-file metadata. It is not a live OAuth/model session or effective database
prompt.

## Verify the reader experience

After behavior stabilizes, update all affected current-state owners and their navigation together.
For docs/help changes, use the native integration path:

```bash
npm run test:integration -- --file tests/integration/docs-tool-contract-rendering.test.ts
```

Read the complete rendered examples against their actual schemas and handlers. A valid JSON
document or successful build does not establish factual truth, authorization or successful
publication. Inspect real link destinations and fragments, not just the existence of a Markdown
file. Test both locales, split imported content and ordinary authored MDX when changing the
renderer.

For visible changes, use existing project browser facilities, capture the relevant states and
open the actual screenshots. Prefer state-based waits over sleeps or forced clicks. Capture one
current set; an HTML handoff, when required by the chosen workflow, reuses those same inspected
images. File existence does not prove appearance. State fixture and external-acceptance limits
explicitly; no fixed report filename or live-provider requirement follows merely from editing a
documentation file.
