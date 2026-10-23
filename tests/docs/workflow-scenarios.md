# Workflow scenario testing

The scenario harness runs `GraphExecutionEngine` directly with a fresh `InMemoryRepository`,
controlled answers and dependencies. These scenarios protect authored graph paths and contracts;
mock review answers do not establish independent agent judgment. The workflow test family also
contains executor contract tests. Use the [testing guide](../TESTING-GUIDE.md) for level selection.

## Read the authored contract

Inspect the current graph before writing answers. The repository CLI exposes the actual node
schemas and routes:

```bash
node packages/workflow-cli/bin/moira-workflow.js workflows/production/flows/5dd9c5c3-1176-4967-9d6c-798134b769df.json list
node packages/workflow-cli/bin/moira-workflow.js workflows/production/flows/5dd9c5c3-1176-4967-9d6c-798134b769df.json structure --graph
```

Use `get <node-id>` for each answering step. Read required fields, enum values, nested schemas,
declared globals, node-local outputs and routing cases. Do not guess an answer from a step's title.
`"yes"` is not `true`; a string is not an array; an array of objects needs each required property.
Use [catalog-graphs.ts](../helpers/catalog-graphs.ts) to obtain an editable copy of a bundled graph
instead of reproducing catalog lookup and casts. The [CLI reference](../../docs/reference/workflow-cli.md)
describes the command owner.

## Inputs and loops

[scenario-runner.ts](../helpers/scenario-runner.ts) accepts a static object, an array of per-visit
objects, or a function receiving `variables`, engine-owned `executionId`, `visitCount`, `nodeId`
and the presented `directive`. Arrays cycle through their elements on repeated visits. Include
the inputs needed for rejection, repair and later approval rather than hoping a loop terminates.

```typescript
const mockInputs = {
  "review-result": [{ approved: "no", feedback: "Missing evidence" }, { approved: "yes" }],
};
```

This illustrates input sequencing; field names and values must match the graph under test.
Dynamic answers can use the current directive and execution identity for run-correlated paths.
Use `initialVariables` only for an intentional focused scenario; do not seed hidden state that
allows an ordinary route to pass without its producer.

Node-local answers remain under their node scope; a later `contextPath` such as
`review-result.approved` reads that output. Bare global names require the registry and declared
input contract. Do not flatten answers in fixtures to bypass scope validation.

## Run and assert

For a scenario file in `tests/workflow/scenarios/`, reuse the existing harness:

```typescript
import { expect } from "@jest/globals";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { runScenario, type TestScenario } from "../../helpers/scenario-runner.js";

async function checkScenario(graph: WorkflowGraph, scenario: TestScenario) {
  const result = await runScenario(graph, scenario);
  expect(result.passed).toBe(true);
}
```

Pass the actual graph and schema-valid scenario to this assertion helper from the test case.
Use `expect.reaches`, `avoids` and `contextContains` for the relevant outcome in addition to status.
The runner's `stepCount` counts engine cycles, not authored nodes. On a bounded retry scenario,
declare expected validation errors through `allowValidationErrorsAt`; do not broadly silence
unexpected refusals. Use the existing `engineSetup` option for controlled handlers such as notes
rather than starting unrelated services or copying engine behavior.

The runner validates rendered directive and completion-condition text for unresolved template
markers. Read `failedExpectations`, `error`, `visitedNodes`, `visits`, submitted inputs and final context
when a case fails. At the cycle bound it reports repeated/missing/unused inputs and route
diagnostics. Fix the schema, producer, answer or routing cause before raising a bound.

## Coverage and its limits

[scenario-runner.ts](../helpers/scenario-runner.ts) retains each returned engine cycle's
`visitedNodes` and `visits` before running its own diagnostics. `ScenarioResult.visits` contains
raw chronological `EngineVisit` observations, including open waits and later resumes. This is not
the persisted execution journal: the stateful executor separately assigns sequence numbers,
folds a resumed wait into its open visit and records actor adjustments. The harness does not
reconstruct absent engine observations from neighboring node IDs.

[coverage-calculator.ts](../helpers/coverage-calculator.ts) reports distinct facts:

- Node coverage is the set of authored node IDs present in `visitedNodes`, relative to all
  authored nodes.
- Branch coverage is the set of observed `(nodeId, exitKey)` pairs with non-null exits that match
  declared connections, relative to all declared connections. Repeated traversals count once.
- `passedCount` counts results whose scenario expectations and runner diagnostics passed; it is
  independent of node and branch coverage. Executed observations from a failed scenario can
  contribute coverage, so assert scenario success separately from coverage thresholds.

If `approved` and `default` both target `end`, only the observed selected exit receives credit.
A wait, rejected answer or completion has a null exit and credits no outgoing branch; an accepted
resume or loop traversal contributes its actual exit. A harness teleport redirect does not credit
the paused source's connection merely because it points to the same target. The target's own
observed declared exit can still count.

Use the gap report to locate missing nodes and outputs, preserve meaningful existing thresholds,
and inspect observations when diagnosing a gap. Coverage establishes execution under the supplied
fixtures; it does not prove independent review quality, correctness of every answer, external
provider delivery or physical native effects.

```bash
npm run test:workflow -- --file tests/workflow/scenarios/coverage.test.ts
npm run test:workflow -- --file tests/workflow/scenarios/quick-task.test.ts
npm run typecheck:tests
```

Read the selected suite's Markdown coverage/failure artifacts first, then the executor log for
crashes or setup failures. Do not lower a threshold to hide a gap, delete tests because a keyword
scanner calls them duplicates, or add a second observer framework to reproduce the engine.
