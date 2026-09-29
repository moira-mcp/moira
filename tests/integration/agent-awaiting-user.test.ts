import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  metadataRevision,
  user,
} from "@mcp-moira/shared";
import {
  adjustmentVisit,
  DatabaseRepository,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

/**
 * The agent's open question (`session await-user`) is cleared by who acts, not by how the row is
 * written: the agent's own actions clear it, a person's edits do not, and the run leaving the node
 * the question was asked on clears it by any path. Every case reads the stored row, and each would
 * fail on an implementation that cleared always or never.
 */

const USER_ID = "agent-awaiting-user";

type Engine = ReturnType<typeof MCPEngine.getInstance>;

function graph(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: "Agent question test" },
    variableRegistry: {
      target: { type: "string", description: "Where the release goes", default: "staging" },
    },
    runtimePolicy: { externalVariableWrites: { target: { allowedNodeIds: ["ask"] } } },
    nodes: [
      { type: "start", id: "start", connections: { default: "ask" } },
      {
        type: "agent-directive",
        id: "ask",
        directive: "Prepare the release",
        completionCondition: "Prepared",
        inputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
        connections: { success: "finish" },
      },
      {
        type: "agent-directive",
        id: "finish",
        directive: "Finish the release",
        completionCondition: "Finished",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

async function createUser(id: string): Promise<void> {
  const now = new Date().toISOString();
  await getDatabase()
    .insert(user)
    .values({ id, email: `${id}@example.test`, handle: id, createdAt: now, updatedAt: now })
    .onConflictDoNothing();
}

function stored(executionId: string) {
  const row = getSqliteInstance()
    .prepare(
      "SELECT awaitingUser, revision, currentNodeId, state FROM workflowExecution WHERE executionId = ?",
    )
    .get(executionId) as
    | { awaitingUser: string | null; revision: number; currentNodeId: string | null; state: string }
    | undefined;
  if (!row) throw new Error(`Execution ${executionId} is not stored`);
  return {
    ...row,
    awaitingUser: row.awaitingUser
      ? (JSON.parse(row.awaitingUser) as NonNullable<WorkflowExecution["awaitingUser"]>)
      : null,
  };
}

function attemptIdOf(presentation: string): string {
  const value = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
  if (!value) throw new Error(`Missing step attempt: ${presentation}`);
  return value;
}

function session(params: Parameters<typeof getSessionInfo>[0]) {
  return requestContext.run({ userId: USER_ID }, () => getSessionInfo(params));
}

async function runAtQuestion(name: string) {
  const repository = new DatabaseRepository();
  const saved = await getWorkflowService().save({
    graph: graph(name),
    userId: USER_ID,
    visibility: "private",
  });
  const definition = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
  const engine = MCPEngine.getInstance(repository);
  const executionId = await engine.executor.startWorkflow(definition, {}, USER_ID);
  const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
    userId: USER_ID,
    createPresentation: true,
  });
  const raised = await session({
    action: "await-user",
    executionId,
    question: "Which environment should the release go to?",
    options: ["staging", "production"],
  });
  expect(raised.success).toBe(true);
  expect(stored(executionId).awaitingUser).toEqual(
    expect.objectContaining({
      nodeId: "ask",
      question: "Which environment should the release go to?",
    }),
  );
  return { repository, engine, executionId, presentation };
}

function agentStep(engine: Engine, executionId: string, presentation: string, input: unknown) {
  return engine.executor.executeStep(executionId, input, undefined, {
    userId: USER_ID,
    attemptId: attemptIdOf(presentation),
  });
}

function pageAnswer(engine: Engine, executionId: string, input: unknown) {
  return engine.executor.executeStep(executionId, input, undefined, {
    userId: USER_ID,
    answeredBy: { role: "user", userId: USER_ID },
    createPresentation: true,
  });
}

describe("session await-user", () => {
  beforeAll(async () => {
    await createUser(USER_ID);
  });

  afterEach(() => MCPEngine.resetInstance());

  test("raising keeps the step generation, so the agent's presented attempt still steps", async () => {
    const { engine, executionId, presentation } = await runAtQuestion("await-raise");
    const before = stored(executionId);
    expect(before.awaitingUser).toEqual({
      id: expect.any(String),
      nodeId: "ask",
      question: "Which environment should the release go to?",
      options: ["staging", "production"],
      since: expect.any(Number),
    });
    // The revision is the one the attempt was presented at.
    await agentStep(engine, executionId, presentation, { answer: "staging" });
    expect(stored(executionId)).toEqual(
      expect.objectContaining({ currentNodeId: "finish", awaitingUser: null }),
    );
    expect(stored(executionId).revision).toBe(before.revision + 1);
  });

  test("a second raise replaces the question with a new id; resolve clears it", async () => {
    const { executionId } = await runAtQuestion("await-replace");
    const first = stored(executionId).awaitingUser!;
    await session({ action: "await-user", executionId, question: "Is the date fixed?" });
    const second = stored(executionId).awaitingUser!;
    expect(second.id).not.toBe(first.id);
    expect(second.question).toBe("Is the date fixed?");
    expect(second.options).toBeUndefined();

    await session({ action: "await-user", executionId, resolve: true });
    expect(stored(executionId).awaitingUser).toBeNull();
  });

  test("the agent's refused step clears it: the agent is acting again", async () => {
    const { engine, executionId, presentation } = await runAtQuestion("await-agent-refused");
    await agentStep(engine, executionId, presentation, {});
    expect(stored(executionId)).toEqual(
      expect.objectContaining({ currentNodeId: "ask", awaitingUser: null }),
    );
  });

  test("a variable the agent sets clears it; a person's variable edit keeps it", async () => {
    const person = await runAtQuestion("await-person-edit");
    const execution = (await person.repository.getExecution(person.executionId))!;
    await person.repository.updateExecutionContext(
      person.executionId,
      { variables: { target: "production" } },
      execution.revision,
      metadataRevision(execution.globalContext),
      adjustmentVisit(execution, { target: "production" }, { role: "user", userId: USER_ID }),
    );
    expect(stored(person.executionId).awaitingUser).not.toBeNull();

    const agent = await runAtQuestion("await-agent-variable");
    const current = (await agent.repository.getExecution(agent.executionId))!;
    const result = await session({
      action: "set-variable",
      executionId: agent.executionId,
      variableName: "target",
      variableValue: "production",
      expectedRevision: current.revision,
      expectedContextRevision: metadataRevision(current.globalContext),
    });
    expect(result.success).toBe(true);
    expect(stored(agent.executionId).awaitingUser).toBeNull();
  });

  test("a run-page answer clears it only when the run leaves the question's node", async () => {
    const refused = await runAtQuestion("await-page-refused");
    await pageAnswer(refused.engine, refused.executionId, {});
    expect(stored(refused.executionId)).toEqual(
      expect.objectContaining({ currentNodeId: "ask", awaitingUser: expect.any(Object) }),
    );

    const accepted = await runAtQuestion("await-page-accepted");
    await pageAnswer(accepted.engine, accepted.executionId, { answer: "production" });
    expect(stored(accepted.executionId)).toEqual(
      expect.objectContaining({ currentNodeId: "finish", awaitingUser: null }),
    );
  });

  test("a writer holding a copy loaded before the question does not erase it", async () => {
    const { repository, executionId } = await runAtQuestion("await-stale-writer");
    await session({ action: "await-user", executionId, resolve: true });
    const loaded = (await repository.getExecution(executionId))!;
    await session({ action: "await-user", executionId, question: "Raised after the load" });
    await repository.saveExecution({ ...loaded, note: "written by a writer that loaded earlier" });
    expect(stored(executionId).awaitingUser).toEqual(
      expect.objectContaining({ question: "Raised after the load" }),
    );
  });

  test("recovery, cancellation and completion clear it", async () => {
    const recovered = await runAtQuestion("await-recover");
    // Break the run the way a deploy can, so recovery is allowed.
    const recoveredDefinition = (await recovered.repository.getWorkflowGraph(
      (await recovered.repository.getExecution(recovered.executionId))!.workflowId,
      USER_ID,
    ))!;
    await recovered.repository.saveWorkflow(
      {
        ...recoveredDefinition,
        nodes: recoveredDefinition.nodes.map((node) =>
          node.id === "ask" ? { ...node, directive: "Prepare something else" } : node,
        ),
      },
      USER_ID,
    );
    const recovery = await session({
      action: "recover",
      executionId: recovered.executionId,
      nodeId: "ask",
    });
    expect(recovery.success).toBe(true);
    expect(stored(recovered.executionId).awaitingUser).toBeNull();

    const cancelled = await runAtQuestion("await-cancel");
    await cancelled.engine.executor.cancelExecution(cancelled.executionId);
    expect(stored(cancelled.executionId)).toEqual(
      expect.objectContaining({ state: "completed", awaitingUser: null }),
    );

    const completed = await runAtQuestion("await-complete");
    const atFinish = await agentStep(
      completed.engine,
      completed.executionId,
      completed.presentation,
      {
        answer: "staging",
      },
    );
    await session({ action: "await-user", executionId: completed.executionId, question: "Done?" });
    await agentStep(completed.engine, completed.executionId, atFinish, {});
    expect(stored(completed.executionId)).toEqual(
      expect.objectContaining({ state: "completed", awaitingUser: null }),
    );
  });

  test("it is refused on a finished run, for another user's run, and with mixed modes", async () => {
    const { engine, executionId } = await runAtQuestion("await-refusals");
    const mixed = await session({
      action: "await-user",
      executionId,
      question: "Both?",
      resolve: true,
    });
    expect(mixed.success).toBe(false);
    const empty = await session({ action: "await-user", executionId });
    expect(empty.success).toBe(false);

    const foreign = await requestContext.run({ userId: "someone-else" }, () =>
      getSessionInfo({ action: "await-user", executionId, question: "Mine?" }),
    );
    expect(foreign.success).toBe(false);

    await engine.executor.cancelExecution(executionId);
    const finished = await session({ action: "await-user", executionId, question: "Still there?" });
    expect(finished.success).toBe(false);
    expect(stored(executionId).awaitingUser).toBeNull();
  });
});
