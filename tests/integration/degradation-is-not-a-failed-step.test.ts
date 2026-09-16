/**
 * A degraded step is audited as the step it was, not as a failed attempt.
 *
 * The execution error journal now holds two different kinds of fact. A refusal says the step did
 * not happen: the agent's answer was rejected and the run waits at the same node again. A
 * degradation says the step did happen, but without behaviour text it names — a playbook that
 * became unreadable between the last edit and this step.
 *
 * Every consumer that reads the journal to decide "did this step fail" has to tell them apart. The
 * repair loop is where it matters, because there the run legitimately returns to the node it came
 * from, so the audit path cannot separate the two by node identity and falls back to the journal.
 */

import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  AuditAction,
  auditLog,
  getDatabase,
  getPlaybookService,
  getWorkflowService,
  user,
} from "@mcp-moira/shared";
import { eq, and } from "drizzle-orm";
import { DatabaseRepository, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";

const USER_ID = "degradation-audit-user";
const SLUG = "degradation-audit-standard";

/** A repair loop: the node routes back to itself until the agent reports it is done. */
function loopingGraph(): WorkflowGraph {
  return {
    metadata: { name: "Degradation audit", version: "1.0.0", description: "Repair loop" },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: `Follow this standard: {{playbook:${SLUG}}}`,
        completionCondition: "The work follows the standard.",
        inputSchema: {
          type: "object",
          properties: { done: { type: "boolean" } },
          required: ["done"],
        },
        connections: { success: "check" },
      },
      {
        type: "condition",
        id: "check",
        cases: [
          { when: { operator: "eq", left: { contextPath: "done" }, right: true }, output: "true" },
        ],
        connections: { true: "end", default: "task" },
      },
      { type: "end", id: "end" },
    ],
  } as unknown as WorkflowGraph;
}

async function stepAttemptActions(executionId: string): Promise<string[]> {
  const rows = await getDatabase()
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(eq(auditLog.resourceId, executionId), eq(auditLog.resource, "execution")));
  return rows.map((row) => row.action);
}

describe("a degraded step is not a failed attempt", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: USER_ID,
        email: `${USER_ID}@example.test`,
        handle: `handle-of-${USER_ID}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });

  afterEach(() => MCPEngine.resetInstance());

  test("an unreadable playbook leaves the run degraded without an audited failure", async () => {
    const playbooks = getPlaybookService();
    await playbooks.save(USER_ID, { slug: SLUG, content: "Read the whole diff." });

    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({
      graph: loopingGraph(),
      userId: USER_ID,
      visibility: "private",
    });
    const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(stored, undefined, USER_ID);
    const first = await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    expect(first).toContain("Read the whole diff.");
    const attemptId = first.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(attemptId).toBeDefined();

    // The playbook disappears mid-run: the next presentation of the same node degrades.
    await playbooks.remove(USER_ID, USER_ID, SLUG);

    const looped = await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, { done: false }, undefined, attemptId!),
    );

    // The step happened: the run came back to the same node and the agent sees the placeholder.
    expect(looped).toContain(`[PLAYBOOK NOT AVAILABLE: ${SLUG}]`);
    const degraded = (await repository.getExecution(executionId))!;
    expect(degraded.currentNodeId).toBe("task");
    expect(degraded.errors?.map((entry) => entry.errorType)).toContain("degradation");

    // and it is not audited as a failed attempt.
    expect(await stepAttemptActions(executionId)).not.toContain(AuditAction.EXECUTION_STEP_ATTEMPT);

    // The agent's own listing agrees: the run carries no errors, the same answer the web list
    // gives for the same run. Two surfaces reading one journal must not disagree about it.
    const listed = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "executions", status: ["running"] }),
    );
    const entry = (
      listed.data as { executions: { executionId: string; errorCount?: number }[] }
    ).executions.find((row) => row.executionId === executionId);
    expect(entry).toBeDefined();
    expect(entry!.errorCount).toBe(0);

    // A real refusal on the same node still is, so the check above is not passing by silence.
    const nextAttemptId = looped.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(nextAttemptId).toBeDefined();
    await requestContext.run({ userId: USER_ID }, () =>
      engine.executeStep(executionId, { done: "not a boolean" }, undefined, nextAttemptId!),
    );
    expect(await stepAttemptActions(executionId)).toContain(AuditAction.EXECUTION_STEP_ATTEMPT);
  });
});
