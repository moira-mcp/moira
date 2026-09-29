import { afterAll, afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  ExecutionNotificationRepository,
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  metadataRevision,
  user,
} from "@mcp-moira/shared";
import {
  adjustmentVisit,
  DatabaseRepository,
  recoverContinuation,
  getActiveCommunicationChannelRegistry,
  registerActiveCommunicationChannel,
  UserCommunicationService,
  unregisterActiveCommunicationChannel,
  WaitingNotificationSender,
  type PortableCommunicationMessage,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";

/**
 * «Waiting for you» notifications, observed where they live: the queue table the writers fill in
 * the transaction of the transition, and the text a capturing channel receives from the one sender.
 * Time is the sender's injected clock; nothing waits for real.
 */

const USER_ID = "waiting-notifications-user";
const MINUTE = 60_000;

type Engine = ReturnType<typeof MCPEngine.getInstance>;

interface GateOptions {
  gate?: Record<string, unknown> | null;
  firstStepGated?: boolean;
}

function graph(name: string, options: GateOptions = {}): WorkflowGraph {
  const gate = options.gate === undefined ? { label: "Approve the release plan" } : options.gate;
  return {
    metadata: { name, version: "1.0.0", description: "Waiting notification test" },
    nodes: [
      {
        type: "start",
        id: "start",
        connections: { default: options.firstStepGated ? "approve" : "draft" },
      },
      {
        type: "agent-directive",
        id: "draft",
        directive: "Draft the release plan",
        completionCondition: "Drafted",
        connections: { success: "approve" },
      },
      {
        type: "agent-directive",
        id: "approve",
        directive: "Present the plan and wait for the decision",
        completionCondition: "Decided",
        ...(gate ? { humanGate: gate } : {}),
        connections: { success: "finish" },
      },
      {
        type: "agent-directive",
        id: "finish",
        directive: "Finish",
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

function attemptIdOf(presentation: string): string {
  const value = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
  if (!value) throw new Error(`Missing step attempt: ${presentation}`);
  return value;
}

function session(params: Parameters<typeof getSessionInfo>[0]) {
  return requestContext.run({ userId: USER_ID }, () => getSessionInfo(params));
}

const queue = () => new ExecutionNotificationRepository(getDatabase());
const rows = (executionId: string) => queue().forExecution(executionId);

async function saveWorkflow(name: string, options?: GateOptions) {
  const repository = new DatabaseRepository();
  const saved = await getWorkflowService().save({
    graph: graph(name, options),
    userId: USER_ID,
    visibility: "private",
  });
  const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
  return { repository, stored, engine: MCPEngine.getInstance(repository) };
}

async function startRun(engine: Engine, stored: WorkflowGraph, note = "Release 4.2") {
  const executionId = await engine.executor.startWorkflow(stored, {}, USER_ID, note);
  const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
    userId: USER_ID,
    createPresentation: true,
  });
  return { executionId, presentation };
}

function agentStep(engine: Engine, executionId: string, presentation: string, input: unknown = {}) {
  return engine.executor.executeStep(executionId, input, undefined, {
    userId: USER_ID,
    attemptId: attemptIdOf(presentation),
  });
}

/** A run standing on the gate: started, and the agent stepped past the draft. */
async function runAtGate(name: string, options?: GateOptions) {
  const setup = await saveWorkflow(name, options);
  const { executionId, presentation } = await startRun(setup.engine, setup.stored);
  const atGate = await agentStep(setup.engine, executionId, presentation);
  return { ...setup, executionId, presentation, atGate };
}

describe("waiting-for-you notifications", () => {
  const delivered: Array<{ text: string }> = [];
  const channelId = `test.waiting-notifications.${Math.random().toString(36).slice(2)}`;
  let clock = 0;
  // The sender's communication service shares the injected clock, so its per-minute channel budget
  // moves with the test's time rather than the wall clock.
  const communication = new UserCommunicationService(
    getActiveCommunicationChannelRegistry(),
    {},
    () => clock,
  );
  const sender = () =>
    new WaitingNotificationSender(new DatabaseRepository(), queue(), {
      now: () => clock,
      communication,
    });

  beforeAll(async () => {
    await createUser(USER_ID);
    registerActiveCommunicationChannel({
      id: channelId,
      provider: channelId,
      capabilities: { text: true, image: true, document: true, trusted: false },
      metadata: { title: "Capturing", origin: "builtin", settingKeys: [] },
      isConfigured: async () => true,
      deliver: async (message: PortableCommunicationMessage) => {
        delivered.push({ text: message.text });
      },
    });
  });

  afterAll(() => {
    unregisterActiveCommunicationChannel(channelId);
  });

  afterEach(() => {
    MCPEngine.resetInstance();
    delivered.length = 0;
  });

  /** Set the sender's clock `offset` ms after now, past every row just queued. */
  function at(offset: number) {
    clock = Date.now() + 1_000 + offset;
  }

  /**
   * What this run's person received. The queue is shared with every other run in the test database,
   * and the sender serves them all, so each case reads only the messages that link to its own run.
   */
  function deliveredFor(executionId: string): string[] {
    return delivered
      .map((message) => message.text)
      .filter((text) => text.includes(`/executions/${executionId}`));
  }

  test("a step into a gate queues one notification; repeats queue none; the sender delivers it", async () => {
    const { engine, executionId, presentation } = await runAtGate("notify-step");
    expect(rows(executionId)).toEqual([
      expect.objectContaining({
        waitKey: expect.stringMatching(/^gate:\d+$/),
        kind: "first",
        state: "pending",
      }),
    ]);
    // A repeated presentation and a replay of the same attempt do not add a row.
    await session({ action: "current_step", executionId });
    await agentStep(engine, executionId, presentation);
    expect(rows(executionId)).toHaveLength(1);

    at(0);
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(1);
    expect(deliveredFor(executionId)[0]).toContain("notify-step · Release 4.2");
    expect(deliveredFor(executionId)[0]).toContain(`/executions/${executionId}`);
    expect(deliveredFor(executionId)[0]).toContain(
      "Waiting for your decision: Approve the release plan",
    );
    expect(rows(executionId)[0]).toEqual(
      expect.objectContaining({
        state: "sent",
        sentAt: clock,
        deliveryStatus: "delivered",
        deliveredChannels: [channelId],
      }),
    );
    // A second pass sends nothing more.
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(1);
  });

  test("a write refused by the revision guard queues nothing", async () => {
    const { repository, stored } = await saveWorkflow("notify-refused-write");
    const { engine } = { engine: MCPEngine.getInstance(repository) };
    const { executionId } = await startRun(engine, stored);
    const loaded = (await repository.getExecution(executionId))!;
    const moved: WorkflowExecution = {
      ...loaded,
      revision: loaded.revision - 1,
      currentNodeId: "approve",
      waitingForInputNodeId: "approve",
      gateWaiting: true,
    };
    await expect(repository.saveExecution(moved)).rejects.toThrow("Execution state changed");
    expect(rows(executionId)).toEqual([]);
  });

  test("notify: off queues nothing", async () => {
    const { executionId } = await runAtGate("notify-off", {
      gate: { label: "Approve", notify: "off" },
    });
    expect(rows(executionId)).toEqual([]);
  });

  test("notify: off with remindAfter queues only the reminder, delivered once when due", async () => {
    const { executionId } = await runAtGate("notify-off-remind", {
      gate: { label: "Approve the release plan", notify: "off", remindAfter: "30m" },
    });
    const [reminder] = rows(executionId);
    expect(rows(executionId)).toEqual([
      expect.objectContaining({ kind: "remind", state: "pending", waitKey: reminder.waitKey }),
    ]);
    expect(reminder.waitKey).toMatch(/^gate:\d+$/);
    expect(reminder.notBefore - reminder.createdAt).toBe(30 * MINUTE);

    // The flow sends its own first message; until the reminder is due the page has nothing to add.
    clock = reminder.notBefore - MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([]);
    expect(queue().latestForCurrentWait(executionId, clock)).toBeNull();

    clock = reminder.notBefore;
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([
      expect.stringContaining("Reminder — Waiting for your decision: Approve the release plan"),
    ]);
    expect(queue().latestForCurrentWait(executionId, clock)).toEqual(
      expect.objectContaining({ kind: "remind", state: "sent" }),
    );

    clock = reminder.notBefore + 5 * 60 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(1);
    expect(rows(executionId).map((row) => [row.kind, row.state])).toEqual([["remind", "sent"]]);
  });

  test("notify: off — a run that leaves the step before the reminder is due is not reminded", async () => {
    const { engine, executionId, atGate } = await runAtGate("notify-off-left", {
      gate: { label: "Approve", notify: "off", remindAfter: "30m" },
    });
    const [reminder] = rows(executionId);
    await agentStep(engine, executionId, atGate);
    clock = reminder.notBefore + MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([]);
    expect(rows(executionId).map((row) => [row.kind, row.state])).toEqual([
      ["remind", "superseded"],
    ]);
  });

  test("a version that marks a step a run has long stood on reminds remindAfter after the update, not at once", async () => {
    const { stored, executionId } = await runAtGate("notify-off-version", { gate: null });
    // The run arrived two days ago: a reminder counted from its arrival would be overdue already.
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * MINUTE;
    const sqlite = getSqliteInstance();
    const row = sqlite
      .prepare("SELECT visits FROM workflowExecution WHERE executionId = ?")
      .get(executionId) as { visits: string };
    const visits = (JSON.parse(row.visits) as Array<Record<string, unknown>>).map((visit) => ({
      ...visit,
      ...(visit.enteredAt ? { enteredAt: twoDaysAgo } : {}),
      ...(visit.leftAt ? { leftAt: twoDaysAgo } : {}),
    }));
    sqlite
      .prepare("UPDATE workflowExecution SET visits = ?, updatedAt = ? WHERE executionId = ?")
      .run(JSON.stringify(visits), twoDaysAgo, executionId);

    const updatedAt = Date.now();
    const marked = graph("notify-off-version", {
      gate: { label: "Approve the release plan", notify: "off", remindAfter: "1d" },
    });
    await getWorkflowService().save({
      graph: { ...marked, id: stored.id, metadata: { ...marked.metadata, version: "1.1.0" } },
      userId: USER_ID,
      visibility: "private",
    });

    const [reminder] = rows(executionId);
    expect(rows(executionId)).toEqual([
      expect.objectContaining({ kind: "remind", state: "pending" }),
    ]);
    expect(reminder.createdAt).toBeGreaterThanOrEqual(updatedAt);
    expect(reminder.notBefore).toBe(reminder.createdAt + 24 * 60 * MINUTE);

    clock = updatedAt + MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([]);
  });

  test.each([
    [
      "a start whose first step is the gate",
      async () => {
        const { stored } = await saveWorkflow("notify-start", { firstStepGated: true });
        const prepared = await requestContext.run({ userId: USER_ID }, () =>
          startWorkflow({
            action: "prepare",
            workflowId: stored.id!,
            parentExecutionId: "none",
            skipNotificationCheck: true,
          }),
        );
        const startAttemptId = prepared.data!.match(/Start attempt ID:\s*([a-f0-9-]+)/i)![1];
        const started = await requestContext.run({ userId: USER_ID }, () =>
          startWorkflow({ action: "execute", startAttemptId }),
        );
        return started.data!.match(/Process ID:\s*([a-f0-9-]+)/i)![1];
      },
    ],
    [
      "a run-page answer that moves the run into the gate",
      async () => {
        const { engine, stored } = await saveWorkflow("notify-page-answer");
        const { executionId } = await startRun(engine, stored);
        await engine.executor.executeStep(executionId, {}, undefined, {
          userId: USER_ID,
          answeredBy: { role: "user", userId: USER_ID },
          createPresentation: true,
        });
        return executionId;
      },
    ],
    [
      "a recovery onto the gate",
      async () => {
        const { repository, engine, stored } = await saveWorkflow("notify-recover");
        const { executionId } = await startRun(engine, stored);
        await repository.saveWorkflow(
          {
            ...stored,
            nodes: stored.nodes.map((node) =>
              node.id === "draft" ? { ...node, directive: "Draft something else" } : node,
            ),
          },
          USER_ID,
        );
        const result = await session({ action: "recover", executionId, nodeId: "approve" });
        expect(result.success).toBe(true);
        return executionId;
      },
    ],
    [
      "a new version that marks the step the run stands on",
      async () => {
        const { stored, executionId } = await runAtGate("notify-version", { gate: null });
        expect(rows(executionId)).toEqual([]);
        const marked = graph("notify-version");
        await getWorkflowService().save({
          graph: { ...marked, id: stored.id, metadata: { ...marked.metadata, version: "1.1.0" } },
          userId: USER_ID,
          visibility: "private",
        });
        return executionId;
      },
    ],
  ])("%s queues the gate notification", async (_case, arrive) => {
    const executionId = await arrive();
    expect(rows(executionId)).toEqual([
      expect.objectContaining({ waitKey: expect.stringMatching(/^gate:\d+$/), kind: "first" }),
    ]);
  });

  test("the agent's question is queued under its id and sent with its choices", async () => {
    const { executionId } = await runAtGate("notify-question", { gate: null });
    await session({
      action: "await-user",
      executionId,
      question: "Which region should the release go to first?",
      options: ["Europe", "Asia"],
    });
    const [row] = rows(executionId);
    const stored = getSqliteInstance()
      .prepare("SELECT awaitingUser FROM workflowExecution WHERE executionId = ?")
      .get(executionId) as { awaitingUser: string };
    expect(row.waitKey).toBe(`agent:${JSON.parse(stored.awaitingUser).id}`);

    at(0);
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(1);
    expect(deliveredFor(executionId)[0]).toContain(
      "The agent is asking you: Which region should the release go to first?",
    );
    expect(deliveredFor(executionId)[0]).toContain("• Europe");
    expect(deliveredFor(executionId)[0]).toContain("• Asia");
  });

  test("a second question sooner than ten minutes waits for its turn", async () => {
    const { executionId } = await runAtGate("notify-question-pause", { gate: null });
    await session({ action: "await-user", executionId, question: "First question?" });
    at(0);
    const firstSentAt = clock;
    await sender().tick();
    await session({ action: "await-user", executionId, question: "Second question?" });

    at(1 * MINUTE);
    clock = firstSentAt + 1 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([expect.stringContaining("First question?")]);
    expect(rows(executionId)[1]).toEqual(
      expect.objectContaining({ state: "pending", notBefore: firstSentAt + 10 * MINUTE }),
    );

    clock = firstSentAt + 10 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(2);
    expect(deliveredFor(executionId)[1]).toContain("Second question?");
  });

  test("the page shows a first notification that is waiting out the question pause", async () => {
    const { executionId } = await runAtGate("notify-page-held", { gate: null });
    await session({ action: "await-user", executionId, question: "First?" });
    at(0);
    await sender().tick();
    await session({ action: "await-user", executionId, question: "Second?" });
    clock += MINUTE;
    await sender().tick();
    expect(queue().latestForCurrentWait(executionId, clock)).toEqual(
      expect.objectContaining({ kind: "first", state: "pending" }),
    );
  });

  test("a version that marks a step while the agent's question is open still queues the gate", async () => {
    const { stored, executionId } = await runAtGate("notify-mark-under-question", { gate: null });
    await session({ action: "await-user", executionId, question: "Anything to add?" });
    const marked = graph("notify-mark-under-question");
    await getWorkflowService().save({
      graph: { ...marked, id: stored.id, metadata: { ...marked.metadata, version: "1.1.0" } },
      userId: USER_ID,
      visibility: "private",
    });
    expect(
      rows(executionId)
        .map((row) => row.waitKey.split(":")[0])
        .sort(),
    ).toEqual(["agent", "gate"]);
  });

  test("a row that cannot be handled does not stop the others", async () => {
    const broken = await runAtGate("notify-broken-row");
    const healthy = await runAtGate("notify-healthy-row");
    const failing = new (class extends DatabaseRepository {
      override async getWorkflowGraph(workflowId: string, userId: string) {
        if (workflowId === broken.stored.id) throw new Error("unreadable definition");
        return super.getWorkflowGraph(workflowId, userId);
      }
    })();
    at(0);
    await new WaitingNotificationSender(failing, queue(), {
      now: () => clock,
      communication,
    }).tick();
    expect(deliveredFor(healthy.executionId)).toHaveLength(1);
    expect(rows(broken.executionId)[0]).toEqual(
      expect.objectContaining({ state: "pending", notBefore: expect.any(Number) }),
    );
    expect(rows(broken.executionId)[0].notBefore).toBeGreaterThan(clock);
  });

  test("a gate waiting past remindAfter gets exactly one reminder", async () => {
    const { executionId } = await runAtGate("notify-remind", {
      gate: { label: "Approve the release plan", remindAfter: "30m" },
    });
    at(0);
    const sentAt = clock;
    await sender().tick();
    // The reminder is queued already, but the page still reports the sent notification.
    expect(queue().latestForCurrentWait(executionId, sentAt + MINUTE)).toEqual(
      expect.objectContaining({ kind: "first", state: "sent" }),
    );
    clock = sentAt + 29 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(1);

    clock = sentAt + 30 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(2);
    expect(deliveredFor(executionId)[1]).toContain(
      "Reminder — Waiting for your decision: Approve the release plan",
    );

    clock = sentAt + 5 * 60 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toHaveLength(2);
    expect(rows(executionId).map((row) => [row.kind, row.state])).toEqual([
      ["first", "sent"],
      ["remind", "sent"],
    ]);
  });

  test("a backlog of settled gate notifications does not stop the reminder of a fresh wait", async () => {
    // Sixty gates whose notification was sent and whose wait then ended (the ordinary outcome), and
    // one fresh gate that is still waiting past its remindAfter.
    for (let index = 0; index < 60; index++) {
      const settled = await runAtGate(`notify-settled-${index}`, {
        gate: { label: "Approve", remindAfter: "30m" },
      });
      at(0);
      await sender().tick();
      await agentStep(settled.engine, settled.executionId, settled.atGate);
    }
    const { executionId } = await runAtGate("notify-remind-behind-backlog", {
      gate: { label: "Approve the release plan", remindAfter: "30m" },
    });
    // The backlog spent the person's per-minute channel budget; the first notification goes out
    // once the window has passed, and its reminder 30 minutes after that.
    at(2 * MINUTE);
    await sender().tick();
    const first = rows(executionId).find((row) => row.kind === "first")!;
    expect(first.state).toBe("sent");
    clock = first.sentAt! + 31 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([
      expect.stringContaining("Waiting for your decision"),
      expect.stringContaining("Reminder — Waiting for your decision"),
    ]);
  });

  test("a gate notification is still sent while the agent's question on that step is open", async () => {
    const { executionId } = await runAtGate("notify-gate-under-question");
    await session({ action: "await-user", executionId, question: "Anything to add?" });
    at(0);
    await sender().tick();
    await session({ action: "await-user", executionId, resolve: true });
    // Both waits were real when the sender ran: the gate's notification is not lost to the question.
    expect(deliveredFor(executionId)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Waiting for your decision: Approve the release plan"),
        expect.stringContaining("The agent is asking you: Anything to add?"),
      ]),
    );
  });

  test("a notification refused for the person's channel budget is tried again after the window", async () => {
    const tight = new UserCommunicationService(
      getActiveCommunicationChannelRegistry(),
      { maxRequestsPerWindow: 1 },
      () => clock,
    );
    const tightSender = () =>
      new WaitingNotificationSender(new DatabaseRepository(), queue(), {
        now: () => clock,
        communication: tight,
      });
    const one = await runAtGate("notify-budget-one");
    const two = await runAtGate("notify-budget-two");
    at(0);
    await tightSender().tick();
    const sentNow = [one.executionId, two.executionId].filter(
      (id) => deliveredFor(id).length === 1,
    );
    expect(sentNow).toHaveLength(1);
    const heldId = sentNow[0] === one.executionId ? two.executionId : one.executionId;
    expect(rows(heldId)[0]).toEqual(expect.objectContaining({ state: "pending" }));

    clock += 61_000;
    await tightSender().tick();
    expect(deliveredFor(heldId)).toHaveLength(1);
    expect(rows(heldId)[0]).toEqual(
      expect.objectContaining({ state: "sent", deliveryStatus: "delivered" }),
    );
  });

  test("a gate reached by recovery keeps its notifications through a variable edit", async () => {
    const { repository, stored } = await saveWorkflow("notify-recover-edit", {
      gate: { label: "Approve the release plan", remindAfter: "30m" },
    });
    const engine = MCPEngine.getInstance(repository);
    const { executionId } = await startRun(engine, stored);
    await repository.saveWorkflow(
      {
        ...stored,
        nodes: stored.nodes.map((node) =>
          node.id === "draft" ? { ...node, directive: "Draft something else" } : node,
        ),
      },
      USER_ID,
    );
    expect((await session({ action: "recover", executionId, nodeId: "approve" })).success).toBe(
      true,
    );
    at(0);
    const sentAt = clock;
    await sender().tick();
    // A person edits a variable on the run page while the run keeps waiting at the gate.
    const run = (await repository.getExecution(executionId))!;
    await repository.updateExecutionContext(
      executionId,
      { variables: { note_for_review: "later" } },
      run.revision,
      metadataRevision(run.globalContext),
      adjustmentVisit(run, { note_for_review: "later" }, { role: "user", userId: USER_ID }),
    );
    clock = sentAt + 31 * MINUTE;
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([
      expect.stringContaining("Waiting for your decision"),
      expect.stringContaining("Reminder — Waiting for your decision"),
    ]);
    expect(rows(executionId).filter((row) => row.kind === "first")).toHaveLength(1);
  });

  test("recovery records the arrival, so the gate's wait key survives an adjustment even before any presentation", async () => {
    const { repository, stored } = await saveWorkflow("notify-recover-key", {
      gate: { label: "Approve the release plan", remindAfter: "30m" },
    });
    const engine = MCPEngine.getInstance(repository);
    const { executionId } = await startRun(engine, stored);
    await repository.saveWorkflow(
      {
        ...stored,
        nodes: stored.nodes.map((node) =>
          node.id === "draft" ? { ...node, directive: "Draft something else" } : node,
        ),
      },
      USER_ID,
    );
    // Recover without rendering a presentation afterwards (the part that could append a visit).
    const outcome = await recoverContinuation(
      repository,
      (await repository.getExecution(executionId))!,
      "approve",
      {},
      async () => "",
    );
    expect(outcome.outcome).toBe("recovered");
    const [queued] = rows(executionId);
    const run = (await repository.getExecution(executionId))!;
    await repository.updateExecutionContext(
      executionId,
      { variables: { note_for_review: "later" } },
      run.revision,
      metadataRevision(run.globalContext),
      adjustmentVisit(run, { note_for_review: "later" }, { role: "user", userId: USER_ID }),
    );
    expect(queue().holdsWait(executionId, queued.waitKey)).toBe(true);
    expect(queue().currentWaitKey(executionId)).toBe(queued.waitKey);
  });

  test("recovering a run onto the gate it already stands on keeps its one notification", async () => {
    const { repository, stored, executionId } = await runAtGate("notify-recover-in-place", {
      gate: { label: "Approve the release plan", remindAfter: "30m" },
    });
    const before = (await repository.getExecution(executionId))!;
    // A new wording of the gated step blocks the paused attempt; the owner recovers onto the same step.
    await repository.saveWorkflow(
      {
        ...stored,
        nodes: stored.nodes.map((node) =>
          node.id === "approve" ? { ...node, directive: "Present the revised plan" } : node,
        ),
      },
      USER_ID,
    );
    expect((await session({ action: "recover", executionId, nodeId: "approve" })).success).toBe(
      true,
    );
    const after = (await repository.getExecution(executionId))!;
    expect(after.visits).toHaveLength(before.visits!.length);
    expect(rows(executionId).filter((row) => row.kind === "first")).toHaveLength(1);
  });

  test("a notification whose wait ended before it was sent is dropped, not delivered", async () => {
    const { engine, executionId, atGate } = await runAtGate("notify-superseded");
    await agentStep(engine, executionId, atGate);
    at(0);
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([]);
    expect(rows(executionId)[0].state).toBe("superseded");
  });

  test("a question replaced before it was sent is dropped; only the current one is delivered", async () => {
    const { executionId } = await runAtGate("notify-question-replaced", { gate: null });
    await session({ action: "await-user", executionId, question: "Old question?" });
    await session({ action: "await-user", executionId, question: "New question?" });
    at(0);
    await sender().tick();
    expect(deliveredFor(executionId)).toEqual([expect.stringContaining("New question?")]);
    expect(rows(executionId).map((row) => row.state)).toEqual(["superseded", "sent"]);
  });

  test("without configured channels the row records that nobody could be told", async () => {
    unregisterActiveCommunicationChannel(channelId);
    try {
      const { executionId } = await runAtGate("notify-no-channels");
      at(0);
      await sender().tick();
      expect(rows(executionId)[0]).toEqual(
        expect.objectContaining({ state: "sent", deliveryStatus: "no_configured_channels" }),
      );
      expect(queue().latestForCurrentWait(executionId)).toEqual(
        expect.objectContaining({ deliveryStatus: "no_configured_channels" }),
      );
    } finally {
      registerActiveCommunicationChannel({
        id: channelId,
        provider: channelId,
        capabilities: { text: true, image: true, document: true, trusted: false },
        metadata: { title: "Capturing", origin: "builtin", settingKeys: [] },
        isConfigured: async () => true,
        deliver: async (message: PortableCommunicationMessage) => {
          delivered.push({ text: message.text });
        },
      });
    }
  });
});
