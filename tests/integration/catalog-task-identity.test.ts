import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDatabase, getMcpTextService, getWorkflowService, user } from "@mcp-moira/shared";
import {
  DatabaseRepository,
  MaterializeHandler,
  diagnoseContinuation,
  recoverContinuation,
  isMaterializeNode,
  renderMaterializeBasePath,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { catalogGraph } from "../helpers/catalog-graphs.js";

const USER_ID = "catalog-task-identity-user";
const callerWorkspaces: string[] = [];
const SLUG = "workflow-management-flow";
const INTAKE = {
  action_type: "create",
  operating_mode: "autonomous",
  workspace_path: "./moira-ws/task-identity-test",
  progress_source_outcome: "Create a release checklist workflow",
};

function currentGraph(slug = SLUG): WorkflowGraph {
  return catalogGraph(slug, { baseDir: process.env.TASK_IDENTITY_CATALOG_DIR });
}

function earlierGraph(slug = SLUG): WorkflowGraph {
  return JSON.parse(
    readFileSync(`tests/fixtures/task-identity-earlier/${slug}.json`, "utf8"),
  ) as WorkflowGraph;
}

function attemptId(presentation: string): string {
  const match = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i);
  if (!match) throw new Error("The ordinary step was not presented");
  return match[1];
}

function record(root: string, relativePath: string, content: string) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  expect(readFileSync(path, "utf8")).toBe(content);
  return path;
}

function retained(files: Map<string, string>) {
  for (const [path, content] of files) expect(readFileSync(path, "utf8")).toBe(content);
}

function snapshot(paths: string[]) {
  return new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
}

function session(params: Parameters<typeof getSessionInfo>[0]) {
  return requestContext.run({ userId: USER_ID }, () => getSessionInfo(params));
}

async function inspect(executionId: string) {
  const result = await session({ action: "execution_context", executionId });
  expect(result.success).toBe(true);
  return result.data as {
    revision: number;
    note: string;
    context: unknown;
    metadataRevisions: { context: string; parent: string; reminders: string; taskIdentity: string };
    taskIdentity: { title: string; changedAt: number; changeId: string } | null;
  };
}

async function rename(executionId: string, taskTitle: string) {
  const before = await inspect(executionId);
  const result = await session({
    action: "update-task-title",
    executionId,
    taskTitle,
    expectedRevision: before.revision,
    expectedTaskIdentityRevision: before.metadataRevisions.taskIdentity,
  });
  expect(result.success).toBe(true);
  const after = await inspect(executionId);
  expect(after.taskIdentity?.title).toBe(taskTitle);
  expect(after.taskIdentity?.changeId).not.toBe(before.taskIdentity?.changeId);
  expect(after.metadataRevisions.taskIdentity).not.toBe(before.metadataRevisions.taskIdentity);
  expect(after.revision).toBe(before.revision);
  expect(after.context).toEqual(before.context);
  expect(after.note).toBe(before.note);
  for (const key of ["context", "parent", "reminders"] as const) {
    expect(after.metadataRevisions[key]).toBe(before.metadataRevisions[key]);
  }
  const progress = await session({ action: "progress", executionId });
  expect(progress.success).toBe(true);
  expect(progress.data).toMatchObject({
    taskTitle,
    taskIdentity: after.taskIdentity,
    taskIdentityRevision: after.metadataRevisions.taskIdentity,
    executionRevision: before.revision,
  });
  return after;
}

async function start(graph: WorkflowGraph) {
  const repository = new DatabaseRepository();
  const saved = await getWorkflowService().save({
    graph: { ...graph, id: randomUUID() },
    userId: USER_ID,
    visibility: "private",
  });
  const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
  const engine = MCPEngine.getInstance(repository);
  const internal = engine.executor as unknown as {
    graphEngine: { nodeHandlers: Map<string, MaterializeHandler> };
  };
  internal.graphEngine.nodeHandlers.set(
    "materialize",
    new MaterializeHandler(undefined, () => "https://moira.example"),
  );
  const executionId = await engine.executor.startWorkflow(
    stored,
    undefined,
    USER_ID,
    "An arbitrary deployment observation, unrelated to the task title",
  );
  const present = (id: string) =>
    engine.executor.executeStep(id, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
  const presentation = await present(executionId);
  const callerRoot = mkdtempSync(
    join(process.cwd(), "agent_temp_files_local/task-identity-caller-"),
  );
  callerWorkspaces.push(callerRoot);
  async function deliverFiles() {
    const execution = (await repository.getExecution(executionId))!;
    const graph = (await repository.getWorkflowGraph(execution.workflowId, USER_ID))!;
    const node = graph.nodes.find((candidate) => candidate.id === execution.currentNodeId);
    if (!node || !isMaterializeNode(node))
      throw new Error("Delivery must use a current materialize node");
    const basePath = await renderMaterializeBasePath(
      node,
      graph.variableRegistry,
      execution.globalContext,
    );
    // The documented fallback uses the real grant and delivery service without an HTTP listener.
    const result = await session({ action: "materialize", executionId });
    expect(result.success).toBe(true);
    const { files } = result.data as { files: Array<{ path: string; content: string }> };
    const written = new Map<string, string>();
    for (const file of files) {
      const path = join(callerRoot, basePath, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, "utf8");
      expect(readFileSync(path, "utf8")).toBe(file.content);
      written.set(file.path, path);
    }
    return written;
  }
  const step = (input?: Record<string, unknown>, teleportTo?: string) =>
    engine.executor.executeStep(executionId, input, teleportTo, {
      userId: USER_ID,
      attemptId: attemptIdOfCurrent(),
    });
  let currentPresentation = presentation;
  function attemptIdOfCurrent() {
    return attemptId(currentPresentation);
  }
  async function advance(input?: Record<string, unknown>, teleportTo?: string) {
    currentPresentation = await step(input, teleportTo);
    return currentPresentation;
  }
  return {
    repository,
    engine,
    stored,
    executionId,
    presentation,
    present,
    advance,
    deliverFiles,
    callerRoot,
  };
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await getDatabase()
    .insert(user)
    .values({
      id: USER_ID,
      email: `${USER_ID}@example.test`,
      handle: USER_ID,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
});

describe("quick-task native naming guidance and complete earlier-definition compatibility", () => {
  function paths(executionId: string) {
    const root = `./moira-ws/quick-task-${executionId}`;
    return {
      task_file: `${root}/task.md`,
      execution_file: `${root}/execution.md`,
      plan: (iteration: number) => `${root}/plans/${iteration}/plan.md`,
      review: (iteration: number) => `${root}/plans/${iteration}/review.md`,
    };
  }

  function intake(executionId: string) {
    const files = paths(executionId);
    return {
      task_file: files.task_file,
      execution_file: files.execution_file,
      operating_mode: "autonomous",
      progress_scope_outcome: "Prepare an accurate release announcement",
    };
  }

  test("delivers native guidance with inherited reminder, names intake and actual replan without repeating completed units", async () => {
    const globalReminder = await getMcpTextService().getSystemReminder();
    expect(globalReminder.length).toBeGreaterThan(0);
    const run = await start(currentGraph("quick-task"));
    const files = paths(run.executionId);
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe("get-task");
    expect(run.presentation).toContain("update-task-title");
    expect(run.presentation).toContain("metadataRevisions.taskIdentity");
    expect(run.presentation).not.toContain("{{execution_task_naming_contract}}");
    expect(run.presentation).toContain(globalReminder);
    expect(existsSync(join(run.callerRoot, files.task_file))).toBe(false);
    const taskPath = record(
      run.callerRoot,
      files.task_file,
      "Prepare a release v1.0 announcement describing CSV export. No publication. Scope extensions require explicit later authorization.\n",
    );
    const evidencePath = record(run.callerRoot, files.execution_file, "");
    const intakeFiles = new Map([
      [taskPath, readFileSync(taskPath, "utf8")],
      [evidencePath, ""],
    ]);
    const intakeAttempt = await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID);
    await rename(run.executionId, "Prepare a release announcement");
    retained(intakeFiles);
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(intakeAttempt?.attemptId);
    await run.advance(intake(run.executionId));
    const units = [{ title: "Draft the announcement" }, { title: "Verify release facts" }];
    const planPath = record(
      run.callerRoot,
      files.plan(1),
      "1. Draft a v1.0 CSV export release announcement; read the result for the version and feature.\n2. Verify release facts against the captured task; record the verification.\n",
    );
    await run.advance({
      current_plan_file: files.plan(1),
      plan_steps: units,
      progress_plan_outcome: "Draft and verify the release announcement",
    });
    const reviewPath = record(
      run.callerRoot,
      files.review(1),
      "Independent review: both units cover the captured release task, preserve the no-publication boundary and specify direct verification. No blocking findings.\n",
    );
    await run.advance({
      review_file: files.review(1),
      issues_count: 0,
      progress_plan_outcome: "Two release announcement units independently reviewed clean",
    });
    const resultPath = record(
      run.callerRoot,
      dirname(files.task_file) + "/announcement.md",
      "Release v1.0: users can export their data as CSV.\n",
    );
    expect(readFileSync(resultPath, "utf8")).toContain("v1.0");
    expect(readFileSync(resultPath, "utf8")).toContain("CSV");
    const completedEvidence =
      "0: Release v1.0 announcement describes CSV export; direct result-file reading confirms its version and feature.\n";
    expect(completedEvidence.length).toBeLessThanOrEqual(500);
    record(run.callerRoot, files.execution_file, completedEvidence);
    await run.advance({
      progress_execution_outcome: "Release announcement drafted and directly verified",
    });
    const completedFiles = new Map(
      [taskPath, evidencePath, planPath, reviewPath, resultPath].map((path) => [
        path,
        readFileSync(path, "utf8"),
      ]),
    );
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("execute-step");
    expect(paused.globalContext.variables.current_step).toBe(1);
    const replan = await run.advance(undefined, "teleport-replan");
    expect(replan).toContain("update-task-title");
    expect(replan).toContain("If this authorized revision changes the actual task scope");
    expect(replan).toContain(globalReminder);
    const replanAttempt = await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID);
    const named = await rename(run.executionId, "Prepare release and migration announcements");
    retained(completedFiles);
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(replanAttempt?.attemptId);
    await run.advance({
      progress_plan_outcome:
        "Authorized migration announcement added; the completed draft remains valid",
    });
    record(
      run.callerRoot,
      files.plan(2).replace("/plan.md", "/change.md"),
      "Explicit revised request: add migration instructions alongside the release announcement. The completed first draft and original no-publication authority remain valid.\n",
    );
    record(
      run.callerRoot,
      files.plan(2),
      "1. Retain the completed v1.0 CSV export release draft.\n2. Verify release facts by direct comparison.\n3. Add the explicitly requested migration instructions and verify their steps.\n",
    );
    await run.advance({
      current_plan_file: files.plan(2),
      plan_steps: [...units, { title: "Add migration instructions" }],
      progress_plan_outcome: "Three-unit revised plan preserves the completed release draft",
    });
    record(
      run.callerRoot,
      files.review(2),
      "Independent review: the authorized migration extension is covered, completed position zero and its evidence remain valid, and publication remains excluded. No blocking findings.\n",
    );
    await run.advance({
      review_file: files.review(2),
      issues_count: 0,
      progress_plan_outcome: "Revised release and migration announcement plan reviewed clean",
    });
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("execute-step");
    expect(continued.globalContext.variables.current_step).toBe(1);
    expect((continued.globalContext.variables.plan_steps as unknown[])[0]).toEqual(units[0]);
    expect(continued.globalContext.variables["get-task"]).toMatchObject({
      task_file: files.task_file,
      execution_file: files.execution_file,
    });
    expect(continued.taskIdentity).toEqual(named.taskIdentity);
    expect(
      continued.visits?.filter((visit) => visit.nodeId === "close-completed-step"),
    ).toHaveLength(1);
    retained(completedFiles);
    expect(readFileSync(evidencePath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("public recovery of a real4.12 midrun retains physical task, immutable records and completed evidence before ordinary continuation", async () => {
    const run = await start(earlierGraph("quick-task"));
    const files = paths(run.executionId);
    const taskPath = record(
      run.callerRoot,
      files.task_file,
      "Prepare the v1.0 CSV export release announcement and independently verify its release facts. No publication.\n",
    );
    const evidencePath = record(run.callerRoot, files.execution_file, "");
    await rename(run.executionId, "Prepare a release announcement");
    await run.advance({
      ...intake(run.executionId),
      execution_note: "An arbitrary old-run observation",
    });
    const units = [{ title: "Draft the announcement" }, { title: "Verify release facts" }];
    const planPath = record(
      run.callerRoot,
      files.plan(1),
      "1. Draft the v1.0 CSV export release announcement and read its version/feature.\n2. Independently verify the release facts against the captured task and record the observation.\n",
    );
    await run.advance({
      current_plan_file: files.plan(1),
      plan_steps: units,
      progress_plan_outcome: "Two release announcement units ready for review",
    });
    const reviewPath = record(
      run.callerRoot,
      files.review(1),
      "Independent review: the complete plan covers both captured outcomes with direct verification and no publication. No blocking findings.\n",
    );
    await run.advance({
      review_file: files.review(1),
      issues_count: 0,
      progress_plan_outcome: "Release announcement plan independently reviewed clean",
    });
    const resultPath = record(
      run.callerRoot,
      dirname(files.task_file) + "/announcement.md",
      "Release v1.0: users can export their data as CSV.\n",
    );
    expect(readFileSync(resultPath, "utf8")).toBe(
      "Release v1.0: users can export their data as CSV.\n",
    );
    const firstEvidence =
      "0: Release v1.0 CSV export announcement produced; direct file reading confirms the version and feature.\n";
    expect(firstEvidence.length).toBeLessThanOrEqual(500);
    record(run.callerRoot, files.execution_file, firstEvidence);
    await run.advance({
      progress_execution_outcome: "Announcement draft produced and directly verified",
    });
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("execute-step");
    expect(paused.globalContext.variables.current_step).toBe(1);
    expect(paused.globalContext.variables.execution_task_naming_contract).toBeUndefined();
    const priorFiles = new Map(
      [taskPath, evidencePath, planPath, reviewPath, resultPath].map((path) => [
        path,
        readFileSync(path, "utf8"),
      ]),
    );
    const current = currentGraph("quick-task");
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const diagnosis = await session({ action: "diagnose", executionId: run.executionId });
    expect(diagnosis.success).toBe(true);
    expect(diagnosis.data).toMatchObject({ continuable: false });
    const recovery = await session({
      action: "recover",
      executionId: run.executionId,
      nodeId: "execute-step",
      variableValues: {
        execution_task_naming_contract:
          current.variableRegistry!.execution_task_naming_contract.default,
      },
    });
    expect(recovery.success).toBe(true);
    const recovered = recovery.data as {
      executionId: string;
      nodeId: string;
      presentation: string;
    };
    expect(recovered).toMatchObject({ executionId: paused.executionId, nodeId: "execute-step" });
    expect(recovered.presentation).toContain("update-task-title");
    expect(recovered.presentation).toContain("expectedTaskIdentityRevision");
    expect(recovered.presentation).not.toContain("{{execution_task_naming_contract}}");
    const restored = (await run.repository.getExecution(run.executionId))!;
    expect(restored.taskIdentity).toEqual(paused.taskIdentity);
    expect(restored.note).toBe(paused.note);
    expect(restored.globalContext.variables.current_step).toBe(1);
    expect(restored.globalContext.variables.plan_steps).toEqual(units);
    expect(restored.globalContext.variables["get-task"]).toEqual(
      paused.globalContext.variables["get-task"],
    );
    retained(priorFiles);
    const verificationPath = record(
      run.callerRoot,
      dirname(files.task_file) + "/release-facts.md",
      "Direct comparison: the announcement version v1.0 and CSV export feature match the captured task.\n",
    );
    expect(readFileSync(verificationPath, "utf8")).toContain("match the captured task");
    const secondEvidence =
      "1: Direct comparison of announcement and captured task confirms the v1.0 release and CSV export facts.\n";
    expect(secondEvidence.length).toBeLessThanOrEqual(500);
    record(run.callerRoot, files.execution_file, firstEvidence + secondEvidence);
    const presentation = await run.engine.executor.executeStep(
      run.executionId,
      {
        progress_execution_outcome:
          "Release announcement facts directly verified against the captured task",
      },
      undefined,
      { userId: USER_ID, attemptId: attemptId(recovered.presentation) },
    );
    expect(presentation).toContain("update-task-title");
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("final-review");
    expect(continued.globalContext.variables.current_step).toBe(2);
    expect(continued.taskIdentity).toEqual(paused.taskIdentity);
    expect(continued.note).toBe(paused.note);
    expect(
      continued.visits?.filter((visit) => visit.nodeId === "close-completed-step"),
    ).toHaveLength(2);
    priorFiles.delete(evidencePath); // The caller legitimately appends the newly completed second unit.
    retained(priorFiles);
    expect(readFileSync(evidencePath, "utf8")).toBe(firstEvidence + secondEvidence);
    expect(readFileSync(evidencePath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("recovers the complete4.12 intake with actual expanded guidance and ordinarily continues the same execution", async () => {
    const old = earlierGraph("quick-task");
    expect(old.metadata.version).toBe("4.12.0");
    const run = await start(old);
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.globalContext.variables.execution_task_naming_contract).toBeUndefined();
    const current = currentGraph("quick-task");
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const diagnosis = await session({ action: "diagnose", executionId: run.executionId });
    expect(diagnosis.success).toBe(true);
    expect(diagnosis.data).toMatchObject({ continuable: false });
    const recovered = await session({
      action: "recover",
      executionId: run.executionId,
      nodeId: "get-task",
      variableValues: {
        execution_task_naming_contract:
          current.variableRegistry!.execution_task_naming_contract.default,
      },
    });
    expect(recovered.success).toBe(true);
    const result = recovered.data as { executionId: string; nodeId: string; presentation: string };
    expect(result).toMatchObject({ executionId: paused.executionId, nodeId: "get-task" });
    expect(result.presentation).toContain("update-task-title");
    expect(result.presentation).toContain("expectedTaskIdentityRevision");
    expect(result.presentation).not.toContain("{{execution_task_naming_contract}}");
    const restored = (await run.repository.getExecution(run.executionId))!;
    expect(restored.note).toBe(paused.note);
    expect(restored.globalContext.variables.current_step).toBe(
      paused.globalContext.variables.current_step,
    );
    await rename(run.executionId, "Prepare a release announcement");
    const presentation = await run.engine.executor.executeStep(
      run.executionId,
      intake(run.executionId),
      undefined,
      {
        userId: USER_ID,
        attemptId: attemptId(result.presentation),
      },
    );
    expect(presentation).toContain("update-task-title");
    expect(presentation).not.toContain("{{execution_task_naming_contract}}");
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("create-plan");
    expect(continued.note).toBe(paused.note);
    expect(continued.taskIdentity?.title).toBe("Prepare a release announcement");
  });
});
afterEach(() => {
  MCPEngine.resetInstance();
  for (const root of callerWorkspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow-management-flow persisted naming and complete earlier-definition compatibility", () => {
  test("names the actual first intake before materialization, then renames at revised requirements without consuming either step", async () => {
    const run = await start(currentGraph());
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "get-action-type",
    );
    // This is the delivered intake instruction, before any guide file can exist.
    expect(run.presentation).toContain("update-task-title");
    expect(run.presentation).toContain("expectedTaskIdentityRevision");
    expect(run.presentation).not.toContain(
      "Read `./moira-ws/task-identity-test/reference/progress.md`",
    );
    const firstAttempt = await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID);
    const named = await rename(run.executionId, "Create a release checklist workflow");
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(firstAttempt?.attemptId);
    await run.advance(INTAKE);
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "materialize-workspace-bootstrap",
    );
    const delivered = await run.deliverFiles();
    expect(readFileSync(delivered.get("reference/progress.md")!, "utf8")).toContain(
      "update-task-title",
    );
    await run.advance();
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "gather-workflow-requirements",
    );
    const requirementsAttempt = await run.repository.getCurrentExecutionAttempt(
      run.executionId,
      USER_ID,
    );
    const renamed = await rename(
      run.executionId,
      "Create a release checklist with approval requirements",
    );
    expect(renamed.taskIdentity?.changeId).not.toBe(named.taskIdentity?.changeId);
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(requirementsAttempt?.attemptId);
    await run.advance({
      complexity_tier: "complex",
      progress_requirements_outcome: "Scope revised to include approval requirements",
    });
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "design-workflow-structure",
    );
    expect((await inspect(run.executionId)).taskIdentity).toEqual(renamed.taskIdentity);
  });

  test("diagnoses the real 6.18 intake change, recovers and ordinarily continues the same execution", async () => {
    const earlier = earlierGraph();
    expect(earlier.metadata.version).toBe("6.18.0");
    const run = await start(earlier);
    await run.repository.saveWorkflow({ ...currentGraph(), id: run.stored.id }, USER_ID);
    const paused = (await run.repository.getExecution(run.executionId))!;
    const diagnosis = await diagnoseContinuation(
      run.repository,
      paused,
      await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID),
    );
    expect(diagnosis.continuable).toBe(false);
    expect(
      diagnosis.causes.filter((cause) => cause.blocks).map((cause) => JSON.stringify(cause)),
    ).toEqual(expect.arrayContaining([expect.stringContaining("node.directive")]));
    const recovered = await recoverContinuation(
      run.repository,
      paused,
      "get-action-type",
      {},
      run.present,
    );
    expect(recovered.outcome).toBe("recovered");
    if (recovered.outcome !== "recovered") throw new Error("Recovery failed");
    expect(recovered.result.presentation).toContain("update-task-title");
    await rename(run.executionId, "Create a release checklist workflow");
    await run.engine.executor.executeStep(run.executionId, INTAKE, undefined, {
      userId: USER_ID,
      attemptId: attemptId(recovered.result.presentation),
    });
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("materialize-workspace-bootstrap");
  });

  test("an unchanged bootstrap from complete6.18 delivers current guide bytes while its saved guide variable remains old", async () => {
    const run = await start(earlierGraph());
    await run.advance({ ...INTAKE, execution_note: "A legacy note, not a title" });
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("materialize-workspace-bootstrap");
    const copiedGuide = paused.globalContext.variables.workflow_reference_progress;
    expect(copiedGuide).toBe(earlierGraph().variableRegistry?.workflow_reference_progress.default);
    expect(copiedGuide).not.toBe(
      currentGraph().variableRegistry?.workflow_reference_progress.default,
    );
    await run.repository.saveWorkflow({ ...currentGraph(), id: run.stored.id }, USER_ID);
    const diagnosis = await diagnoseContinuation(
      run.repository,
      paused,
      await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID),
    );
    expect({ continuable: diagnosis.continuable, causes: diagnosis.causes }).toEqual({
      continuable: true,
      causes: [],
    });
    const delivered = await run.deliverFiles();
    const actualGuide = readFileSync(delivered.get("reference/progress.md")!, "utf8");
    expect(actualGuide).toContain("update-task-title");
    expect(actualGuide).not.toBe(copiedGuide);
    await run.advance();
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("gather-workflow-requirements");
    expect(continued.globalContext.variables.workflow_reference_progress).toBe(copiedGuide);
  });
});

describe("todo-list persisted naming and complete earlier-definition compatibility", () => {
  const tasks = [
    { action: "Draft release notes", expected_result: "Notes cover the released changes" },
    { action: "Review release notes", expected_result: "The approved notes are accurate" },
  ];
  const intake = { tasks, progress_checklist_outcome: "Draft and review release notes" };

  async function atIntake(graph: WorkflowGraph) {
    const run = await start(graph);
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "materialize-workflow-guide",
    );
    const delivered = await run.deliverFiles();
    const guidePath = delivered.get("workflow-guide.md");
    if (!guidePath) throw new Error("The actual canonical guide was not delivered");
    const presentation = await run.advance();
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "obtain-tasks",
    );
    return { ...run, intakePresentation: presentation, guidePath };
  }

  test("persists a real intake name and renames the actual revision teleport while preserving completed work and each presented step", async () => {
    const run = await atIntake(currentGraph("todo-list"));
    expect(run.intakePresentation).toContain("actually persist the human name");
    const intakeState = (await run.repository.getExecution(run.executionId))!;
    expect(intakeState.globalContext.variables.workflow_guide).toContain("update-task-title");
    expect(readFileSync(run.guidePath, "utf8")).toContain("update-task-title");
    const firstAttempt = await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID);
    await rename(run.executionId, "Prepare release notes");
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(firstAttempt?.attemptId);
    await run.advance(intake);
    await run.advance({
      evidence: "Draft directly inspected",
      progress_execution_outcome: "Release notes drafted",
    });
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("execute-task");
    expect(paused.globalContext.variables.current_task).toBe(2);
    const revisionPresentation = await run.advance(undefined, "teleport-revise-tasks");
    expect(revisionPresentation).toContain("update this run's persisted task name");
    const revisionAttempt = await run.repository.getCurrentExecutionAttempt(
      run.executionId,
      USER_ID,
    );
    const renamed = await rename(run.executionId, "Prepare release notes and a migration notice");
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(revisionAttempt?.attemptId);
    await run.advance({
      tasks: [
        ...tasks,
        { action: "Write migration notice", expected_result: "Users can follow the migration" },
      ],
      resume_from_task: 2,
      progress_checklist_outcome: "Review notes and add the authorized migration notice",
      progress_execution_outcome: "Release notes draft remains valid",
    });
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("execute-task");
    expect(continued.globalContext.variables.current_task).toBe(2);
    expect((continued.globalContext.variables.tasks as unknown[])[0]).toEqual(tasks[0]);
    expect(continued.taskIdentity).toEqual(renamed.taskIdentity);
  });

  test("a changed real3.10 intake is diagnosed and recovered with current guide on the same execution", async () => {
    const old = earlierGraph("todo-list");
    expect(old.metadata.version).toBe("3.10.0");
    const run = await atIntake(old);
    const oldGuide = readFileSync(run.guidePath, "utf8");
    expect(oldGuide).not.toContain("update-task-title");
    const current = currentGraph("todo-list");
    const originallyPaused = (await run.repository.getExecution(run.executionId))!;
    expect(originallyPaused.globalContext.variables.workflow_guide).not.toBe(
      current.variableRegistry?.workflow_guide.default,
    );
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const context = await inspect(run.executionId);
    // A counterexample at recovery's guarded context-storage boundary, not an external
    // guide-edit permission: this graph deliberately grants no session set-variable policy.
    await run.repository.updateExecutionContext(
      run.executionId,
      {
        variables: {
          ...originallyPaused.globalContext.variables,
          workflow_guide: current.variableRegistry!.workflow_guide.default,
        },
      },
      context.revision,
      context.metadataRevisions.context,
    );
    expect(
      (await run.repository.getExecution(run.executionId))?.globalContext.variables.workflow_guide,
    ).toBe(current.variableRegistry!.workflow_guide.default);
    expect(readFileSync(run.guidePath, "utf8")).toBe(oldGuide);
    const before = (await run.repository.getExecution(run.executionId))!;
    const diagnosis = await diagnoseContinuation(
      run.repository,
      before,
      await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID),
    );
    expect(diagnosis.continuable).toBe(false);
    expect(
      diagnosis.causes.filter((cause) => cause.blocks).map((cause) => JSON.stringify(cause)),
    ).toEqual(expect.arrayContaining([expect.stringContaining("node.directive")]));
    const recovery = await session({
      action: "recover",
      executionId: run.executionId,
      nodeId: "materialize-workflow-guide",
    });
    expect(recovery.success).toBe(true);
    const recovered = recovery.data as {
      executionId: string;
      nodeId: string;
      presentation: string;
    };
    expect(recovered.executionId).toBe(before.executionId);
    expect(recovered.nodeId).toBe("materialize-workflow-guide");
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "materialize-workflow-guide",
    );
    const delivered = await run.deliverFiles();
    expect(delivered.get("workflow-guide.md")).toBe(run.guidePath);
    expect(readFileSync(run.guidePath, "utf8")).toBe(
      current.variableRegistry!.workflow_guide.default,
    );
    expect(readFileSync(run.guidePath, "utf8")).toContain("update-task-title");
    const intakePresentation = await run.engine.executor.executeStep(
      run.executionId,
      {},
      undefined,
      {
        userId: USER_ID,
        attemptId: attemptId(recovered.presentation),
      },
    );
    expect(intakePresentation).toContain("actually persist the human name");
    const restored = (await run.repository.getExecution(run.executionId))!;
    expect(restored.note).toBe(before.note);
    await rename(run.executionId, "Prepare release notes");
    await run.engine.executor.executeStep(run.executionId, intake, undefined, {
      userId: USER_ID,
      attemptId: attemptId(intakePresentation),
    });
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(before.executionId);
    expect(continued.currentNodeId).toBe("execute-task");
  });

  test("an unchanged actual task from complete3.10 continues under its captured attempt and old guide", async () => {
    const run = await atIntake(earlierGraph("todo-list"));
    await run.advance({ ...intake, execution_note: "A legacy arbitrary note" });
    await rename(run.executionId, "Prepare release notes");
    const paused = (await run.repository.getExecution(run.executionId))!;
    const deliveredOldGuide = readFileSync(run.guidePath, "utf8");
    const current = currentGraph("todo-list");
    expect(paused.globalContext.variables.workflow_guide).not.toBe(
      current.variableRegistry?.workflow_guide.default,
    );
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const diagnosis = await diagnoseContinuation(
      run.repository,
      paused,
      await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID),
    );
    expect({ continuable: diagnosis.continuable, causes: diagnosis.causes }).toEqual({
      continuable: true,
      causes: [],
    });
    await run.advance({
      evidence: "Draft directly inspected",
      progress_execution_outcome: "Release notes drafted",
    });
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.globalContext.variables.current_task).toBe(2);
    expect(continued.globalContext.variables.workflow_guide).toBe(
      paused.globalContext.variables.workflow_guide,
    );
    expect(readFileSync(run.guidePath, "utf8")).toBe(deliveredOldGuide);
    expect(deliveredOldGuide).not.toContain("update-task-title");
    expect(continued.taskIdentity).toEqual(paused.taskIdentity);
  });
});

describe("robust-task canonical delivered naming and complete earlier-definition compatibility", () => {
  const workspace = "./moira-ws/robust-task-release-20261003-1420/";
  const units = [{ title: "Draft the announcement" }, { title: "Verify release facts" }];
  const intake = {
    workspace_path: workspace,
    operating_mode: "autonomous",
    goal_summary: "Release communication accurately describes the v1.0 CSV export feature",
    progress_intake_outcome: "Release communication task and no-publication authority captured",
  };
  const revision = {
    current_plan_file: "plans/002/plan.md",
    plan_steps: [...units, { title: "Add migration instructions" }],
    progress_plan_outcome:
      "Authorized migration extension covered while the release draft remains valid",
    progress_execution_outcome: "The release announcement draft remains completed",
    progress_step_review_outcome: "The completed first draft retains its passed verdict",
    progress_final_review_outcome: "Pending final review of the complete revised task",
  };

  async function capture(graph: WorkflowGraph) {
    const run = await start(graph);
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "initialize-workspace",
    );
    const requirementsPath = record(
      run.callerRoot,
      workspace + "task-requirements.md",
      "Prepare release v1.0 communication describing CSV export. No publication. Any migration extension requires an exact later authorization.\n",
    );
    const processPath = record(
      run.callerRoot,
      workspace + "process-id.txt",
      run.executionId + "\n",
    );
    const guidePath = join(run.callerRoot, workspace, "workflow-guide.md");
    expect(existsSync(guidePath)).toBe(false);
    return { ...run, requirementsPath, processPath, guidePath };
  }

  async function materialize(run: Awaited<ReturnType<typeof capture>>) {
    const delivered = await run.deliverFiles();
    expect(delivered.get("workflow-guide.md")).toBe(run.guidePath);
    return readFileSync(run.guidePath, "utf8");
  }

  async function reviewedFirstUnit(run: Awaited<ReturnType<typeof capture>>) {
    const planPath = record(
      run.callerRoot,
      workspace + "plans/001/plan.md",
      "1. Draft the v1.0 CSV export announcement and directly read its version and feature.\n2. Verify its release facts against the captured task and record the observation.\n",
    );
    await run.advance({
      current_plan_file: "plans/001/plan.md",
      plan_steps: units,
      progress_plan_outcome: "Two release communication steps ready for independent review",
    });
    const reviewPath = record(
      run.callerRoot,
      workspace + "plans/001/review.md",
      "Independent review: both captured outcomes and no-publication authority are covered with direct verification. No blocking findings.\n",
    );
    await run.advance({
      review_outcome: "pass",
      progress_plan_outcome:
        "The complete release communication plan is independently reviewed clean",
    });
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "execute-step",
    );
    const resultPath = record(
      run.callerRoot,
      workspace + "announcement.md",
      "Release v1.0: users can export their data as CSV.\n",
    );
    expect(readFileSync(resultPath, "utf8")).toContain("v1.0");
    expect(readFileSync(resultPath, "utf8")).toContain("CSV");
    const evidence =
      "Release v1.0 announcement produced; direct result-file reading confirms the captured CSV export feature.\n";
    expect(evidence.length).toBeLessThanOrEqual(500);
    const evidencePath = record(
      run.callerRoot,
      workspace + "steps/1/plans/001/attempts/1/evidence.md",
      evidence,
    );
    await run.advance({
      evidence_file: "steps/1/plans/001/attempts/1/evidence.md",
      progress_execution_outcome: "Release announcement produced and directly verified",
    });
    expect(
      (await run.repository.getExecution(run.executionId))?.globalContext.variables.current_step,
    ).toBe(1);
    const verdictPath = record(
      run.callerRoot,
      workspace + "steps/1/plans/001/attempts/1/verdict.md",
      "Independent verdict: the exact announcement matches the captured version and feature, has direct evidence and performs no publication. Pass.\n",
    );
    await run.advance({
      review_outcome: "pass",
      verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
      progress_step_review_outcome: "The exact completed release draft independently passes review",
    });
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("execute-step");
    expect(paused.globalContext.variables.current_step).toBe(2);
    return snapshot([
      run.requirementsPath,
      run.processPath,
      run.guidePath,
      planPath,
      reviewPath,
      resultPath,
      evidencePath,
      verdictPath,
    ]);
  }

  function revisedRecords(run: Awaited<ReturnType<typeof capture>>) {
    record(
      run.callerRoot,
      workspace + "plans/002/change.md",
      "Explicit revised request authorizes migration guidance alongside the release communication; completed position one and original no-publication authority remain valid.\n",
    );
    record(
      run.callerRoot,
      workspace + "plans/002/plan.md",
      "1. Retain the completed reviewed release draft.\n2. Verify release facts by direct comparison.\n3. Add the authorized migration instructions and verify the described steps.\n",
    );
    record(
      run.callerRoot,
      workspace + "plans/002/review.md",
      "Independent review: the completed prefix is preserved, the authorized migration extension is covered with verification, and publication remains excluded. No blockers.\n",
    );
  }

  test("actually names intake before guide delivery and a reviewed replan without erasing concrete completed evidence", async () => {
    const run = await capture(currentGraph("robust-task"));
    expect(run.presentation).toContain("update-task-title");
    expect(run.presentation).toContain("metadataRevisions.taskIdentity");
    expect(run.presentation).toContain("The canonical guide is delivered next");
    const captured = snapshot([run.requirementsPath, run.processPath]);
    const intakeAttempt = await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID);
    await rename(run.executionId, "Prepare release communication");
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(intakeAttempt?.attemptId);
    retained(captured);
    await run.advance(intake);
    expect(await materialize(run)).toBe(
      currentGraph("robust-task").variableRegistry!.workflow_guide.default,
    );
    expect(readFileSync(run.guidePath, "utf8")).toContain("update-task-title");
    await run.advance();
    const completed = await reviewedFirstUnit(run);
    const presentation = await run.advance(undefined, "teleport-replan");
    expect(presentation).toContain("Task naming responsibility:");
    const attempt = await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID);
    const named = await rename(run.executionId, "Prepare release and migration communication");
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(attempt?.attemptId);
    retained(completed);
    revisedRecords(run);
    await run.advance(revision);
    await run.advance({
      review_outcome: "pass",
      progress_plan_outcome: "The revised complete plan independently passes review",
    });
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.currentNodeId).toBe("execute-step");
    expect(continued.globalContext.variables.current_step).toBe(2);
    expect((continued.globalContext.variables.plan_steps as unknown[])[0]).toEqual(units[0]);
    expect(continued.taskIdentity).toEqual(named.taskIdentity);
    expect(continued.visits?.filter((visit) => visit.nodeId === "close-step")).toHaveLength(1);
    retained(completed);
  });

  test("the real unchanged9.8 bootstrap ordinarily delivers current guide bytes while its saved default remains old", async () => {
    const old = earlierGraph("robust-task");
    expect(old.metadata.version).toBe("9.8.0");
    const run = await capture(old);
    await run.advance({ ...intake, execution_note: "An arbitrary legacy observation" });
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("materialize-workflow-guide");
    expect(paused.globalContext.variables.workflow_guide).toBe(
      old.variableRegistry!.workflow_guide.default,
    );
    const callerFiles = snapshot([run.requirementsPath, run.processPath]);
    const current = currentGraph("robust-task");
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const diagnosis = await session({ action: "diagnose", executionId: run.executionId });
    expect(diagnosis.success).toBe(true);
    expect(diagnosis.data).toMatchObject({ continuable: true, causes: [] });
    expect(await materialize(run)).toBe(current.variableRegistry!.workflow_guide.default);
    expect(readFileSync(run.guidePath, "utf8")).toContain("update-task-title");
    await run.advance();
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("create-plan");
    expect(continued.note).toBe(paused.note);
    expect(continued.globalContext.variables.workflow_guide).toBe(
      paused.globalContext.variables.workflow_guide,
    );
    retained(callerFiles);
  });

  test("public recovery of a genuine9.8 scope-owner pause physically refreshes the guide and preserves passed work on the same execution", async () => {
    const run = await capture(earlierGraph("robust-task"));
    await rename(run.executionId, "Prepare release communication");
    await run.advance({ ...intake, execution_note: "An arbitrary legacy observation" });
    expect(await materialize(run)).not.toContain("update-task-title");
    await run.advance();
    const completed = await reviewedFirstUnit(run);
    await run.advance(undefined, "teleport-replan");
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("teleport-replan");
    const current = currentGraph("robust-task");
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const diagnosis = await session({ action: "diagnose", executionId: run.executionId });
    expect(diagnosis.success).toBe(true);
    expect(diagnosis.data).toMatchObject({ continuable: false });
    const recovery = await session({
      action: "recover",
      executionId: run.executionId,
      nodeId: "materialize-workflow-guide",
    });
    expect(recovery.success).toBe(true);
    const recovered = recovery.data as {
      executionId: string;
      nodeId: string;
      presentation: string;
    };
    expect(recovered).toMatchObject({
      executionId: paused.executionId,
      nodeId: "materialize-workflow-guide",
    });
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "materialize-workflow-guide",
    );
    retained(completed);
    expect(await materialize(run)).toBe(current.variableRegistry!.workflow_guide.default);
    expect(readFileSync(run.guidePath, "utf8")).toContain("update-task-title");
    completed.delete(run.guidePath); // The documented delivery legitimately replaces only the stale guide.
    const restored = (await run.repository.getExecution(run.executionId))!;
    expect(restored.globalContext.variables.current_step).toBe(2);
    expect(restored.globalContext.variables.workflow_guide).toBe(
      paused.globalContext.variables.workflow_guide,
    );
    expect(restored.taskIdentity).toEqual(paused.taskIdentity);
    expect(restored.note).toBe(paused.note);
    retained(completed);
    const planning = await run.engine.executor.executeStep(run.executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attemptId(recovered.presentation),
    });
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe("create-plan");
    const replan = await run.engine.executor.executeStep(
      run.executionId,
      undefined,
      "teleport-replan",
      { userId: USER_ID, attemptId: attemptId(planning) },
    );
    expect(replan).toContain("Task naming responsibility:");
    const named = await rename(run.executionId, "Prepare release and migration communication");
    revisedRecords(run);
    const review = await run.engine.executor.executeStep(run.executionId, revision, undefined, {
      userId: USER_ID,
      attemptId: attemptId(replan),
    });
    await run.engine.executor.executeStep(
      run.executionId,
      {
        review_outcome: "pass",
        progress_plan_outcome: "The revised complete plan independently passes review",
      },
      undefined,
      { userId: USER_ID, attemptId: attemptId(review) },
    );
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("execute-step");
    expect(continued.globalContext.variables.current_step).toBe(2);
    expect((continued.globalContext.variables.plan_steps as unknown[])[0]).toEqual(units[0]);
    expect(continued.taskIdentity).toEqual(named.taskIdentity);
    expect(continued.note).toBe(paused.note);
    expect(continued.visits?.filter((visit) => visit.nodeId === "close-step")).toHaveLength(1);
    retained(completed);
  });
});

describe("software-development-flow canonical naming and genuine earlier-unit compatibility", () => {
  const workspace = "./moira-ws/software-development-flow-csv-test/";
  const units = [{ title: "Implement quoted CSV export" }, { title: "Verify the export consumer" }];
  type Run = Awaited<ReturnType<typeof start>>;
  type Step = (nodeId: string, input?: Record<string, unknown>) => Promise<string>;

  async function response(run: Run, nodeId: string, input: Record<string, unknown> = {}) {
    const execution = (await run.repository.getExecution(run.executionId))!;
    expect(execution.currentNodeId).toBe(nodeId);
    const graph = (await run.repository.getWorkflowGraph(execution.workflowId, USER_ID))!;
    const node = graph.nodes.find((candidate) => candidate.id === nodeId) as {
      inputSchema?: { globalInputs?: string[] };
    };
    const progress = (node.inputSchema?.globalInputs ?? []).filter((name) =>
      name.startsWith("progress_"),
    );
    return {
      ...Object.fromEntries(
        progress.map((name) => [
          name,
          name === "progress_checkpoint_outcome"
            ? "No local commit authority was granted"
            : "The captured CSV export contract and current evidence support this responsibility",
        ]),
      ),
      ...input,
    };
  }

  function ordinaryStep(run: Run): Step {
    return async (nodeId, input) => run.advance(await response(run, nodeId, input));
  }

  function recoveredStep(run: Run, presentation: string): Step {
    let current = presentation;
    return async (nodeId, input) => {
      current = await run.engine.executor.executeStep(
        run.executionId,
        await response(run, nodeId, input),
        undefined,
        { userId: USER_ID, attemptId: attemptId(current) },
      );
      return current;
    };
  }

  async function capture(graph: WorkflowGraph) {
    const run = await start(graph);
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "capture-task-and-context",
    );
    const requestPath = record(
      run.callerRoot,
      workspace + "sources/user-request.md",
      "Implement CSV export that correctly quotes commas, double quotes and line breaks; verify its consumer. No commits, publication or deployment. Scope extensions require explicit later authorization.\n",
    );
    const requirementsPath = record(
      run.callerRoot,
      workspace + "task-requirements.md",
      readFileSync(requestPath, "utf8"),
    );
    const processPath = record(
      run.callerRoot,
      workspace + "process-id.txt",
      run.executionId + "\n",
    );
    const baselinePath = record(
      run.callerRoot,
      workspace + "vcs-baseline.md",
      "The isolated fixture project is empty and has no VCS repository; no unrelated work or local commit authority exists. No release effects are authorized.\n",
    );
    const contextPath = record(
      run.callerRoot,
      workspace + "project-context.md",
      "An isolated native Node module will encode CSV rows. Native assertions check punctuation and line breaks; an actual sample exercises the consumer boundary. README documents the observed behavior after validation. Visual mode is disabled.\n",
    );
    const planningPath = join(run.callerRoot, workspace, "standards/planning.md");
    expect(existsSync(planningPath)).toBe(false);
    return {
      ...run,
      requestPath,
      requirementsPath,
      processPath,
      baselinePath,
      contextPath,
      planningPath,
    };
  }

  function intake(old = false) {
    return {
      workspace_path: workspace,
      operating_mode: "autonomous",
      visual_validation_preference: "disabled",
      goal_summary: "Users can export punctuation-containing values as valid CSV",
      progress_intake_outcome: "CSV quoting requirements and no-release authority captured",
      ...(old ? { execution_note: "An arbitrary old execution observation" } : {}),
    };
  }

  async function baseline(run: Run, step: Step) {
    const projectRoot = join(run.callerRoot, "csv-project");
    expect(existsSync(projectRoot)).toBe(false);
    record(
      run.callerRoot,
      workspace + "project-health.md",
      "The isolated native Node project starts empty; no existing executable or baseline test can fail. Runtime and native assertions will verify the new CSV unit. No VCS authority.\n",
    );
    await step("assess-project-health", { health_outcome: "pass" });
  }

  async function reviewedPlan(
    run: Run,
    step: Step,
    revision: number,
    writer: string,
    resume: number,
  ) {
    const plan =
      revision === 1
        ? "Plan r1: 1. Implement quoted CSV export with direct native assertions, actual sample behavior and late README; visualMode=disabled, userApproval=false. 2. Verify the consumer contract; visualMode=disabled, userApproval=false. No local commits or release effects.\n"
        : "Plan r2: closed unit1 retains its exact origin plan1/step1, native encoder/tests/README and evidence beneath that origin. Unit2 verifies the consumer. New unit3 adds the explicitly authorized migration example before any such change; all units visualMode=disabled, userApproval=false. No local commits or release effects.\n";
    const planPath = record(run.callerRoot, workspace + "plans/" + revision + "/plan.md", plan);
    await step(writer, {
      plan_units:
        revision === 1 ? units : [...units, { title: "Add the authorized migration example" }],
      progress_plan_outcome:
        "Plan r" + revision + " preserves exact outcomes and completed origins",
    });
    const reviewPath = record(
      run.callerRoot,
      workspace + "plans/" + revision + "/review.md",
      "Review fixture: captured outcomes, explicit authority, policies and direct evidence are covered; completed origin is preserved and release effects excluded. No blockers. This durable fixture verdict exercises consumer behavior rather than claiming an independent agent judgment.\n",
    );
    await step("review-plan", { review_outcome: "pass" });
    await step("activate-reviewed-plan", {
      current_step_index: resume,
      vcs_commits_authorized: false,
      progress_plan_outcome:
        "Plan r" +
        revision +
        ": " +
        (revision === 1 ? "2" : "3") +
        " executable units — quoted CSV export, consumer verification" +
        (revision === 1 ? "" : ", authorized migration example"),
    });
    expect(
      (await run.repository.getExecution(run.executionId))?.globalContext.variables.completed_units,
    ).toBe(resume - 1);
    return [planPath, reviewPath];
  }

  async function completeFirstUnit(run: Awaited<ReturnType<typeof capture>>, step: Step) {
    const planFiles = await reviewedPlan(run, step, 1, "create-plan", 1);
    const unitRoot = workspace + "plans/1/step-1/";
    const preparation = record(
      run.callerRoot,
      unitRoot + "implementation-preparation.md",
      "Native CSV quoting covers commas, quotes and line breaks. Direct assertions distinguish naive comma joining; an actual sample checks consumer output. The empty baseline and approved disabled visuals/no-approval/no-VCS policy remain valid.\n",
    );
    await step("prepare-plan-unit-implementation", {
      preparation_outcome: "ready",
      visual_mode: "disabled",
      approval_required: false,
    });
    const productPath = record(
      run.callerRoot,
      "csv-project/export.mjs",
      [
        "export function csv(rows) {",
        '  return rows.map(row => row.map(value => /[",\\n]/.test(value)',
        '    ? \'"\' + value.replaceAll(\'"\', \'""\') + \'"\' : value).join(",")).join("\\n");',
        "}",
        'if (process.argv[2] === "sample") process.stdout.write(csv([["version","feature"],["v1.0","CSV, export"]]));',
        "",
      ].join("\n"),
    );
    const testPath = record(
      run.callerRoot,
      "csv-project/export.test.mjs",
      [
        'import assert from "node:assert/strict";',
        'import { csv } from "./export.mjs";',
        'assert.equal(csv([["a","b"]]), "a,b");',
        'assert.equal(csv([[\'a,b\', \'say "hi"\', \'line\\nbreak\', \'\']]), \'"a,b","say ""hi""","line\\nbreak",\');',
        "",
      ].join("\n"),
    );
    execFileSync(process.execPath, [testPath], { encoding: "utf8" });
    const sample = execFileSync(process.execPath, [productPath, "sample"], { encoding: "utf8" });
    expect(sample).toBe('version,feature\nv1.0,"CSV, export"');
    const reportPath = record(
      run.callerRoot,
      unitRoot + "unit-report.md",
      "Quoted CSV export implemented against the empty baseline. Native assertions cover plain cells, punctuation, quote doubling, line breaks and empty values; actual sample emits quoted CSV. Permanent README is deferred until validation; consumer verification remains a later unit.\n",
    );
    const docPath = join(run.callerRoot, "csv-project/README.md");
    expect(existsSync(docPath)).toBe(false);
    await step("implement-plan-unit", {
      progress_implementation_outcome:
        "CSV quoting behavior and native assertions exist; README deferred",
    });
    execFileSync(process.execPath, [testPath], { encoding: "utf8" });
    await step("complete-plan-unit", { completion_outcome: "ready" });
    expect(existsSync(docPath)).toBe(false);
    execFileSync(process.execPath, ["--check", productPath], { encoding: "utf8" });
    const cheap = record(
      run.callerRoot,
      unitRoot + "iteration-1/cheap-validation.md",
      "Native syntax check and direct assertions pass on the exact encoder; no mechanical issue.\n",
    );
    await step("validate-cheap", { issues_count: 0 });
    const adequacy = record(
      run.callerRoot,
      unitRoot + "iteration-1/test-adequacy-review.md",
      "Assertions distinguish naive comma joining: punctuation, quotes and embedded newlines require actual quoting; empty values remain empty. Tests cover the approved unit rather than proving the later consumer unit.\n",
    );
    await step("review-test-adequacy", { review_outcome: "pass" });
    const architecture = record(
      run.callerRoot,
      unitRoot + "iteration-1/architecture-review.md",
      "A native pure encoder and separate consumer sample preserve the boundary of this isolated project; no duplicate runtime or publication mechanism.\n",
    );
    await step("review-architecture", { review_outcome: "pass" });
    expect(execFileSync(process.execPath, [productPath, "sample"], { encoding: "utf8" })).toBe(
      sample,
    );
    const runtime = record(
      run.callerRoot,
      unitRoot + "iteration-1/runtime-validation.md",
      "The actual native sample output is:\n" +
        sample +
        "\nIts punctuation is correctly quoted. Visual evidence is inapplicable under the approved disabled policy.\n",
    );
    await step("validate-runtime", { validation_outcome: "pass" });
    const broad = record(
      run.callerRoot,
      unitRoot + "iteration-1/expensive-validation.md",
      "No packaging, integration service, browser or broad suite exists in this isolated native module; focused syntax/assertion/sample evidence covers this unit. No mutation after that evidence.\n",
    );
    await step("validate-expensive", { validation_outcome: "not_applicable" });
    expect(existsSync(docPath)).toBe(false);
    record(
      run.callerRoot,
      "csv-project/README.md",
      "CSV export quotes commas and line breaks and doubles embedded quotes. Native sample output:\n" +
        sample +
        "\nNo release or deployment is performed.\n",
    );
    expect(readFileSync(docPath, "utf8")).toContain(sample);
    await step("update-unit-documentation", { documentation_outcome: "ready" });
    const completeness = record(
      run.callerRoot,
      unitRoot + "completeness-review.md",
      "Review fixture reads the current encoder/tests/README, approved unit, producer report and current native evidence. The CSV outcome is complete; later consumer work remains separate. No blocker; no VCS authority. This record does not claim independent agent judgment.\n",
    );
    const beforeClosure = (await run.repository.getExecution(run.executionId))!;
    expect(beforeClosure.globalContext.variables.completed_units).toBe(0);
    await step("review-unit-completeness", {
      review_outcome: "pass",
      unit_result_summary: "CSV export correctly quotes punctuation-containing values",
    });
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("prepare-plan-unit-implementation");
    expect(paused.globalContext.variables).toMatchObject({
      current_step_index: 2,
      completed_units: 1,
      plan_revision: 1,
      vcs_commits_authorized: false,
    });
    expect(paused.globalContext.variables["prepare-plan-unit-implementation"]).toMatchObject({
      visual_mode: "disabled",
      approval_required: false,
    });
    return snapshot([
      run.requestPath,
      run.requirementsPath,
      run.processPath,
      run.baselinePath,
      run.contextPath,
      run.planningPath,
      ...planFiles,
      preparation,
      productPath,
      testPath,
      reportPath,
      cheap,
      adequacy,
      architecture,
      runtime,
      broad,
      docPath,
      completeness,
    ]);
  }

  function authorizedChange(
    run: Awaited<ReturnType<typeof capture>>,
    completed: Map<string, string>,
  ) {
    const source = record(
      run.callerRoot,
      workspace + "sources/authorized-change.md",
      "Explicit later user authorization: also add a migration example using the CSV export. Completed unit1 remains valid; commits/publication/deployment stay unauthorized.\n",
    );
    record(
      run.callerRoot,
      workspace + "task-requirements.md",
      readFileSync(run.requestPath, "utf8") + readFileSync(source, "utf8"),
    );
    completed.delete(run.requirementsPath); // Canonical requirements legitimately incorporate the explicit later authorization.
    expect(readFileSync(run.requirementsPath, "utf8")).toContain(
      readFileSync(run.requestPath, "utf8"),
    );
    return snapshot([run.requirementsPath, source]);
  }

  async function finishReplan(
    run: Awaited<ReturnType<typeof capture>>,
    step: Step,
    completed: Map<string, string>,
  ) {
    const revisionAttempt = await run.repository.getCurrentExecutionAttempt(
      run.executionId,
      USER_ID,
    );
    const named = await rename(run.executionId, "Implement CSV export and a migration example");
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(revisionAttempt?.attemptId);
    retained(completed);
    await step("teleport-replan", {
      replan_rationale:
        "The user explicitly authorized a migration example. Completed CSV encoder unit1 remains valid at plan1/step1; retain consumer verification and add a new migration unit before any such mutation.",
      progress_plan_outcome:
        "Authorized migration example requires a new plan; completed CSV export stays valid",
    });
    await reviewedPlan(run, step, 2, "revise-plan-for-teleport", 2);
    const resumed = (await run.repository.getExecution(run.executionId))!;
    expect(resumed.executionId).toBe(run.executionId);
    expect(resumed.currentNodeId).toBe("prepare-plan-unit-implementation");
    expect(resumed.globalContext.variables).toMatchObject({
      current_step_index: 2,
      completed_units: 1,
      plan_revision: 2,
      previous_plan_revision: 1,
      vcs_commits_authorized: false,
    });
    expect((resumed.globalContext.variables.plan_units as unknown[])[0]).toEqual(units[0]);
    expect(resumed.taskIdentity).toEqual(named.taskIdentity);
    expect(readFileSync(join(run.callerRoot, workspace, "plans/2/plan.md"), "utf8")).toContain(
      "origin plan1/step1",
    );
    retained(completed);
  }

  test("names intake before standards and preserves a genuinely completed native software unit through actual authorized replan", async () => {
    const run = await capture(currentGraph("software-development-flow"));
    expect(run.presentation).toContain("update-task-title");
    expect(run.presentation).toContain("metadataRevisions.taskIdentity");
    expect(run.presentation).toContain("do not wait for their files");
    const attempt = await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID);
    await rename(run.executionId, "Implement quoted CSV export");
    expect(
      (await run.repository.getCurrentExecutionAttempt(run.executionId, USER_ID))?.attemptId,
    ).toBe(attempt?.attemptId);
    const step = ordinaryStep(run);
    await step("capture-task-and-context", intake());
    const delivered = await run.deliverFiles();
    expect(delivered.get("standards/planning.md")).toBe(run.planningPath);
    expect(readFileSync(run.planningPath, "utf8")).toBe(
      currentGraph("software-development-flow").variableRegistry!.planning_standards.default,
    );
    expect(readFileSync(run.planningPath, "utf8")).toContain("update-task-title");
    await run.advance();
    await baseline(run, step);
    const completed = await completeFirstUnit(run, step);
    const authorized = authorizedChange(run, completed);
    const replan = await run.advance(undefined, "teleport-replan");
    expect(replan).toContain("Task naming responsibility:");
    await finishReplan(run, step, completed);
    retained(authorized);
  });

  test("an unchanged complete16.2 bootstrap ordinarily delivers current standards while old saved defaults stay old", async () => {
    const old = earlierGraph("software-development-flow");
    expect(old.metadata.version).toBe("16.2.0");
    const run = await capture(old);
    const step = ordinaryStep(run);
    await step("capture-task-and-context", intake(true));
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("materialize-development-standards");
    const captured = snapshot([
      run.requestPath,
      run.requirementsPath,
      run.processPath,
      run.baselinePath,
      run.contextPath,
    ]);
    const current = currentGraph("software-development-flow");
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const diagnosis = await session({ action: "diagnose", executionId: run.executionId });
    expect(diagnosis.success).toBe(true);
    expect(diagnosis.data).toMatchObject({ continuable: true, causes: [] });
    const delivered = await run.deliverFiles();
    expect(readFileSync(delivered.get("standards/planning.md")!, "utf8")).toBe(
      current.variableRegistry!.planning_standards.default,
    );
    expect(readFileSync(run.planningPath, "utf8")).toContain("update-task-title");
    expect(paused.globalContext.variables.planning_standards).toBe(
      old.variableRegistry!.planning_standards.default,
    );
    expect(readFileSync(run.planningPath, "utf8")).not.toBe(
      paused.globalContext.variables.planning_standards,
    );
    await run.advance();
    const continued = (await run.repository.getExecution(run.executionId))!;
    expect(continued.executionId).toBe(paused.executionId);
    expect(continued.currentNodeId).toBe("assess-project-health");
    expect(continued.globalContext.variables.planning_standards).toBe(
      paused.globalContext.variables.planning_standards,
    );
    expect(continued.note).toBe(paused.note);
    const progress = await session({ action: "progress", executionId: run.executionId });
    expect(progress.success).toBe(true);
    expect(progress.data).toMatchObject({
      taskIdentity: null,
      taskTitle: "Software Development · plan r1",
    });
    retained(captured);
  });

  test("public recovery of a real16.2 completed-unit scope pause physically refreshes standards and resumes the preserved origin", async () => {
    const run = await capture(earlierGraph("software-development-flow"));
    await rename(run.executionId, "Implement quoted CSV export");
    const step = ordinaryStep(run);
    await step("capture-task-and-context", intake(true));
    await run.deliverFiles();
    expect(readFileSync(run.planningPath, "utf8")).not.toContain("update-task-title");
    await run.advance();
    await baseline(run, step);
    const completed = await completeFirstUnit(run, step);
    await run.advance(undefined, "teleport-replan");
    const paused = (await run.repository.getExecution(run.executionId))!;
    expect(paused.currentNodeId).toBe("teleport-replan");
    const current = currentGraph("software-development-flow");
    await run.repository.saveWorkflow({ ...current, id: run.stored.id }, USER_ID);
    const diagnosis = await session({ action: "diagnose", executionId: run.executionId });
    expect(diagnosis.success).toBe(true);
    expect(diagnosis.data).toMatchObject({ continuable: false });
    const recovery = await session({
      action: "recover",
      executionId: run.executionId,
      nodeId: "materialize-development-standards",
    });
    expect(recovery.success).toBe(true);
    const recovered = recovery.data as {
      executionId: string;
      nodeId: string;
      presentation: string;
    };
    expect(recovered).toMatchObject({
      executionId: paused.executionId,
      nodeId: "materialize-development-standards",
    });
    expect((await run.repository.getExecution(run.executionId))?.currentNodeId).toBe(
      "materialize-development-standards",
    );
    retained(completed);
    const delivered = await run.deliverFiles();
    expect(delivered.get("standards/planning.md")).toBe(run.planningPath);
    expect(readFileSync(run.planningPath, "utf8")).toBe(
      current.variableRegistry!.planning_standards.default,
    );
    expect(readFileSync(run.planningPath, "utf8")).toContain("update-task-title");
    completed.delete(run.planningPath); // Actual native delivery replaces only this old standard's contents.
    const restored = (await run.repository.getExecution(run.executionId))!;
    expect(restored.globalContext.variables.planning_standards).toBe(
      paused.globalContext.variables.planning_standards,
    );
    expect(restored.globalContext.variables).toMatchObject({
      current_step_index: 2,
      completed_units: 1,
      plan_revision: 1,
      vcs_commits_authorized: false,
    });
    expect(restored.taskIdentity).toEqual(paused.taskIdentity);
    expect(restored.note).toBe(paused.note);
    const recoveredNext = recoveredStep(run, recovered.presentation);
    const health = await recoveredNext("materialize-development-standards");
    expect(health).toContain("standards/planning.md");
    // The existing baseline remains true; recovering delivery does not fabricate a fresh empty project.
    expect(existsSync(join(run.callerRoot, "csv-project/export.mjs"))).toBe(true);
    const planning = await recoveredNext("assess-project-health", { health_outcome: "pass" });
    const replan = await run.engine.executor.executeStep(
      run.executionId,
      undefined,
      "teleport-replan",
      { userId: USER_ID, attemptId: attemptId(planning) },
    );
    expect(replan).toContain("Task naming responsibility:");
    const authorized = authorizedChange(run, completed);
    await finishReplan(run, recoveredStep(run, replan), completed);
    retained(authorized);
    retained(completed);
  });
});
