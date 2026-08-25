/**
 * Tests for the workflow-tool identity commands: set-name and set-slug.
 * Catalog identity is (owner, slug) and the display name is what agents read in list(),
 * so both edits must be exact, validated, and must not disturb the rest of the file.
 */

import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { randomUUID } from "crypto";

const WORKFLOW_TOOL = path.join(process.cwd(), "packages/workflow-cli/src/workflow-tool.ts");

function runWorkflowTool(args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", WORKFLOW_TOOL, ...args], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
}

function createTempWorkflow(): string {
  const workflow = {
    id: "11111111-2222-4333-8444-555555555555",
    slug: "old-slug",
    owner: "system-moira",
    visibility: "public",
    metadata: { name: "Old Name", version: "1.0.0", description: "Original description" },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end", connections: {} },
    ],
  };
  const tmpFile = path.join(os.tmpdir(), `identity-workflow-${randomUUID()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(workflow, null, 2));
  return tmpFile;
}

function read(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

describe("workflow-tool identity commands", () => {
  let file: string;

  beforeEach(() => {
    file = createTempWorkflow();
  });

  afterEach(() => {
    fs.rmSync(file, { force: true });
  });

  describe("set-name", () => {
    test("replaces the display name and reports the previous one", () => {
      const output = runWorkflowTool([file, "set-name", "Deep Corpus Research (expensive)"]);

      expect(read(file).metadata.name).toBe("Deep Corpus Research (expensive)");
      expect(output).toContain("Old name: Old Name");
      expect(output).toContain("New name: Deep Corpus Research (expensive)");
    });

    test("leaves slug, owner, description and nodes untouched", () => {
      runWorkflowTool([file, "set-name", "Another Name"]);
      const workflow = read(file);

      expect(workflow.slug).toBe("old-slug");
      expect(workflow.owner).toBe("system-moira");
      expect(workflow.metadata.description).toBe("Original description");
      expect(workflow.nodes.map((node: { id: string }) => node.id)).toEqual(["start", "end"]);
    });

    test("bumps the version because the content changed", () => {
      runWorkflowTool([file, "set-name", "Renamed"]);
      expect(read(file).metadata.version).not.toBe("1.0.0");
    });
  });

  describe("set-slug", () => {
    test("replaces the catalog slug and warns that a new catalog entry is created", () => {
      const output = runWorkflowTool([file, "set-slug", "deep-corpus-research"]);

      expect(read(file).slug).toBe("deep-corpus-research");
      expect(output).toContain("Old slug: old-slug");
      expect(output).toContain("creates a NEW catalog entry");
    });

    test("rejects a slug that is not kebab-case and leaves the file unchanged", () => {
      expect(() => runWorkflowTool([file, "set-slug", "Deep Corpus Research"])).toThrow();
      expect(read(file).slug).toBe("old-slug");

      expect(() => runWorkflowTool([file, "set-slug", "Deep_Corpus"])).toThrow();
      expect(read(file).slug).toBe("old-slug");
    });

    test("keeps the display name and node graph intact", () => {
      runWorkflowTool([file, "set-slug", "another-slug"]);
      const workflow = read(file);

      expect(workflow.metadata.name).toBe("Old Name");
      expect(workflow.nodes).toHaveLength(2);
    });
  });
});
