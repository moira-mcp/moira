/**
 * The frame of every notification: a heading that names the flow and the run's task and links to
 * the run page, the message with its values written for the format, the plan folded to the
 * channel's limit, and — inside an executor cycle — the run as of the sending node, not as of the
 * last pause.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import {
  AgentMessageQueue,
  ContextMapper,
  GraphTemplateProcessor,
  GraphValidator,
  UserNotificationHandler,
  composeNotification,
  notificationHeading,
  registerActiveCommunicationChannel,
  runPageUrl,
  textEscaper,
  unregisterActiveCommunicationChannel,
  type IDataRepository,
  type IGraphExecutionEngine,
  type PortableCommunicationMessage,
  type UserCommunicationService,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { UniversalGraphExecutor } from "../../../packages/workflow-engine/src/core/universal-graph-executor.js";
import { InMemoryRepository } from "../../../packages/workflow-engine/src/storage/in-memory-repository.js";

const RUN = "0d7c5a9e-2f4b-4c1d-9a8e-3b6f1c2d4e5f";

describe("run page URL", () => {
  const saved = { host: process.env.MOIRA_HOST, base: process.env.APP_BASE_PATH };
  afterEach(() => {
    for (const [key, value] of [
      ["MOIRA_HOST", saved.host],
      ["APP_BASE_PATH", saved.base],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test.each([
    ["/", `https://moira.example/executions/${RUN}`],
    ["/app", `https://moira.example/app/executions/${RUN}`],
    ["/app/", `https://moira.example/app/executions/${RUN}`],
  ])("APP_BASE_PATH=%s links the run page at %s", (base, expected) => {
    process.env.MOIRA_HOST = "moira.example";
    process.env.APP_BASE_PATH = base;
    expect(runPageUrl({ executionId: RUN })).toBe(expected);
    // An inline subgraph child has no page of its own: it links to the run that carries it.
    expect(runPageUrl({ executionId: "inline-child", _rootExecutionId: RUN })).toBe(expected);
  });

  test("an inline subgraph child at any depth carries the top-level run", () => {
    const top = { variables: {}, nodeStates: {}, executionId: RUN, workflowId: "wf", userId: "u" };
    const child = ContextMapper.createChildContext(top, {}, "child-wf", "child-run");
    const grandchild = ContextMapper.createChildContext(child, {}, "grand-wf", "grand-run");
    expect(child._rootExecutionId).toBe(RUN);
    expect(grandchild._rootExecutionId).toBe(RUN);
    expect(grandchild._parentExecutionId).toBe("child-run");
  });
});

describe("heading", () => {
  const url = "https://moira.example/executions/run";

  test.each([
    ["markdown", `[Todo List · Ship the parser](${url})`],
    ["html", `<a href="${url}">Todo List · Ship the parser</a>`],
    ["plain", `Todo List · Ship the parser\n${url}`],
  ] as const)("in %s names the flow and the task, linked to the run", (format, expected) => {
    expect(notificationHeading("Todo List", "Ship the parser", url, format)).toBe(expected);
  });

  test("a run without a note gets the flow name alone, still linked", () => {
    expect(notificationHeading("Todo List", null, url, "markdown")).toBe(`[Todo List](${url})`);
    expect(notificationHeading("Todo List", "  ", url, "plain")).toBe(`Todo List\n${url}`);
  });

  test("a note with markup characters cannot break the parse", () => {
    const note = "Fix a_b *c* `d` [e] <f> & g";
    // Legacy Markdown link text takes no escapes and must not contain brackets (checked against
    // the Bot API: `_ * \`` stand literally inside the link text, a `]` ends it).
    expect(notificationHeading("Flow", note, url, "markdown")).toBe(
      `[Flow · Fix a_b *c* \`d\` (e) <f> & g](${url})`,
    );
    expect(notificationHeading("Flow", note, url, "html")).toBe(
      `<a href="${url}">Flow · Fix a_b *c* \`d\` [e] &lt;f&gt; &amp; g</a>`,
    );
  });

  test("a long or multi-line note is one shortened line", () => {
    const heading = notificationHeading("Flow", `first\nsecond ${"x".repeat(400)}`, url, "plain");
    const title = heading.split("\n")[0];
    expect(title.startsWith("Flow · first second ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThan(220);
  });
});

describe("values written for the format", () => {
  test("a substituted value is escaped; the author's markup and the run URL are not", () => {
    const processor = new GraphTemplateProcessor(undefined, undefined, textEscaper("markdown"));
    const text = processor.processDirective("*Done:* {{title}} — [open]({{runUrl}})", {
      variables: { title: "snake_case *bold*" },
      nodeStates: {},
      executionId: RUN,
      workflowId: "wf",
      userId: "user",
    });
    expect(text).toBe(
      `*Done:* snake\\_case \\*bold\\* — [open](${runPageUrl({ executionId: RUN })})`,
    );
  });

  test("in HTML a substituted value cannot open a tag", () => {
    const processor = new GraphTemplateProcessor(undefined, undefined, textEscaper("html"));
    const text = processor.processDirective("<b>Result:</b> {{value}}", {
      variables: { value: "<i>x</i> & y" },
      nodeStates: {},
      executionId: RUN,
      workflowId: "wf",
      userId: "user",
    });
    expect(text).toBe("<b>Result:</b> &lt;i&gt;x&lt;/i&gt; &amp; y");
  });

  test("the validator accepts {{runUrl}} as a system variable in a notification", async () => {
    const graph = {
      metadata: { name: "Run link", version: "1.0.0", description: "Links the run" },
      nodes: [
        { id: "start", type: "start", connections: { default: "notify" } },
        {
          id: "notify",
          type: "user-notification",
          message: "Open the run: {{runUrl}}",
          connections: { default: "end" },
        },
        { id: "end", type: "end" },
      ],
    } as unknown as WorkflowGraph;
    const result = await new GraphValidator().validateUnified(graph);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    // The same message with an undeclared name is rejected, so the check is live.
    (graph.nodes[1] as { message: string }).message = "Open the run: {{runLink}}";
    const rejected = await new GraphValidator().validateUnified(graph);
    expect(
      rejected.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message),
    ).toEqual([expect.stringContaining("undeclared variable 'runLink'")]);
  });

  test("a missing value stays the detectable placeholder, unescaped", () => {
    const processor = new GraphTemplateProcessor(undefined, undefined, textEscaper("markdown"));
    const text = processor.processDirective("Result: {{missing}}", {
      variables: {},
      nodeStates: {},
      executionId: RUN,
      workflowId: "wf",
      userId: "user",
    });
    expect(text).toBe(`Result: ${GraphTemplateProcessor.UNDEFINED_PLACEHOLDER}`);
  });
});

describe("composition", () => {
  const heading = "Flow\nhttps://moira.example/executions/run";

  test("heading, message, plan and waiting line in that order, separated by blank lines", () => {
    expect(
      composeNotification({
        heading,
        body: "Plan approved, work started.",
        planList: () => ["📝 0/2", "▶ 1. Parse", "○ 2. Ship"],
        waitingLine: "⏳ agent on the step: Work",
        limit: 4096,
      }),
    ).toBe(
      `${heading}\n\nPlan approved, work started.\n\n📝 0/2\n▶ 1. Parse\n○ 2. Ship\n\n⏳ agent on the step: Work`,
    );
  });

  test("the plan gets the room the rest leaves, and an over-long message is cut, never refused", () => {
    const budgets: number[] = [];
    const text = composeNotification({
      heading,
      body: Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n"),
      planList: (budget) => {
        budgets.push(budget);
        return budget >= "📝 1/3".length ? ["📝 1/3"] : [];
      },
      waitingLine: "🙋 waiting for you: Approval",
      limit: 1024,
    });
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(text.startsWith(heading)).toBe(true);
    expect(text.endsWith("🙋 waiting for you: Approval")).toBe(true);
    expect(text).toContain("\n…");
    // The plan was offered only the room left after the heading, the message and the actor.
    expect(budgets.every((budget) => budget <= 1024 - heading.length)).toBe(true);
  });
});

describe("planList", () => {
  const graph = {
    metadata: { name: "Modes", version: "1.0.0", description: "x" },
    variableRegistry: {
      tasks: { type: "array", description: "plan", default: [] },
      current_task: { type: "number", description: "cursor", default: 1 },
    },
    progress: {
      nodes: [
        {
          id: "work",
          label: "Work",
          list: { items: "tasks", title: "title", current: "current_task" },
        },
      ],
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "work", connections: { default: "notify" } },
      {
        id: "notify",
        type: "user-notification",
        progressNodeId: "work",
        message: "Checkpoint",
        connections: { default: "end" },
      },
      { id: "end", type: "end", progressNodeId: "work" },
    ],
  } as unknown as WorkflowGraph;
  const tasks = [{ title: "Parse" }, { title: "Ship" }];
  const run = {
    executionId: RUN,
    workflowId: "wf",
    userId: "user",
    currentNodeId: "start",
    status: "running",
    revision: 1,
    globalContext: { variables: { tasks }, nodeStates: {} },
    visits: [{ seq: 0, nodeId: "start", exitKey: "default", changes: { tasks } }],
  } as unknown as WorkflowExecution;

  test.each([
    ["full", "Checkpoint\n\n📝 0/2\n▶ 1. Parse\n○ 2. Ship"],
    ["progress", "Checkpoint\n\n📝 0/2: Parse"],
    [undefined, "Checkpoint\n\n📝 0/2: Parse"],
    ["none", "Checkpoint"],
  ] as const)("%s ends the message with its part of the plan", async (planList, ending) => {
    const texts: string[] = [];
    const handler = new UserNotificationHandler({
      deliver: async (request: { text: string }) => {
        texts.push(request.text);
        return { status: "delivered", configuredChannels: 1, deliveredChannels: 1, channels: [] };
      },
      maxTextLength: 4096,
    } as unknown as UserCommunicationService);
    const repository = {
      getWorkflow: async () => ({ metadata: graph.metadata }),
      getWorkflowGraph: async () => graph,
      getExecution: async () => null,
    } as unknown as IDataRepository;
    await handler.execute(
      { ...graph.nodes[1], ...(planList ? { planList } : {}) } as never,
      { variables: { tasks }, nodeStates: {}, executionId: RUN, workflowId: "wf", userId: "user" },
      new AgentMessageQueue(),
      repository,
      {} as IGraphExecutionEngine,
      undefined,
      undefined,
      () => run,
    );
    expect(texts).toHaveLength(1);
    expect(texts[0].startsWith("Modes\n")).toBe(true);
    expect(texts[0].endsWith(ending)).toBe(true);
  });
});

describe("a notification reads the run as of the node that sends it", () => {
  const delivered: PortableCommunicationMessage[] = [];
  const channelId = "test.capturing-notifications";

  beforeEach(() => {
    delivered.length = 0;
    registerActiveCommunicationChannel({
      id: channelId,
      provider: channelId,
      capabilities: { text: true, image: true, document: true, trusted: false },
      metadata: { title: "Capturing", origin: "builtin", settingKeys: [] },
      isConfigured: async () => true,
      deliver: async (message) => {
        delivered.push(message);
      },
    });
  });
  afterEach(() => {
    unregisterActiveCommunicationChannel(channelId);
  });

  function planWorkflow(): WorkflowGraph {
    return {
      id: "plan-flow",
      metadata: { name: "Plan Flow", version: "1.0.0", description: "Plan, notify, work, notify" },
      variableRegistry: {
        tasks: { type: "array", description: "The plan", default: [] },
        current_task: { type: "number", description: "1-based cursor", default: 1 },
      },
      progress: {
        nodes: [
          { id: "planning", label: "Planning", content: { summary: "Write the plan" } },
          {
            id: "work",
            label: "Work",
            content: { summary: "Work the plan" },
            list: { items: "tasks", title: "title", current: "current_task" },
          },
          { id: "wrap", label: "Wrap", content: { summary: "Finish" } },
        ],
      },
      nodes: [
        {
          id: "start",
          type: "start",
          progressNodeId: "planning",
          connections: { default: "plan" },
        },
        {
          id: "plan",
          type: "agent-directive",
          progressNodeId: "planning",
          directive: "Write the plan",
          completionCondition: "Planned",
          inputSchema: {
            type: "object",
            properties: { execution_note: { type: "string" } },
            globalInputs: ["tasks"],
          },
          connections: { success: "notify-plan" },
        },
        {
          id: "notify-plan",
          type: "user-notification",
          progressNodeId: "planning",
          message: "Plan approved, work started.",
          format: "markdown",
          planList: "full",
          connections: { default: "task" },
        },
        {
          id: "task",
          type: "agent-directive",
          progressNodeId: "work",
          directive: "Do the task",
          completionCondition: "Done",
          inputSchema: { type: "object", properties: {}, globalInputs: ["current_task"] },
          connections: { success: "notify-done" },
        },
        {
          id: "notify-done",
          type: "user-notification",
          progressNodeId: "wrap",
          message: "All done.",
          planList: "full",
          connections: { default: "end" },
        },
        { id: "end", type: "end", progressNodeId: "wrap" },
      ],
    } as unknown as WorkflowGraph;
  }

  test("the plan and the note written earlier in the sending cycle appear; the item finished in it reads ✓", async () => {
    const repository = new InMemoryRepository();
    const executor = new UniversalGraphExecutor(repository);
    const workflow = planWorkflow();
    await repository.saveWorkflow(workflow, "owner");
    const executionId = await executor.startWorkflow(workflow, undefined, "owner");
    await executor.executeStep(executionId);

    // One step writes the note and the plan; the notification after it runs in the same cycle,
    // before anything of that cycle is saved.
    await executor.executeStep(executionId, {
      execution_note: "Ship the_parser",
      tasks: [{ title: "Parse" }, { title: "Ship_it" }],
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe(
      [
        `[Plan Flow · Ship the_parser](${runPageUrl({ executionId })})`,
        "Plan approved, work started.",
        "📝 0/2\n▶ 1. Parse\n○ 2. Ship\\_it",
        "⏳ agent on the step: Work",
      ].join("\n\n"),
    );

    // The last item is finished by the step whose cycle sends the closing notification.
    await executor.executeStep(executionId, { current_task: 3 });
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text.endsWith("All done.\n\n📝 2/2\n✓ 1. Parse\n✓ 2. Ship_it")).toBe(true);
    expect(delivered[1].text.startsWith("Plan Flow · Ship the_parser\n")).toBe(true);
  });
});
