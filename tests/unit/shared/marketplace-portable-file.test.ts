/**
 * Unit tests for the portable flow-file envelope (build + parse).
 *
 * The envelope is the single `.moira.json` shape emitted by BOTH export paths and
 * accepted by import; the parser also tolerates a bare workflow graph. These tests pin
 * the round-trip and the rejection of non-workflow input.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildPortableFile,
  parsePortableFile,
  importKeyFromSource,
  PortableFileParseError,
  PORTABLE_FILE_FORMAT_VERSION,
  PORTABLE_FILE_KIND,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const graph = {
  id: "wf-1",
  metadata: { name: "Demo", version: "1.0.0", description: "d" },
  nodes: [
    { type: "start", id: "s", connections: { default: "e" } },
    { type: "end", id: "e" },
  ],
} as unknown as WorkflowGraph;

describe("portable flow-file: buildPortableFile", () => {
  it("wraps a graph in a discriminated envelope", () => {
    const file = buildPortableFile(graph);
    expect(file.moiraFile).toBe(PORTABLE_FILE_KIND);
    expect(file.formatVersion).toBe(PORTABLE_FILE_FORMAT_VERSION);
    expect(file.workflow).toBe(graph);
    expect(file.source).toBeUndefined();
  });

  it("attaches a compacted source (drops undefined fields)", () => {
    const file = buildPortableFile(graph, {
      instance: "https://moira-mcp.com",
      listingId: "L1",
      listingRef: "admin/demo",
      version: "2.0.0",
      workflowId: undefined,
    });
    expect(file.source).toEqual({
      instance: "https://moira-mcp.com",
      listingId: "L1",
      listingRef: "admin/demo",
      version: "2.0.0",
    });
    expect(file.source && "workflowId" in file.source).toBe(false);
  });

  it("omits source entirely when every field is empty", () => {
    const file = buildPortableFile(graph, { instance: undefined });
    expect(file.source).toBeUndefined();
  });
});

describe("portable flow-file: parsePortableFile", () => {
  it("round-trips an envelope and returns its graph + source", () => {
    const file = buildPortableFile(graph, { instance: "https://x", listingId: "L1" });
    const parsed = parsePortableFile(file);
    expect(parsed.workflow).toEqual(graph);
    expect(parsed.source).toEqual({ instance: "https://x", listingId: "L1" });
  });

  it("accepts a bare workflow graph (input tolerance) with no source", () => {
    const parsed = parsePortableFile(graph);
    expect(parsed.workflow).toEqual(graph);
    expect(parsed.source).toBeUndefined();
  });

  it("rejects the legacy wrapped { listing, workflow } shape (no back-compat shim)", () => {
    // Pre-v1.0.0: no migration layer for old-version files. Both export paths now set the
    // `moiraFile` discriminator, so the old wrapped shape (no discriminator) is rejected.
    const wrapped = { listing: { id: "L1", title: "Demo" }, workflow: graph };
    expect(() => parsePortableFile(wrapped)).toThrow(PortableFileParseError);
  });

  it("rejects a non-object", () => {
    expect(() => parsePortableFile("nope")).toThrow(PortableFileParseError);
    expect(() => parsePortableFile(null)).toThrow(PortableFileParseError);
  });

  it("rejects an envelope whose workflow is not a graph", () => {
    expect(() => parsePortableFile({ moiraFile: "workflow", workflow: { nope: true } })).toThrow(
      /Not a workflow file/,
    );
  });

  it("rejects an object that is neither an envelope nor a graph", () => {
    expect(() => parsePortableFile({ hello: "world" })).toThrow(PortableFileParseError);
    expect(() => parsePortableFile({ metadata: {} })).toThrow(/Not a workflow file/);
  });
});

describe("portable flow-file: importKeyFromSource", () => {
  it("keys a store pull on instance + listingId", () => {
    expect(importKeyFromSource({ instance: "https://x", listingId: "L1" })).toBe(
      "https://x|listing|L1",
    );
  });

  it("keys a same-instance export on instance + workflowId", () => {
    expect(importKeyFromSource({ instance: "https://x", workflowId: "W1" })).toBe(
      "https://x|workflow|W1",
    );
  });

  it("prefers listingId over workflowId when both are present", () => {
    expect(importKeyFromSource({ instance: "https://x", listingId: "L1", workflowId: "W1" })).toBe(
      "https://x|listing|L1",
    );
  });

  it("returns null without a usable identity (no instance, empty, or non-string)", () => {
    expect(importKeyFromSource(undefined)).toBeNull();
    expect(importKeyFromSource(null)).toBeNull();
    expect(importKeyFromSource({})).toBeNull();
    expect(importKeyFromSource({ listingId: "L1" })).toBeNull(); // no instance
    expect(importKeyFromSource({ instance: "https://x" })).toBeNull(); // no id
    expect(importKeyFromSource({ instance: "https://x", listingId: "  " })).toBeNull();
    // untrusted non-string fields are ignored (no wrong match)
    expect(
      importKeyFromSource({ instance: "https://x", listingId: 42 as unknown as string }),
    ).toBeNull();
  });
});
