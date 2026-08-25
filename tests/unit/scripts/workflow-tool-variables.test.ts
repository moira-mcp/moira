/**
 * Tests for workflow-tool variables command
 * Tests variable extraction from workflows
 */

import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { randomUUID } from "crypto";

const WORKFLOW_TOOL = path.join(process.cwd(), "packages/workflow-cli/bin/moira-workflow.js");

function runWorkflowTool(args: string[], cwd = process.cwd()): string {
  return execFileSync(process.execPath, [WORKFLOW_TOOL, ...args], {
    encoding: "utf-8",
    cwd,
  });
}

function createTempWorkflow(workflow: object): string {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `test-workflow-${randomUUID()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(workflow, null, 2));
  return tmpFile;
}

describe("agent-facing CLI diagnostics", () => {
  test("--version identifies both the package version and exact source checkout", () => {
    const output = runWorkflowTool(["--version"], os.tmpdir());

    expect(output).toContain("@mcp-moira/workflow-cli 0.4.0");
    expect(output).toContain(path.normalize("packages/workflow-cli/src/workflow-tool.ts"));
  });

  test("validate exits unsuccessfully when the workflow is invalid", () => {
    const tmpFile = createTempWorkflow({
      id: "invalid-workflow",
      metadata: { name: "Invalid", version: "1.0.0", description: "Invalid" },
      nodes: [{ id: "start", type: "start", connections: { default: "missing-node" } }],
    });
    try {
      expect(() => runWorkflowTool([tmpFile, "validate"])).toThrow();
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe("workflow-tool variables command", () => {
  describe("initialData extraction", () => {
    test("extracts variables from initialData", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "start",
            type: "start",
            initialData: {
              variables: {
                project_name: { description: "Project name", value: "My Project" },
                feature_branch: { description: "Feature branch", value: "feature/test" },
              },
            },
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        expect(output).toContain("project_name");
        expect(output).toContain("feature_branch");
        expect(output).toContain("[initial]");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("inputSchema extraction", () => {
    test("extracts variables from inputSchema properties", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "input-node",
            type: "directive",
            directive: "Get input",
            inputSchema: {
              type: "object",
              properties: {
                user_choice: { type: "string", description: "User selection" },
                confirm: { type: "boolean" },
              },
            },
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        expect(output).toContain("user_choice");
        expect(output).toContain("confirm");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("template extraction", () => {
    test("extracts variables from {{var}} templates", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "directive-node",
            type: "directive",
            directive: "Create file in {{workspace_path}} for {{feature_name}}",
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        expect(output).toContain("workspace_path");
        expect(output).toContain("feature_name");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("extracts variables from {{#if var}} conditionals", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "directive-node",
            type: "directive",
            directive: "{{#if has_tests}}Run tests{{/if}}",
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        expect(output).toContain("has_tests");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("extracts nested field access {{var.field}}", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "directive-node",
            type: "directive",
            directive: "User email: {{user.email}}, name: {{user.name}}",
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        // Output shows the full path like user.email
        expect(output).toContain("user");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("condition expression extraction", () => {
    test("extracts variables from condition object format", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "condition-node",
            type: "condition",
            condition: {
              operator: "gt",
              left: { contextPath: "step_count" },
              right: 0,
            },
            connections: { true: "next", false: "other" },
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        expect(output).toContain("step_count");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("expression node extraction", () => {
    test("extracts variables from expression nodes", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "expr-node",
            type: "expression",
            value: "counter + offset",
            outputVariable: "result",
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        expect(output).toContain("counter");
        expect(output).toContain("offset");
        expect(output).toContain("result");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("filters JavaScript keywords from expression nodes", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "expr-node",
            type: "expression",
            value: "counter > 0 ? true : false",
            outputVariable: "is_positive",
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        expect(output).toContain("counter");
        expect(output).toContain("is_positive");
        // Should NOT contain JS keywords as variables (true/false are keywords)
        // The output format is "● var_name [type] used Nx"
        // If true/false were captured they'd appear as "● true" or "● false"
        const lines = output.split("\n");
        const varLines = lines.filter((l) => l.startsWith("●"));
        const hasTrue = varLines.some((l) => l.includes("● true"));
        const hasFalse = varLines.some((l) => l.includes("● false"));
        expect(hasTrue).toBe(false);
        expect(hasFalse).toBe(false);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("--usage flag", () => {
    test("shows usage locations with --usage flag", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "start",
            type: "start",
            initialData: {
              variables: {
                my_var: { description: "Test variable", value: "value" },
              },
            },
          },
          {
            id: "use-var",
            type: "directive",
            directive: "Use {{my_var}} here",
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables", "--usage"]);
        expect(output).toContain("my_var");
        // With --usage flag, should show node ID and field where variable is used
        expect(output).toContain("use-var");
        // Note: "Used in:" shows where variable is USED, not where defined
        // The start node defines it via initialData, but --usage shows usage locations
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("registry-backed get/set/delete-variable", () => {
    // The get/set/delete-variable commands operate on variableRegistry (the single source of
    // truth for declared globals), NOT the removed start-node initialData.variables.
    function registryWorkflow() {
      return {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        variableRegistry: {
          report_template: { type: "string", description: "HTML report template", default: "<x/>" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      };
    }

    test("get-variable reads a declared global from variableRegistry", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      try {
        const output = runWorkflowTool([tmpFile, "get-variable", "report_template"]);
        expect(output).toContain("report_template");
        expect(output).toContain("HTML report template");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("set-variable creates a new global in variableRegistry (not initialData)", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      try {
        runWorkflowTool([tmpFile, "set-variable", "new_flag", "true value"]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.variableRegistry.new_flag).toBeDefined();
        expect(saved.variableRegistry.new_flag.default).toBe("true value");
        // The removed model must not reappear
        const startNode = saved.nodes.find((n: any) => n.type === "start");
        expect(startNode.initialData).toBeUndefined();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("set-variable preserves description/type of an existing global", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      try {
        runWorkflowTool([tmpFile, "set-variable", "report_template", "<new/>"]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.variableRegistry.report_template.default).toBe("<new/>");
        expect(saved.variableRegistry.report_template.description).toBe("HTML report template");
        expect(saved.variableRegistry.report_template.type).toBe("string");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("set-variable-schema accepts --force without including it in JSON", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      try {
        runWorkflowTool([
          tmpFile,
          "set-variable-schema",
          "result",
          '{"type":"array","description":"Result history","items":{"type":"string"},"default":[]}',
          "--force",
        ]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.variableRegistry.result).toEqual({
          type: "array",
          description: "Result history",
          items: { type: "string" },
          default: [],
        });
        expect(saved.metadata.version).toBe("1.0.0");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("set-variable-schema reads complex JSON Schema from a file", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      const schemaFile = path.join(os.tmpdir(), `variable-schema-${randomUUID()}.json`);
      const schema = {
        type: "object",
        description: "Structured result",
        properties: {
          status: { type: "string", enum: ["complete", "limited"] },
          findings: { type: "array", items: { type: "string" } },
        },
        required: ["status", "findings"],
        additionalProperties: false,
        default: { status: "complete", findings: [] },
      };
      fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
      try {
        runWorkflowTool([
          tmpFile,
          "set-variable-schema",
          "result",
          "--file",
          schemaFile,
          "--force",
        ]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.variableRegistry.result).toEqual(schema);
        expect(saved.metadata.version).toBe("1.0.0");
      } finally {
        fs.unlinkSync(tmpFile);
        fs.unlinkSync(schemaFile);
      }
    });

    test("delete-variable removes a global from variableRegistry", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      try {
        runWorkflowTool([tmpFile, "delete-variable", "report_template"]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.variableRegistry.report_template).toBeUndefined();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("workflow metadata commands", () => {
    test("set-description updates the package CLI target without storing --force", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Old description" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        runWorkflowTool([tmpFile, "set-description", "New workflow description", "--force"]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.metadata.description).toBe("New workflow description");
        expect(saved.metadata.version).toBe("1.0.0");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("set-description reads a multiline description from a file", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Old description" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      const descriptionFile = path.join(os.tmpdir(), `workflow-description-${randomUUID()}.txt`);
      fs.writeFileSync(descriptionFile, "First paragraph.\n\nSecond paragraph.\n");
      try {
        runWorkflowTool([tmpFile, "set-description", "--file", descriptionFile, "--force"]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.metadata.description).toBe("First paragraph.\n\nSecond paragraph.");
        expect(saved.metadata.version).toBe("1.0.0");
      } finally {
        fs.unlinkSync(tmpFile);
        fs.unlinkSync(descriptionFile);
      }
    });
  });

  describe("workflow migration commands", () => {
    function migrationWorkflow() {
      return {
        id: "migration-flow",
        metadata: { name: "Migration", version: "2.0.0", description: "Test" },
        variableRegistry: {
          global_result: { type: "string", description: "Global result", default: "" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Produce",
            completionCondition: "Produced",
            inputSchema: {
              type: "object",
              properties: { local_result: { type: "string" } },
              required: ["local_result"],
            },
            maxRetries: 3,
            retryMessage: "legacy",
            currentRetries: 1,
            connections: { success: "end" },
          },
          { id: "end", type: "end", finalOutput: ["local_result", "global_result"] },
        ],
      };
    }

    test("replace preserves node position and requires the same id", () => {
      const tmpFile = createTempWorkflow(migrationWorkflow());
      const replacementFile = path.join(os.tmpdir(), `replacement-${Date.now()}.json`);
      fs.writeFileSync(
        replacementFile,
        JSON.stringify({
          id: "produce",
          type: "expression",
          expressions: ["global_result = 1"],
          connections: { default: "end" },
        }),
      );
      try {
        runWorkflowTool([tmpFile, "replace", "produce", replacementFile, "--force"]);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.nodes.map((node: { id: string }) => node.id)).toEqual([
          "start",
          "produce",
          "end",
        ]);
        expect(saved.nodes[1].type).toBe("expression");
      } finally {
        fs.unlinkSync(tmpFile);
        fs.unlinkSync(replacementFile);
      }
    });

    test("update --final-output configures an End projection", () => {
      const tmpFile = createTempWorkflow(migrationWorkflow());
      try {
        runWorkflowTool([tmpFile, "update", "end", "--final-output", '["global_result"]']);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.nodes[2].finalOutput).toEqual(["global_result"]);
        expect(saved.metadata.version).toBe("2.0.1");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("sync replaces content while preserving the destination identity", () => {
      const sourceWorkflow = {
        ...migrationWorkflow(),
        id: "workspace-copy",
      };
      const source = createTempWorkflow(sourceWorkflow);
      const destination = createTempWorkflow({
        ...migrationWorkflow(),
        id: "catalog-workflow",
        slug: "catalog-slug",
        owner: "catalog-owner",
        visibility: "public",
        metadata: {
          name: "Old",
          version: "1.0.0",
          description: "Old",
          author: "catalog-author",
          tags: ["catalog-tag"],
        },
      });
      try {
        runWorkflowTool([source, "sync", destination]);
        const saved = JSON.parse(fs.readFileSync(destination, "utf-8"));
        expect(saved).toEqual({
          ...sourceWorkflow,
          id: "catalog-workflow",
          slug: "catalog-slug",
          owner: "catalog-owner",
          visibility: "public",
          metadata: {
            ...sourceWorkflow.metadata,
            author: "catalog-author",
            tags: ["catalog-tag"],
          },
        });
      } finally {
        fs.unlinkSync(source);
        fs.unlinkSync(destination);
      }
    });

    test("sync leaves the destination byte-for-byte unchanged when the result is invalid", () => {
      const source = createTempWorkflow({
        ...migrationWorkflow(),
        id: "invalid-source",
        nodes: [
          { id: "start", type: "start", connections: { default: "missing-node" } },
          { id: "end", type: "end" },
        ],
      });
      const destination = createTempWorkflow({
        ...migrationWorkflow(),
        id: "catalog-workflow",
        slug: "catalog-slug",
        owner: "catalog-owner",
        visibility: "public",
      });
      const before = fs.readFileSync(destination);
      try {
        expect(() => runWorkflowTool([source, "sync", destination])).toThrow();
        expect(fs.readFileSync(destination)).toEqual(before);
      } finally {
        fs.unlinkSync(source);
        fs.unlinkSync(destination);
      }
    });
  });

  describe("empty/null handling", () => {
    test("handles workflow with no variables", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          {
            id: "simple",
            type: "directive",
            directive: "Do something without variables",
          },
        ],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        // Output has ANSI codes, so check parts separately
        expect(output).toContain("Total:");
        expect(output).toContain("0");
        expect(output).toContain("variable(s)");
        // Ensure no variable bullets appear
        expect(output).not.toContain("●");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("handles empty nodes array", () => {
      const workflow = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [],
      };
      const tmpFile = createTempWorkflow(workflow);
      try {
        const output = runWorkflowTool([tmpFile, "variables"]);
        // Output has ANSI codes, so check parts separately
        expect(output).toContain("Total:");
        expect(output).toContain("0");
        expect(output).toContain("variable(s)");
        // Ensure no variable bullets appear
        expect(output).not.toContain("●");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
