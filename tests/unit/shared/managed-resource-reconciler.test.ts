import { describe, expect, test } from "@jest/globals";
import { reconcileManagedResource, type ManagedResourceState } from "@mcp-moira/shared";

type Content = { value: string };
const absent: ManagedResourceState<Content> = { lifecycle: "absent" };
const present = (value: string): ManagedResourceState<Content> => ({
  lifecycle: "present",
  content: { value },
});
const deleted = (value: string): ManagedResourceState<Content> => ({
  lifecycle: "deleted",
  content: { value },
});

describe("managed resource reconciler", () => {
  test("classifies first install, safe first adoption, and divergent first adoption", () => {
    expect(reconcileManagedResource(null, absent, present("incoming"))).toMatchObject({
      classification: "first-install",
      selected: "incoming",
      advanceBaseline: true,
    });
    expect(reconcileManagedResource(null, present("same"), present("same"))).toMatchObject({
      classification: "first-adoption",
      selected: "current",
      advanceBaseline: true,
    });
    expect(reconcileManagedResource(null, present("user"), present("incoming"))).toMatchObject({
      classification: "baseline-missing",
      unresolved: true,
      selected: null,
    });
  });

  test("distinguishes unchanged, user-only, upstream-only, converged, and conflict", () => {
    const previous = present("base");
    expect(reconcileManagedResource(previous, previous, previous).classification).toBe("unchanged");
    expect(reconcileManagedResource(previous, present("user"), previous)).toMatchObject({
      classification: "user-only",
      selected: "current",
      advanceBaseline: false,
    });
    expect(reconcileManagedResource(previous, previous, present("upstream"))).toMatchObject({
      classification: "upstream-only",
      selected: "incoming",
      advanceBaseline: true,
    });
    expect(reconcileManagedResource(previous, present("merged"), present("merged"))).toMatchObject({
      classification: "converged",
      advanceBaseline: true,
    });
    expect(reconcileManagedResource(previous, present("user"), present("upstream"))).toMatchObject({
      classification: "conflict",
      unresolved: true,
    });
  });

  test("treats lifecycle changes as first-class three-way changes", () => {
    const previous = present("base");
    expect(reconcileManagedResource(previous, previous, deleted("base"))).toMatchObject({
      classification: "upstream-only",
      selected: "incoming",
    });
    expect(reconcileManagedResource(previous, deleted("base"), previous)).toMatchObject({
      classification: "user-only",
      selected: "current",
    });
    expect(reconcileManagedResource(previous, absent, previous)).toMatchObject({
      classification: "user-only",
      selected: "current",
    });
    expect(reconcileManagedResource(previous, present("user"), deleted("base"))).toMatchObject({
      classification: "conflict",
      unresolved: true,
    });
    expect(
      reconcileManagedResource(deleted("base"), deleted("base"), present("new")),
    ).toMatchObject({ classification: "upstream-only", selected: "incoming" });
  });
});
