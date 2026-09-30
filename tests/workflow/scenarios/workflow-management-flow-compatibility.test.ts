/**
 * Runs already in progress when the Workflow Management Flow's authoring rules changed. The change
 * rewrote seven directives — the design and edit-plan rules on progress and `humanGate`, the two
 * producers' authoring command, the two reviews' blocking findings, and the full audit's instruction
 * to raise `session await-user` when it asks — so a run paused on one
 * of them, on the earlier wording, no longer matches the flow. Each such run must still reach its
 * next step on the same execution: `diagnose` names the changed directive as blocking, `recover`
 * puts the run back on the step under the current wording, and an ordinary step moves it on.
 *
 * The earlier definition is the current bundled flow with one changed phrase of the step put back
 * as it read before: enough for the step's continuation surface to differ as it does after the real
 * change, which is what decides whether a paused run can continue.
 */

import { describe, expect, test } from "@jest/globals";
import {
  diagnoseContinuation,
  InMemoryRepository,
  MaterializeHandler,
  recoverContinuation,
  UniversalGraphExecutor,
  type AgentDirectiveNode,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

const USER_ID = "wmf-compatibility-user";
const current = catalogGraph("workflow-management-flow");

/** Per changed step: a sentence as it reads now, and as it read before the change. */
const EARLIER: Record<string, Array<[now: string, before: string]>> = {
  "design-workflow-structure": [
    [
      "Specify progress by default for a workflow of more than one stage",
      "Specify progress only when it materially helps",
    ],
  ],
  "create-edit-plan": [
    [
      ", and marks every affected step that waits for a person's decision with `humanGate` as `reference/progress.md` requires.",
      ".",
    ],
  ],
  "create-workflow-json": [
    [
      " Author each `humanGate` the design specifies with the CLI `update <node> --human-gate '<json>'`.",
      "",
    ],
  ],
  "apply-workflow-changes": [
    [
      " Author or remove each `humanGate` the plan specifies with the CLI `update <node> --human-gate '<json>'` (`none` removes it).",
      "",
    ],
  ],
  "review-workflow-design": [
    ["The three blocking findings of that reference's review section", "Findings"],
  ],
  "review-workflow-quality": [
    ["The three blocking findings of that reference's review section", "Findings"],
  ],
  "audit-complete-workflow": [
    [
      "; this step is mostly your own audit and is not marked as waiting for a person, so when you ask, raise the question with",
      ". When you ask, use",
    ],
  ],
};

/** The first step's answer: what the run is for, in which mode, and where it works. */
const WORKSPACE = {
  action_type: "create",
  operating_mode: "interactive",
  workspace_path: "./moira-ws/wmf",
  execution_note: "Release list",
  progress_source_outcome: "A new workflow, interactive",
};

/**
 * What the changed steps read from the run, supplied on recovery as the run would have them by
 * then; recovery refuses a step whose references it cannot resolve.
 */
const RUN_VALUES: Record<string, unknown> = {
  workspace_path: "./moira-ws/wmf",
  workflow_artifact_path: "./moira-ws/wmf/workflow.json",
  escalation_reason: "",
  complexity_tier: "standard",
  action_type: "create",
  planned_changes: [{ title: "Collect the release items" }],
  // The reviews quote the root cause a preceding repair reported, when there was one.
  "fix-create-design": { root_cause_class: "", changed_knowledge: "" },
  "fix-edit-plan": { root_cause_class: "", changed_knowledge: "" },
  "fix-quality-issues": { root_cause_class: "", changed_knowledge: "" },
};

/** A valid answer at each step, as an agent would give it. */
const ANSWERS: Record<string, Record<string, unknown>> = {
  "design-workflow-structure": {
    planned_changes: [{ title: "Collect the release items" }],
    progress_design_outcome: "Design ready",
  },
  "create-edit-plan": {
    planned_changes: [{ title: "Add the sign-off step" }],
    progress_design_outcome: "Edit plan ready",
  },
  "create-workflow-json": {
    workflow_artifact_path: "./moira-ws/wmf/workflow.json",
    progress_build_outcome: "Built",
  },
  "apply-workflow-changes": { progress_build_outcome: "Changes applied" },
  "review-workflow-design": { design_review_outcome: "pass" },
  "review-workflow-quality": {
    quality_review_outcome: "pass",
    progress_review_outcome: "No findings",
  },
  "audit-complete-workflow": { additional_edit_scope: "none" },
};

/**
 * An executor over the in-memory repository. Materialize grants live in the token store, which a
 * workflow scenario has no database for; the bootstrap step only needs to pass.
 */
function executorFor(repository: InMemoryRepository): UniversalGraphExecutor {
  const executor = new UniversalGraphExecutor(repository);
  const engine = (
    executor as unknown as { graphEngine: { nodeHandlers: Map<string, MaterializeHandler> } }
  ).graphEngine;
  engine.nodeHandlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "compatibility-token" },
      () => "https://moira.example",
    ),
  );
  return executor;
}

function withDirective(
  graph: WorkflowGraph,
  nodeId: string,
  rewrite: (text: string) => string,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? { ...node, directive: rewrite((node as AgentDirectiveNode).directive) }
        : node,
    ),
  };
}

function earlier(nodeId: string): WorkflowGraph {
  return withDirective(current, nodeId, (text) =>
    EARLIER[nodeId].reduce((result, [now, before]) => {
      expect(result).toContain(now);
      return result.replace(now, before);
    }, text),
  );
}

describe("Workflow Management Flow runs started before the authoring rules changed", () => {
  test.each(Object.keys(EARLIER))(
    "a run paused on %s under the earlier wording is diagnosed, recovered and continues",
    async (nodeId) => {
      const repository = new InMemoryRepository();
      const executor = executorFor(repository);
      const present = (id: string) =>
        executor.executeStep(id, undefined, undefined, {
          userId: USER_ID,
          createPresentation: true,
        });

      // A run on the earlier flow, standing on the changed step with a presented attempt. It is
      // placed there the supported way: the first step is reworded, and the run recovered onto it.
      const before = earlier(nodeId);
      await repository.saveWorkflow(before, USER_ID);
      const executionId = await executor.startWorkflow(before, undefined, USER_ID, "Release list");
      await present(executionId);
      await repository.saveWorkflow(
        withDirective(before, "get-action-type", (text) => `${text} `),
        USER_ID,
      );
      const placed = await recoverContinuation(
        repository,
        (await repository.getExecution(executionId))!,
        nodeId,
        RUN_VALUES,
        present,
      );
      expect(placed).toEqual(expect.objectContaining({ outcome: "recovered" }));

      // The flow is updated to the current wording (the reworded first step stays as it was).
      await repository.saveWorkflow(
        withDirective(current, "get-action-type", (text) => `${text} `),
        USER_ID,
      );
      const paused = (await repository.getExecution(executionId))!;
      const diagnosis = await diagnoseContinuation(
        repository,
        paused,
        await repository.getCurrentExecutionAttempt(executionId, USER_ID),
      );
      expect(diagnosis.continuable).toBe(false);
      expect(
        diagnosis.causes.filter((cause) => cause.blocks).map((cause) => JSON.stringify(cause)),
      ).toEqual([expect.stringContaining("node.directive")]);

      const recovered = await recoverContinuation(repository, paused, nodeId, RUN_VALUES, present);
      expect(recovered.outcome).toBe("recovered");
      if (recovered.outcome !== "recovered") return;
      expect(recovered.result.presentation).toContain(EARLIER[nodeId][0][0]);

      // The next call is an ordinary step on the attempt recovery presented.
      const attemptId = recovered.result.presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1];
      await executor.executeStep(executionId, ANSWERS[nodeId], undefined, {
        userId: USER_ID,
        attemptId,
      });
      const moved = (await repository.getExecution(executionId))!;
      expect(moved.currentNodeId).not.toBe(nodeId);
      expect(moved.visits?.filter((visit) => visit.nodeId === nodeId).at(-1)?.exitKey).not.toBe(
        null,
      );
    },
  );

  test("a run paused on the workspace bootstrap is untouched by the new progress reference", async () => {
    // The reference is a registry value a run copies when it starts, and the bootstrap step does
    // not declare it as an input: its wording is not part of what the paused step is bound to.
    const repository = new InMemoryRepository();
    const executor = executorFor(repository);
    const before: WorkflowGraph = {
      ...current,
      variableRegistry: {
        ...current.variableRegistry,
        workflow_reference_progress: {
          ...current.variableRegistry!.workflow_reference_progress,
          default: "# Moira workflow progress reference (earlier wording)",
        },
      },
    };
    await repository.saveWorkflow(before, USER_ID);
    const executionId = await executor.startWorkflow(before, undefined, USER_ID, "Release list");
    const first = await executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    await executor.executeStep(executionId, WORKSPACE, undefined, {
      userId: USER_ID,
      attemptId: first.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1],
    });
    const paused = (await repository.getExecution(executionId))!;
    expect(paused.currentNodeId).toBe("materialize-workspace-bootstrap");

    await repository.saveWorkflow(current, USER_ID);
    const attempt = await repository.getCurrentExecutionAttempt(executionId, USER_ID);
    const diagnosis = await diagnoseContinuation(repository, paused, attempt);
    expect({ continuable: diagnosis.continuable, causes: diagnosis.causes }).toEqual({
      continuable: true,
      causes: [],
    });
    // And the attempt it was presented before the update still moves it on.
    await executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      attemptId: attempt!.attemptId,
    });
    expect((await repository.getExecution(executionId))!.currentNodeId).not.toBe(
      "materialize-workspace-bootstrap",
    );
  });
});
