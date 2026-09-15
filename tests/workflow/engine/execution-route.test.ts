/**
 * The route of a real run: bundled flows driven through the stateful executor, their visit log
 * and the run projection asserted on what the engine actually recorded.
 */

import { describe, expect, test } from "@jest/globals";
import { findCatalogEntryBySlug, metadataRevision } from "@mcp-moira/shared";
import {
  InMemoryRepository,
  adjustmentVisit,
  MaterializeHandler,
  UniversalGraphExecutor,
  projectExecutionRun,
  renderExecutionProgressImage,
  TELEPORT_EXIT_KEY,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";

const USER = "route-user";

function bundled(slug: string): WorkflowGraph {
  return catalogGraph(slug);
}

async function runner(workflow: WorkflowGraph) {
  const repository = new InMemoryRepository();
  await repository.saveWorkflow(workflow, USER, "public");
  const executor = new UniversalGraphExecutor(repository);
  const graphEngine = (
    executor as unknown as { graphEngine: { nodeHandlers: Map<string, MaterializeHandler> } }
  ).graphEngine;
  graphEngine.nodeHandlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "route-test-token" },
      () => "https://moira.example",
    ),
  );
  const executionId = await executor.startWorkflow(workflow, undefined, USER);
  const step = async (input?: unknown, teleportTo?: string) =>
    executor.executeStep(executionId, input, teleportTo);
  const execution = async (): Promise<WorkflowExecution> =>
    (await repository.getExecution(executionId))!;
  const project = async () => projectExecutionRun(workflow, await execution())!;
  return { repository, executor, executionId, step, execution, project };
}

const workspace = "./moira-ws/quick-task-0000aaaa-0000-4000-8000-000000000000";
const quickTaskInputs = {
  "get-task": (mode: "interactive" | "autonomous") => ({
    task_file: `${workspace}/task.md`,
    execution_file: `${workspace}/execution.md`,
    operating_mode: mode,
    progress_scope_outcome: "Task contract captured",
  }),
  "create-plan": {
    current_plan_file: `${workspace}/plans/001/plan.md`,
    total_steps: 5,
    progress_plan_outcome: "Five-unit plan ready for review",
  },
  review: (issues: number, iteration: number) => ({
    review_file: `${workspace}/plans/00${iteration}/review.md`,
    issues_count: issues,
    progress_plan_outcome: issues ? "Plan review found a blocking issue" : "Plan reviewed clean",
  }),
  "repair-plan": {
    current_plan_file: `${workspace}/plans/002/plan.md`,
    total_steps: 5,
    progress_plan_outcome: "Corrected plan replaced the rejected revision",
  },
  "present-plan": {
    approval: "yes",
    decision_file: `${workspace}/plans/002/decision.md`,
    progress_plan_outcome: "Plan approved",
  },
  "execute-step": (unit: number) => ({ progress_execution_outcome: `Unit ${unit} done` }),
};

describe("recorded route of real runs", () => {
  test("Quick Task to the third of five units after one plan repair", async () => {
    const workflow = bundled("quick-task");
    const run = await runner(workflow);
    await run.step();
    // Invalid input pauses on the same node again: the open visit stays as it is.
    await run.step({ task_file: "nope" });
    expect((await run.execution()).visits!.map((visit) => [visit.nodeId, visit.exitKey])).toEqual([
      ["start", "default"],
      ["get-task", null],
    ]);
    await run.step(quickTaskInputs["get-task"]("interactive"));
    await run.step(quickTaskInputs["create-plan"]);
    await run.step(quickTaskInputs.review(1, 1));
    await run.step(quickTaskInputs["repair-plan"]);
    await run.step(quickTaskInputs.review(0, 2));
    await run.step(quickTaskInputs["present-plan"]);
    await run.step(quickTaskInputs["execute-step"](1));
    await run.step(quickTaskInputs["execute-step"](2));

    const execution = await run.execution();
    expect(execution.currentNodeId).toBe("execute-step");
    expect(execution.visits!.map((visit) => `${visit.nodeId}:${visit.exitKey}`)).toEqual([
      "start:default",
      "get-task:success",
      "create-plan:success",
      "plan-review:success",
      "check-plan-review-clean:false",
      "repair-plan:success",
      "plan-review:success",
      "check-plan-review-clean:true",
      "route-operating-mode-plan-approval:false",
      "present-plan:success",
      "check-plan-approved:true",
      "check-steps-remaining:true",
      "execute-step:success",
      "close-completed-step:default",
      "check-steps-remaining:true",
      "execute-step:success",
      "close-completed-step:default",
      "check-steps-remaining:true",
      "execute-step:null",
    ]);
    expect(execution.visits!.at(-1)).toMatchObject({ waited: true, changes: {} });
    expect(execution.visits![12].changes).toEqual({
      "execute-step.progress_execution_outcome": "Unit 1 done",
      progress_execution_outcome: "Unit 1 done",
    });
    // An expression writes its global by name and into its node-local scope.
    expect(execution.visits![13].changes).toEqual({
      current_step: 1,
      "close-completed-step.current_step": 1,
    });
    // The route log is revisioned state: every step (the rejected input included) bumped the
    // revision and the log grew only with real transitions.
    expect(execution.revision).toBe(10);

    const projected = await run.project();
    expect(projected.routeRecorded).toBe(true);
    expect(projected.nodes.map((node) => [node.id, node.status, node.iterations])).toEqual([
      ["scope", "done", 1],
      ["plan", "done", 1],
      ["plan-review", "repeated", 2],
      ["plan-approval", "done", 1],
      ["execute", "waiting", 3],
      ["verify", "pending", 0],
      ["deliver", "pending", 0],
    ]);
    expect(projected.nodes[4]).toMatchObject({
      currentNodeId: "execute-step",
      focusNodeId: "execute-step",
      state: "current",
    });
    expect(projected.activeNodeId).toBe("execute");
    // Loops: the second plan review after the repair, and every pass of the execution cycle after
    // the first.
    expect(projected.route.filter((entry) => entry.loop).map((entry) => entry.seq)).toEqual([
      6, 7, 14, 15, 16, 17, 18,
    ]);
    const currentStep = projected.variables.find((variable) => variable.name === "current_step")!;
    expect(currentStep.current).toBe(2);
    expect(currentStep.history.map((change) => [change.nodeId, change.value])).toEqual([
      ["start", 0],
      ["close-completed-step", 1],
      ["close-completed-step", 2],
    ]);

    // The image is rendered from the same projection and shows the repeated block.
    const image = await renderExecutionProgressImage(workflow, execution, { viewportWidth: 720 });
    expect(image?.buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image?.executionRevision).toBe(execution.revision);
  });

  test("a wait answered from outside the flow continues the route and is recorded with its actor", async () => {
    const run = await runner(bundled("quick-task"));
    await run.step();
    const person = { role: "user" as const, userId: "person" };
    // A rejected answer changes nothing: the run still waits on the same node with no adjustment.
    await run.executor.executeStep(run.executionId, { task_file: "nope" }, undefined, {
      userId: USER,
      answeredBy: person,
    });
    let execution = await run.execution();
    expect(execution.waitingForInputNodeId).toBe("get-task");
    expect(execution.visits!.map((visit) => visit.nodeId)).toEqual(["start", "get-task"]);

    await run.executor.executeStep(
      run.executionId,
      quickTaskInputs["get-task"]("autonomous"),
      undefined,
      { userId: USER, answeredBy: person },
    );
    execution = await run.execution();
    expect(execution.waitingForInputNodeId).toBe("create-plan");
    expect(
      execution.visits!.map((visit) => [
        visit.nodeId,
        visit.exitKey,
        visit.adjusted ?? false,
        visit.actor ?? null,
      ]),
    ).toEqual([
      ["start", "default", false, null],
      ["get-task", "success", false, null],
      ["get-task", null, true, person],
      ["create-plan", null, false, null],
    ]);
    expect(execution.visits![2].changes).toMatchObject({ operating_mode: "autonomous" });

    const projected = await run.project();
    expect(projected.nodes.map((node) => [node.id, node.status])).toEqual([
      ["scope", "done"],
      ["plan", "waiting"],
      ["plan-review", "pending"],
      ["plan-approval", "pending"],
      ["execute", "pending"],
      ["verify", "pending"],
      ["deliver", "pending"],
    ]);
    expect(projected.route[2]).toMatchObject({ adjusted: true, actor: person });
    const mode = projected.variables.find((variable) => variable.name === "operating_mode")!;
    expect(mode.adjusted).toBe(true);
    expect(mode.history.map((change) => [change.nodeId, change.adjusted ?? false])).toEqual([
      ["get-task", false],
      ["get-task", true],
    ]);
  });

  test("an autonomous Quick Task run skips plan approval instead of reporting it done", async () => {
    const run = await runner(bundled("quick-task"));
    await run.step();
    await run.step(quickTaskInputs["get-task"]("autonomous"));
    await run.step(quickTaskInputs["create-plan"]);
    // A value set from outside while the review waits is an adjustment on that wait; the resume
    // still closes the wait's own visit, so the block is done once, not repeated.
    const waiting = await run.execution();
    await run.repository.updateExecutionContext(
      run.executionId,
      { variables: { total_steps: 5 } },
      waiting.revision,
      metadataRevision(waiting.globalContext),
      adjustmentVisit(waiting, { total_steps: 5 }, { role: "user", userId: USER }),
    );
    await run.step(quickTaskInputs.review(0, 1));
    const adjusted = await run.execution();
    expect(
      adjusted
        .visits!.filter((visit) => visit.nodeId === "plan-review")
        .map((visit) => [visit.exitKey, visit.adjusted ?? false]),
    ).toEqual([
      ["success", false],
      [null, true],
    ]);

    const projected = await run.project();
    expect(projected.nodes.map((node) => [node.id, node.status])).toEqual([
      ["scope", "done"],
      ["plan", "done"],
      ["plan-review", "done"],
      ["plan-approval", "skipped"],
      ["execute", "waiting"],
      ["verify", "pending"],
      ["deliver", "pending"],
    ]);
    expect(projected.nodes[2].iterations).toBe(1);
    expect(
      projected.route
        .filter((entry) => entry.nodeId === "plan-review")
        .map((entry) => entry.loop ?? false),
    ).toEqual([false, false]);
    const image = await renderExecutionProgressImage(bundled("quick-task"), await run.execution());
    expect(image).not.toBeNull();
  });

  test("a Software Development Flow run stopped at the health check reports nothing later as done", async () => {
    const workflow = bundled("software-development-flow");
    const run = await runner(workflow);
    await run.step();
    await run.step({
      workspace_path: "./moira-ws/sdf-route",
      operating_mode: "autonomous",
      visual_validation_preference: "disabled",
      progress_intake_outcome: "Task captured",
    });
    await run.step();
    await run.step({ health_outcome: "external_blocker", progress_intake_outcome: "Blocked" });
    // Ending the whole run is an explicit decision of its own in this flow; aborting a step is not
    // one of its values.
    await run.step({ blocker_decision: "end_workflow", progress_intake_outcome: "Ended" });

    const execution = await run.execution();
    expect(execution.status).toBe("completed");
    expect(execution.visits!.at(-1)?.nodeId).toBe("end-aborted");
    const projected = await run.project();
    const byId = Object.fromEntries(projected.nodes.map((node) => [node.id, node.status]));
    expect(byId.intake).toBe("done");
    expect(byId.health).toBe("done");
    expect(byId.stopped).toBe("done");
    for (const id of Object.keys(byId).filter(
      (k) => !["intake", "health", "stopped"].includes(k),
    )) {
      expect(["pending", "skipped"]).toContain(byId[id]);
    }
    expect(projected.activeNodeId).toBeNull();
  });

  test("a completed Todo List run with a teleport records the teleport exit and ends at the end node", async () => {
    const workflow = bundled("todo-list");
    const run = await runner(workflow);
    const tasks = [
      { action: "Create the file", expected_result: "The file exists" },
      { action: "Run the tests", expected_result: "Tests pass" },
    ];
    await run.step();
    await run.step();
    await run.step({ tasks, progress_checklist_outcome: "2 ordered tasks ready" });
    await run.step({ evidence: "File created", progress_execution_outcome: "File created" });
    await run.step(undefined, "teleport-revise-tasks");
    await run.step({
      tasks: [tasks[0]],
      resume_from_task: 2,
      progress_checklist_outcome: "Completed prefix retained",
      progress_execution_outcome: "File created",
    });

    const execution = await run.execution();
    expect(execution.status).toBe("completed");
    const route = execution.visits!.map((visit) => `${visit.nodeId}:${visit.exitKey}`);
    expect(route).toContain(`execute-task:${TELEPORT_EXIT_KEY}`);
    expect(route.at(-1)).toBe("end:null");
    const projected = await run.project();
    // The checklist cursor was checked three times (two tasks, then the revised tail); one task was
    // executed and the teleported revision is the work block's second pass.
    expect(projected.nodes.map((node) => [node.id, node.status, node.iterations])).toEqual([
      ["checklist", "done", 1],
      ["prepare", "repeated", 3],
      ["work", "repeated", 2],
    ]);
    expect(projected.route.find((entry) => entry.exitKey === TELEPORT_EXIT_KEY)?.blockId).toBe(
      "work",
    );
  });

  test("an execution without a recorded route infers nothing", async () => {
    const workflow = bundled("quick-task");
    const run = await runner(workflow);
    const fresh = await run.execution();
    fresh.currentNodeId = "execute-step";
    fresh.waitingForInputNodeId = "execute-step";
    await run.repository.saveExecution(fresh);

    const projected = await run.project();
    expect(projected.routeRecorded).toBe(false);
    expect(projected.nodes.map((node) => [node.id, node.status])).toEqual([
      ["scope", "pending"],
      ["plan", "pending"],
      ["plan-review", "pending"],
      ["plan-approval", "pending"],
      ["execute", "waiting"],
      ["verify", "pending"],
      ["deliver", "pending"],
    ]);
  });
});
