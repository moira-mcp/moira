# Workflow Scenario Testing Guide

## Checklist Before Writing Tests

**MANDATORY before writing tests:**

- [ ] Run `moira-workflow <file>.json list` to list the nodes
- [ ] Run `moira-workflow <file>.json get <node-id>` for each agent-directive
- [ ] Record the required fields and their types from inputSchema
- [ ] Check enum constraints (`["yes", "no"]` is not a boolean!)
- [ ] Check array of objects vs string
- [ ] Identify cycles with `detectCycles()` or `moira-workflow <file>.json structure --graph`
- [ ] Plan mock inputs for each loop iteration

---

## CLI Commands for Schema Extraction

The `moira-workflow` CLI ships in `packages/workflow-cli` (run `npm link` there to
install it globally).

**List all workflow nodes:**

```bash
moira-workflow workflows/production/public/data-analysis.json list
moira-workflow workflows/production/public/data-analysis.json list --type agent-directive
```

**Get a specific node with its inputSchema:**

```bash
moira-workflow workflows/production/public/data-analysis.json get get-context
```

**Example output:**

```json
{
  "id": "get-context",
  "type": "agent-directive",
  "directive": "Gather business context...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "business_question": { "type": "string", "minLength": 10 },
      "context": { "type": "string" },
      "data_sources": { "type": "string", "minLength": 5 }
    },
    "required": ["business_question", "context", "data_sources"],
    "additionalProperties": false
  }
}
```

**Graph structure (for loops):**

```bash
moira-workflow workflows/production/public/data-analysis.json structure --graph
```

---

## Common Mistakes

### 1. Boolean vs string enum

**Schema:** `{ "approved": { "enum": ["yes", "no"] } }`

```typescript
// WRONG
{
  approved: true;
}

// CORRECT
{
  approved: "yes";
}
```

### 2. Array vs string

**Schema:** `{ "data_sources": { "type": "string", "minLength": 5 } }`

```typescript
// WRONG
{
  data_sources: ["db1", "db2"];
}

// CORRECT
{
  data_sources: "db1, db2";
}
```

### 3. String vs object array

**Schema:**

```json
{
  "target_users": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": { "name": { "type": "string" }, "role": { "type": "string" } },
      "required": ["name", "role"]
    }
  }
}
```

```typescript
// WRONG
{
  target_users: ["developer", "designer"];
}

// CORRECT
{
  target_users: [{ name: "Developer", role: "End User" }];
}
```

### 4. Missing required fields in nested objects

**Schema:** `{ "items": { "required": ["name", "price", "source"] } }`

```typescript
// WRONG - missing "source"
{
  candidates: [{ name: "Product", price: 100 }];
}

// CORRECT
{
  candidates: [{ name: "Product", price: 100, source: "Amazon" }];
}
```

### 5. Wrong enum value

**Schema:** `{ "data_source_type": { "enum": ["inline", "file"] } }`

```typescript
// WRONG
{
  data_source_type: "external";
}

// CORRECT
{
  data_source_type: "file";
}
```

---

## Handling Loops (Cycles)

Workflows with cycles (define → approve → condition → back to define) require arrays of mock inputs.

**Example: revision loop**

```typescript
mockInputs: {
  // Array-based: first visit rejected, second approved
  "define-problem": [
    { research_question: "Vague question..." },  // First visit - rejected
    { research_question: "Clear and specific question" }   // Second visit - approved
  ],
  "approve-problem": [
    { approved: "no", feedback: "Too vague, be more specific" },  // First: reject
    { approved: "yes" }  // Second: approve
  ]
}
```

**Function-based for dynamic values:**

```typescript
mockInputs: {
  "create-workspace": (ctx) => ({
    path: `./iteration-${ctx.visitCount + 1}/`,
    name: `workspace_${ctx.variables.projectName || 'default'}`
  })
}
```

The runner cycles through the array elements for each visit to the node.

---

## Context Path Resolution

Condition nodes use `contextPath` to read values:

```json
{
  "type": "condition",
  "condition": {
    "operator": "eq",
    "left": { "contextPath": "approve-problem.approved" },
    "right": "yes"
  }
}
```

**How it works:**

1. The agent completes a node with input `{ approved: "yes" }`
2. The engine merges the data into `context.variables`
3. The condition resolves `contextPath` via `getNestedValue()`

**KNOWN ISSUE: FLAT merge**

The engine performs a FLAT merge of data into context.variables. The `node-id.field` format expects nested storage, but the current implementation may store data flat.

**Symptoms of contextPath problems:**

- `evaluatedValues: { "node.field": undefined }` in test results
- Infinite loop at a condition node
- Status "running" instead of "completed"

**Workaround in tests:**

Make sure mock inputs use the exact fields the condition actually reads.

---

## Debugging Failed Scenarios

### 1. Check visitedNodes for loop patterns

```
visitedNodes: ["start", "get-context", "define-problem", "approve-problem",
               "check-approved", "define-problem", "approve-problem", ...]
               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
               Repeating pattern = infinite loop at condition
```

### 2. Check finalContext for missing values

```typescript
// Good - value present
finalContext: { approved: "yes", ... }

// Bad - not resolved
evaluatedValues: { "approve.approved": undefined }
```

### 3. Run a single scenario with logging

```typescript
const result = await runScenario(workflow, scenario);
console.log("Status:", result.status);
console.log("Visited:", result.visitedNodes);
console.log("Context:", result.finalContext);
console.log("Step count:", result.stepCount);
```

### 4. Check the step count

```typescript
// Default max is 100 steps
// If stepCount === 100 and status === "running" → infinite loop
expect(result.stepCount).toBeLessThan(100);
```

### 5. Use gap analysis

```typescript
const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
console.log(formatCoverageReport(coverage));

// Shows uncovered nodes and branches with hints:
// Gap Analysis:
//   condition: 1 uncovered
//     - check-approved:false
//       Hint: Set condition variables to make check-approved evaluate false
```

---

## Test Structure Template

```typescript
import { runScenario, TestScenario } from "../../helpers/scenario-runner.js";
import {
  calculateCoverage,
  formatCoverageReport,
  assertCoverage,
} from "../../helpers/coverage-calculator.js";
import { GraphValidator, detectCycles } from "@mcp-moira/workflow-engine";
import { findSystemCatalogEntry } from "@mcp-moira/shared";

function loadProductionWorkflow(): WorkflowGraph {
  return findSystemCatalogEntry("workflow-name", "public")!.graph as WorkflowGraph;
}

describe("workflow-name Scenarios", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadProductionWorkflow();
  });

  describe("Structural Validation", () => {
    it("should have valid structure", async () => {
      const validator = new GraphValidator();
      const withId = { id: `moira/${workflow.slug || "workflow-name"}`, ...workflow };
      const validation = await validator.validateWorkflow(withId);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should detect expected cycles", () => {
      const cycles = detectCycles(workflow);
      // Adjust based on workflow design
      expect(cycles.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Scenario Coverage", () => {
    const scenarios: TestScenario[] = [
      // Happy path
      {
        name: "happy path - all approvals pass",
        mockInputs: {
          "node-1": { field: "value" },
          "node-2": { approved: "yes" },
        },
        expect: {
          status: "completed",
          reaches: ["end"],
        },
      },
      // Rejection path
      {
        name: "rejection - needs revision",
        mockInputs: {
          "node-1": { field: "value" },
          "node-2": [{ approved: "no", feedback: "Needs work" }, { approved: "yes" }],
        },
        expect: {
          status: "completed",
        },
      },
    ];

    it.each(scenarios)("$name", async (scenario) => {
      const result = await runScenario(workflow, scenario);
      expect(result.passed).toBe(true);
      if (!result.passed) {
        console.log("Failed expectations:", result.failedExpectations);
        console.log("Visited:", result.visitedNodes);
      }
    });

    it("should achieve 100% node and branch coverage", async () => {
      const results = await Promise.all(scenarios.map((s) => runScenario(workflow, s)));

      const failedScenarios = results.filter((r) => !r.passed);
      expect(failedScenarios).toHaveLength(0);

      const coverage = calculateCoverage(workflow, results, {
        includeGapAnalysis: true,
      });

      console.log(formatCoverageReport(coverage));

      assertCoverage(coverage, 100, { type: "node" });
      assertCoverage(coverage, 100, { type: "branch" });
    });
  });
});
```

---

## Key Files

| File                                           | Purpose                                             |
| ---------------------------------------------- | --------------------------------------------------- |
| `tests/helpers/scenario-runner.ts`             | Runs scenarios with mock inputs                     |
| `tests/helpers/coverage-calculator.ts`         | Calculates node/branch coverage                     |
| `@mcp-moira/workflow-engine`                   | GraphValidator + detectCycles                       |
| `findSystemCatalogEntry` (`@mcp-moira/shared`) | Loads bundled production workflows from the catalog |
| `tests/workflow/scenarios/`                    | Scenario test files                                 |
