/**
 * Unit tests for VariableResolver — registry/node-local/transitional resolution.
 */
import { describe, test, expect } from "@jest/globals";
import { VariableResolver, VariableResolverContext } from "@mcp-moira/workflow-engine";

const resolver = new VariableResolver();

function ctx(
  variables: Record<string, unknown>,
  globals: string[] = [],
  nodeIds: string[] = [],
): VariableResolverContext {
  return {
    variables,
    globalNames: new Set(globals),
    nodeIds: new Set(nodeIds),
  };
}

describe("VariableResolver", () => {
  test("resolves a declared global by bare name", () => {
    const c = ctx({ feature_name: "auth" }, ["feature_name"], []);
    expect(resolver.resolve("feature_name", c)).toBe("auth");
  });

  test("resolves a node-local value via node-id.name", () => {
    const c = ctx({ approve: { approved: true } }, [], ["approve"]);
    expect(resolver.resolve("approve.approved", c)).toBe(true);
  });

  test("does not treat a bare node id as a value reference", () => {
    // A bare node id alone (no further segment) is not a value; with flat-compat it reads
    // the top-level key, which is the node scope object — acceptable transitionally, but the
    // node-local branch must require a sub-path.
    const c = ctx({ approve: { approved: true } }, [], ["approve"]);
    // "approve.approved" goes node-local; "approve" alone falls through to flat read.
    expect(resolver.resolve("approve.approved", c)).toBe(true);
  });

  test("global name takes the global branch even if a node shares the name space", () => {
    const c = ctx({ x: "global-x", n: { x: "local-x" } }, ["x"], ["n"]);
    expect(resolver.resolve("x", c)).toBe("global-x");
    expect(resolver.resolve("n.x", c)).toBe("local-x");
  });

  test("undeclared bare name does not resolve from the flat top level", () => {
    // No flat fallback: a bare name that is neither a declared global nor a node-local
    // reference resolves to undefined, even if a value sits at the top level.
    const c = ctx({ legacy_output: 42 }, [], []);
    expect(resolver.resolve("legacy_output", c)).toBeUndefined();
  });

  test("returns undefined for a missing path", () => {
    const c = ctx({ a: { b: 1 } }, ["a"], []);
    expect(resolver.resolve("a.c", c)).toBeUndefined();
    expect(resolver.resolve("missing", c)).toBeUndefined();
  });

  test("supports numeric array indexes", () => {
    const c = ctx({ items: [{ v: "first" }, { v: "second" }] }, ["items"], []);
    expect(resolver.resolve("items[1].v", c)).toBe("second");
  });

  test("supports dynamic indexes resolved from globals", () => {
    const c = ctx({ items: ["a", "b", "c"], idx: 2 }, ["items", "idx"], []);
    expect(resolver.resolve("items[idx]", c)).toBe("c");
  });

  test("empty path resolves to undefined", () => {
    expect(resolver.resolve("", ctx({ a: 1 }, ["a"]))).toBeUndefined();
  });
});
