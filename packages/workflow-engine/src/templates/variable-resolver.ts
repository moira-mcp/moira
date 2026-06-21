/**
 * VariableResolver — single source of variable resolution for templates and conditions.
 *
 * Resolution model:
 *  - Bare name `foo`        → workflow-global value. Globals are seeded into
 *                             `context.variables` at workflow start from the registry
 *                             defaults (and from any runtime updates), so a global is
 *                             read directly from the top level of `context.variables`.
 *                             A bare name that is not a declared global resolves to undefined.
 *  - Dotted `node-id.name`  → node-local value, read from `context.variables[nodeId]`
 *                             (the per-node scope the engine writes results into).
 *
 * The resolver supports the same path syntax as the template engine: dotted segments,
 * numeric `[0]` indexes, and dynamic `[var]` indexes resolved against the globals.
 */
export interface VariableResolverContext {
  /** The execution context variables map (globals at top level, node scopes under node ids). */
  variables: Record<string, unknown>;
  /** Declared global variable names (registry keys). Empty set during early transition. */
  globalNames: Set<string>;
  /** Known node ids in the workflow (used to recognize `node-id.name` references). */
  nodeIds: Set<string>;
}

export class VariableResolver {
  /**
   * Resolve a reference path to its value.
   * @param path  e.g. "feature_name", "review.blocking", "items[0].value"
   * @param ctx   resolver context (variables + declared names + node ids)
   * @returns the resolved value, or undefined if not found
   */
  resolve(path: string, ctx: VariableResolverContext): unknown {
    if (!path) return undefined;

    const segments = this.parsePath(path, ctx.variables);
    if (segments.length === 0) return undefined;

    const head = segments[0];

    // Node-local reference: `node-id.name...` — only when the head matches a known node id
    // AND there is at least one further segment (a bare node-id alone is not a value ref).
    if (typeof head === "string" && segments.length > 1 && ctx.nodeIds.has(head)) {
      const nodeScope = ctx.variables[head];
      return this.walk(nodeScope, segments.slice(1));
    }

    // Bare global (declared in the registry): read from the flat top level.
    if (typeof head === "string" && ctx.globalNames.has(head)) {
      return this.walk(ctx.variables[head], segments.slice(1));
    }

    // Not a declared global and not a node-local reference → unresolved.
    return undefined;
  }

  /** Walk remaining segments from a starting value. */
  private walk(start: unknown, rest: (string | number)[]): unknown {
    let current: unknown = start;
    for (const segment of rest) {
      if (current === null || current === undefined) return undefined;
      if (typeof segment === "string") {
        current =
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[segment]
            : undefined;
      } else {
        current = Array.isArray(current) ? current[segment] : undefined;
      }
    }
    return current;
  }

  /**
   * Parse a path into segments: "user.name[0]" → ["user", "name", 0].
   * Supports dynamic indexes "items[idx]" where idx resolves from the globals map.
   */
  private parsePath(path: string, variables: Record<string, unknown>): (string | number)[] {
    const segments: (string | number)[] = [];
    let current = "";
    let i = 0;

    while (i < path.length) {
      const char = path[i];
      if (char === ".") {
        if (current) {
          segments.push(current);
          current = "";
        }
        i++;
      } else if (char === "[") {
        if (current) {
          segments.push(current);
          current = "";
        }
        const close = path.indexOf("]", i);
        if (close === -1) {
          // Malformed; treat the rest as a literal key.
          current += path.slice(i);
          break;
        }
        const inner = path.slice(i + 1, close);
        if (/^\d+$/.test(inner)) {
          segments.push(Number(inner));
        } else {
          // Dynamic index resolved from a global variable.
          const resolved = variables[inner];
          if (typeof resolved === "number") {
            segments.push(resolved);
          } else if (typeof resolved === "string" && /^\d+$/.test(resolved)) {
            segments.push(Number(resolved));
          } else {
            segments.push(inner);
          }
        }
        i = close + 1;
      } else {
        current += char;
        i++;
      }
    }
    if (current) segments.push(current);
    return segments;
  }
}
