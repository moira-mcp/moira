/**
 * The picture a notification attaches reads on a phone: the run as a list of its blocks, drawn at
 * the phone width at the phone type scale, never scaled — unlike the map, whose cards and lanes
 * are several times wider than a phone and get shrunk below legibility.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import sharp from "sharp";
import {
  AgentMessageQueue,
  PROGRESS_STEPS_DENSITY,
  PROGRESS_STEPS_WIDTH,
  TelegramNotificationHandler,
  UserNotificationHandler,
  buildExecutionProgressVisualModel,
  buildProgressStepsModel,
  progressTextWidth,
  projectExecutionRun,
  renderExecutionProgressStepsImage,
  resetClientFactory,
  setTestClientFactory,
  type IDataRepository,
  type IGraphExecutionEngine,
  type ProgressStepsModel,
  type ProgressStepsText,
  type UserCommunicationService,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

/** Every text of a picture is at least this many CSS pixels when a 390 px wide phone shows it. */
const LEGIBLE_PX = 11;
const PHONE_PX = 390;

function run(graph: WorkflowGraph, visits: WorkflowExecution["visits"], variables = {}) {
  const last = visits![visits!.length - 1];
  return {
    executionId: "run",
    workflowId: graph.id ?? "wf",
    userId: "user",
    status: "running",
    revision: 1,
    workflowVersion: graph.metadata.version,
    currentNodeId: last.nodeId,
    waitingForInputNodeId: last.waited && last.exitKey === null ? last.nodeId : null,
    note: "Ship the notification headings",
    globalContext: { variables, nodeStates: {} },
    visits,
  } as unknown as WorkflowExecution;
}

/** A long non-standard flow: twenty blocks in a chain, every other one returning to the start. */
function longFlow(label = (index: number) => `Stage ${index + 1}`): WorkflowGraph {
  const count = 20;
  const ids = Array.from({ length: count }, (_, index) => `b${index}`);
  return {
    id: "long-flow",
    metadata: { name: "Long", version: "1.0.0", description: "Twenty stages" },
    variableRegistry: {
      items: { type: "array", description: "work items", default: [] },
      cursor: { type: "number", description: "1-based", default: 1 },
    },
    progress: {
      nodes: ids.map((id, index) => ({
        id,
        label: label(index),
        ...(index === 1 ? { list: { items: "items", title: "title", current: "cursor" } } : {}),
      })),
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "b0", connections: { default: "s0" } },
      ...ids.map((id, index) => ({
        id: `s${index}`,
        type: "agent-directive",
        progressNodeId: id,
        directive: "Do it",
        completionCondition: "Done",
        inputSchema: { type: "object", properties: {}, globalInputs: ["items", "cursor"] },
        connections: {
          success: index === count - 1 ? "end" : `s${index + 1}`,
          ...(index % 2 === 1 ? { retry: "s0" } : {}),
        },
        connectionLabels: index % 2 === 1 ? { retry: "again" } : {},
      })),
      { id: "end", type: "end", progressNodeId: ids[count - 1] },
    ],
  } as unknown as WorkflowGraph;
}

function texts(model: ProgressStepsModel): ProgressStepsText[] {
  return [
    model.header,
    ...model.rows.flatMap((row) => [row.title, ...(row.list ? [row.list] : [])]),
  ];
}

function fontSizes(model: ProgressStepsModel): number[] {
  return [
    ...texts(model).map((text) => text.fontSize),
    ...model.rows.map((row) => row.chip.fontSize),
  ];
}

const sdf = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      "workflows/production/flows/91b11263-a180-4a08-9399-55f406f82c69.json",
    ),
    "utf8",
  ),
) as WorkflowGraph;

describe("legibility", () => {
  test.each([
    ["a long non-standard flow", longFlow()],
    ["the Software Development Flow", sdf],
  ])("%s: every text reads on a phone and nothing is scaled", async (_name, graph) => {
    const start = graph.nodes.find((node) => node.type === "start")!;
    const progress = projectExecutionRun(
      graph,
      run(graph, [{ seq: 0, nodeId: start.id, exitKey: null, changes: {} }]),
    )!;
    const steps = buildProgressStepsModel(progress);
    expect(steps.width).toBe(PROGRESS_STEPS_WIDTH);
    expect(steps.rows).toHaveLength(progress.nodes.length);
    for (const size of fontSizes(steps)) {
      expect((size * PHONE_PX) / steps.width).toBeGreaterThanOrEqual(LEGIBLE_PX);
    }
    // A long flow makes the picture taller, not smaller.
    expect(steps.height).toBeGreaterThan(steps.rows.length * 60);

    // The map a notification used to attach fails the same check: shrunk to fit its width.
    const map = await buildExecutionProgressVisualModel(progress, {});
    const smallest = Math.min(map.type.label, map.type.badge, map.type.content);
    expect((smallest * map.diagram.scale * PHONE_PX) / map.width).toBeLessThan(LEGIBLE_PX);
  });
});

describe("overflow", () => {
  test("an over-long title and current item are shortened inside their row and the picture", () => {
    // Block labels are capped at 200 characters; 130 still take far more than two phone lines.
    const words = "Reconcile the imported ledger entries against the bank statement ".repeat(2);
    const graph = longFlow((index) => (index === 1 ? words.trim() : `Stage ${index + 1}`));
    const items = [{ title: words }, { title: "Short" }];
    const progress = projectExecutionRun(
      graph,
      run(
        graph,
        [
          { seq: 0, nodeId: "start", exitKey: "default", changes: { items } },
          { seq: 1, nodeId: "s0", exitKey: "success", changes: {}, waited: true },
          { seq: 2, nodeId: "s1", exitKey: null, changes: {}, waited: true },
        ],
        { items, cursor: 1 },
      ),
    )!;
    const steps = buildProgressStepsModel(progress);
    const row = steps.rows[1];
    expect(row.title.lines).toHaveLength(2);
    expect(row.title.lines[1].endsWith("…")).toBe(true);
    expect(row.list!.lines).toHaveLength(2);
    expect(row.list!.lines[1].endsWith("…")).toBe(true);
    for (const current of steps.rows) {
      expect(current.x + current.width).toBeLessThanOrEqual(steps.width);
      expect(current.y + current.height).toBeLessThanOrEqual(steps.height);
      for (const text of [current.title, ...(current.list ? [current.list] : [])]) {
        expect(text.x + text.maxWidth).toBeLessThanOrEqual(current.x + current.width);
        expect(text.y + text.lines.length * text.lineHeight).toBeLessThanOrEqual(
          current.y + current.height,
        );
        for (const line of text.lines) {
          expect(progressTextWidth(line, text.fontSize, text.weight)).toBeLessThanOrEqual(
            text.maxWidth,
          );
        }
      }
      expect(current.chip.x + current.chip.width).toBeLessThanOrEqual(current.x + current.width);
    }
  });
});

describe("state", () => {
  test("the active and waiting rows and the bound block's current item follow the run", () => {
    const graph = longFlow();
    const items = [{ title: "Parse" }, { title: "Ship" }];
    const onItem = projectExecutionRun(
      graph,
      run(
        graph,
        [
          { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
          { seq: 1, nodeId: "s0", exitKey: "success", changes: { items }, waited: true },
          { seq: 2, nodeId: "s1", exitKey: null, changes: { cursor: 2 } },
        ],
        { items, cursor: 2 },
      ),
    )!;
    const active = buildProgressStepsModel(onItem);
    expect(active.rows.map((row) => row.tone).slice(0, 3)).toEqual(["done", "active", "neutral"]);
    expect(active.rows[1].chip.text).toBe("agent on the step");
    expect(active.rows[1].list!.lines).toEqual(["1/2: Ship"]);

    const waiting = buildProgressStepsModel(
      projectExecutionRun(
        graph,
        run(
          graph,
          [
            { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
            { seq: 1, nodeId: "s0", exitKey: null, changes: {}, waited: true },
          ],
          {},
        ),
      )!,
    );
    expect(waiting.rows[0].tone).toBe("waiting");
  });

  /** The long flow with a PIN gate in the first block: a pause a person clears. */
  function gated(): WorkflowGraph {
    const graph = longFlow();
    graph.nodes.splice(1, 0, {
      id: "gate",
      type: "lock",
      progressNodeId: "b0",
      reason: "Approve",
      connections: { unlocked: "s0" },
    } as never);
    return graph;
  }

  test.each([
    [
      "the agent's wait",
      longFlow(),
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
        { seq: 1, nodeId: "s0", exitKey: null, changes: {}, waited: true },
      ],
      0,
      "agent on the step",
    ],
    [
      "a person's wait at a lock",
      gated(),
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
        { seq: 1, nodeId: "gate", exitKey: null, changes: {}, waited: true },
      ],
      0,
      "waiting for you",
    ],
    [
      "a block passed twice",
      longFlow(),
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
        { seq: 1, nodeId: "s0", exitKey: "success", changes: {}, waited: true },
        { seq: 2, nodeId: "s1", exitKey: "retry", changes: {}, waited: true },
        { seq: 3, nodeId: "s0", exitKey: "success", changes: {}, waited: true },
        { seq: 4, nodeId: "s1", exitKey: null, changes: {}, waited: true },
      ],
      0,
      "repeated ×2",
    ],
  ])("the chip words %s as the map does", (_case, graph, visits, row, chip) => {
    const model = buildProgressStepsModel(
      projectExecutionRun(graph, run(graph, visits as WorkflowExecution["visits"]))!,
    );
    expect(model.rows[row].chip.text).toBe(chip);
  });
});

describe("the notification attaches the steps picture", () => {
  test("rendered from the live run at the phone width, sharp at phone density", async () => {
    const graph = {
      ...longFlow(),
      nodes: [
        { id: "start", type: "start", progressNodeId: "b0", connections: { default: "notify" } },
        {
          id: "notify",
          type: "user-notification",
          progressNodeId: "b1",
          message: "Plan ready",
          attachProgressImage: true,
          connections: { default: "end" },
        },
        { id: "end", type: "end", progressNodeId: "b1" },
      ],
    } as unknown as WorkflowGraph;
    const items = [{ title: "Written this cycle" }];
    const live = run(graph, [{ seq: 0, nodeId: "start", exitKey: "default", changes: { items } }], {
      items,
    });
    const attachments: Array<{ bytes: Uint8Array }> = [];
    const handler = new UserNotificationHandler({
      deliver: async (request: { attachment?: { bytes: Uint8Array } }) => {
        if (request.attachment) attachments.push(request.attachment);
        return { status: "delivered", configuredChannels: 1, deliveredChannels: 1, channels: [] };
      },
      maxTextLength: 4096,
    } as unknown as UserCommunicationService);
    const repository = {
      getWorkflow: async () => ({ metadata: graph.metadata }),
      getWorkflowGraph: async () => graph,
      // Nothing is saved yet: the plan exists only in the live run.
      getExecution: async () => null,
    } as unknown as IDataRepository;
    await handler.execute(
      graph.nodes[1] as never,
      { variables: { items }, nodeStates: {}, executionId: "run", workflowId: "wf", userId: "u" },
      new AgentMessageQueue(),
      repository,
      {} as IGraphExecutionEngine,
      undefined,
      undefined,
      () => live,
    );
    expect(attachments).toHaveLength(1);
    const meta = await sharp(Buffer.from(attachments[0].bytes)).metadata();
    expect(meta.width).toBe(PROGRESS_STEPS_WIDTH * PROGRESS_STEPS_DENSITY);

    // What that picture shows: the plan written in this cycle, on the block the run is in.
    let pictured: ProgressStepsModel | null = null;
    const inspecting = new UserNotificationHandler(
      {
        deliver: async () => ({
          status: "delivered",
          configuredChannels: 1,
          deliveredChannels: 1,
          channels: [],
        }),
        maxTextLength: 4096,
      } as unknown as UserCommunicationService,
      async (workflow, execution) => {
        pictured = buildProgressStepsModel(projectExecutionRun(workflow, execution)!);
        return renderExecutionProgressStepsImage(workflow, execution);
      },
    );
    await inspecting.execute(
      graph.nodes[1] as never,
      { variables: { items }, nodeStates: {}, executionId: "run", workflowId: "wf", userId: "u" },
      new AgentMessageQueue(),
      repository,
      {} as IGraphExecutionEngine,
      undefined,
      undefined,
      () => live,
    );
    expect(pictured!.rows[1].tone).toBe("active");
    expect(pictured!.rows[1].list!.lines).toEqual(["0/1: Written this cycle"]);
  });

  test("the deprecated telegram-notification sends the same picture by default", async () => {
    const graph = {
      ...longFlow(),
      nodes: [
        { id: "start", type: "start", progressNodeId: "b0", connections: { default: "notify" } },
        {
          id: "notify",
          type: "telegram-notification",
          progressNodeId: "b1",
          message: "Plan ready",
          attachProgressImage: true,
          connections: { default: "end" },
        },
        { id: "end", type: "end", progressNodeId: "b1" },
      ],
    } as unknown as WorkflowGraph;
    const live = run(graph, [{ seq: 0, nodeId: "start", exitKey: "default", changes: {} }]);
    const photos: Uint8Array[] = [];
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "42",
          sendPhoto: async (params: { photo: Uint8Array }) => {
            photos.push(params.photo);
            return { ok: true };
          },
        }) as never,
    );
    try {
      const repository = {
        getSetting: async (_userId: string, key: string) =>
          key === "telegram.bot_token" ? "123:token" : key === "telegram.chat_id" ? "42" : null,
        getWorkflow: async () => ({ metadata: graph.metadata }),
        getWorkflowGraph: async () => graph,
        getExecution: async () => null,
      } as unknown as IDataRepository;
      await new TelegramNotificationHandler().execute(
        graph.nodes[1] as never,
        { variables: {}, nodeStates: {}, executionId: "run", workflowId: "wf", userId: "u" },
        new AgentMessageQueue(),
        repository,
        {} as IGraphExecutionEngine,
        undefined,
        undefined,
        () => live,
      );
    } finally {
      resetClientFactory();
    }
    expect(photos).toHaveLength(1);
    const meta = await sharp(Buffer.from(photos[0])).metadata();
    expect(meta.width).toBe(PROGRESS_STEPS_WIDTH * PROGRESS_STEPS_DENSITY);
  });
});
