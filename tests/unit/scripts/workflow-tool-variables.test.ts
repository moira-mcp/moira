/**
 * Tests for workflow-tool variables command
 * Tests variable extraction from workflows
 */

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const WORKFLOW_TOOL = path.join(process.cwd(), "scripts/workflow-tool.ts");

function runWorkflowTool(args: string): string {
  return execSync(`npx tsx ${WORKFLOW_TOOL} ${args}`, {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
}

function createTempWorkflow(workflow: object): string {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `test-workflow-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(workflow, null, 2));
  return tmpFile;
}

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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables --usage`);
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
        const output = runWorkflowTool(`${tmpFile} get-variable report_template`);
        expect(output).toContain("report_template");
        expect(output).toContain("HTML report template");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("set-variable creates a new global in variableRegistry (not initialData)", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      try {
        runWorkflowTool(`${tmpFile} set-variable new_flag "true value"`);
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
        runWorkflowTool(`${tmpFile} set-variable report_template "<new/>"`);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.variableRegistry.report_template.default).toBe("<new/>");
        expect(saved.variableRegistry.report_template.description).toBe("HTML report template");
        expect(saved.variableRegistry.report_template.type).toBe("string");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    test("delete-variable removes a global from variableRegistry", () => {
      const tmpFile = createTempWorkflow(registryWorkflow());
      try {
        runWorkflowTool(`${tmpFile} delete-variable report_template`);
        const saved = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
        expect(saved.variableRegistry.report_template).toBeUndefined();
      } finally {
        fs.unlinkSync(tmpFile);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
        const output = runWorkflowTool(`${tmpFile} variables`);
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
