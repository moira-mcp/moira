/**
 * Compile-time guard: the web-frontend tsconfig uses `bundler` module
 * resolution, under which Better Auth and workflow-engine types resolve more
 * strictly than the backend's `Node16`. This type-only import forces `tsc` to
 * typecheck the full `@mcp-moira/shared` barrel against the frontend's resolver,
 * so the auth-config / validation typings stay importable from the frontend
 * without the sub-barrel sidestep.
 *
 * `import type` is erased by the bundler — no runtime code is emitted and the
 * module is unreachable from any webpack entry, so nothing from the barrel is
 * shipped to the client. The sole purpose is to keep the barrel typecheck-clean.
 */
import type * as Shared from "@mcp-moira/shared";

export type SharedBarrel = typeof Shared;
