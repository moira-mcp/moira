/**
 * A run that loses behaviour text says so.
 *
 * When a playbook a definition names cannot be read, the step continues with a visible placeholder
 * rather than failing. That is deliberate — but it must not be silent: the run records what it ran
 * without. For a reference inside a materialized file the placeholder never reaches the agent's
 * directive at all, so the record is the only trace a person can see.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { TokenManager, type ExecutionError, type WorkflowToken } from "@mcp-moira/shared";
import {
  AgentDirectiveHandler,
  AgentMessageQueue,
  TeleportHandler,
  resolveMaterializeDelivery,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const USER = "user-1";

const execution: WorkflowExecution = {
  revision: 0,
  executionId: "execution-1",
  workflowId: "workflow-1",
  userId: USER,
  currentNodeId: "materialize",
  waitingForInputNodeId: "materialize",
  globalContext: {
    executionId: "execution-1",
    workflowId: "workflow-1",
    userId: USER,
    variables: {},
    nodeStates: {},
  },
  status: "running",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const grant: WorkflowToken = {
  token: "grant",
  workflowId: null,
  executionId: "execution-1",
  nodeId: "materialize",
  userId: USER,
  type: "materialize",
  workflowVersion: null,
  executionRevision: null,
  optionsJson: null,
  expiresAt: Date.now() + TokenManager.MATERIALIZE_TTL_MS,
  used: false,
  createdAt: Date.now(),
};

function materializeGraph(): WorkflowGraph {
  return {
    id: "workflow-1",
    metadata: { name: "Test", version: "1.0.0", description: "Test" },
    variableRegistry: {
      guide: {
        type: "string",
        description: "Guide body",
        default: "Standard: {{playbook:missing-standard}}",
      },
    },
    nodes: [
      { id: "start", type: "start", connections: { default: "materialize" } },
      {
        id: "materialize",
        type: "materialize",
        basePath: "out",
        files: [{ path: "guide.md", from: "guide" }],
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("a step that cannot read a playbook", () => {
  test("records on the run what it ran without", async () => {
    const appended: ExecutionError[] = [];
    const repository = {
      appendError: jest.fn(async (_executionId: string, error: ExecutionError) => {
        appended.push(error);
        return true;
      }),
    };

    const handler = new AgentDirectiveHandler();
    const node = {
      id: "work",
      type: "agent-directive",
      directive: "Follow this: {{playbook:missing-standard}}",
      completionCondition: "Done.",
      connections: { success: "end" },
    };

    await handler.execute(
      node as never,
      execution.globalContext as never,
      new AgentMessageQueue(),
      repository as never,
      {} as never,
    );

    expect(appended).toHaveLength(1);
    expect(appended[0].nodeId).toBe("work");
    expect(appended[0].message).toContain("missing-standard");
  });
});

describe("a teleport step that cannot read a playbook", () => {
  test("records the loss the same way an ordinary step does", async () => {
    const appended: ExecutionError[] = [];
    const repository = {
      appendError: jest.fn(async (_executionId: string, error: ExecutionError) => {
        appended.push(error);
        return true;
      }),
    };

    const handler = new TeleportHandler();
    const node = {
      id: "jump",
      type: "teleport",
      directive: "Decide with this: {{playbook:missing-standard}}",
      completionCondition: "Decided.",
      connections: { success: "end" },
    };

    await handler.execute(
      node as never,
      execution.globalContext as never,
      new AgentMessageQueue(),
      repository as never,
      {} as never,
    );

    expect(appended).toHaveLength(1);
    expect(appended[0].nodeId).toBe("jump");
    expect(appended[0].message).toContain("missing-standard");
  });
});

describe("a materialized file that cannot read a playbook", () => {
  test("is still delivered, and the run records the missing text", async () => {
    const appended: ExecutionError[] = [];
    const source = {
      getExecution: async () => execution,
      getWorkflowGraph: async () => materializeGraph(),
      appendError: async (_executionId: string, error: ExecutionError) => {
        appended.push(error);
        return true;
      },
    };

    const delivery = await resolveMaterializeDelivery(
      "grant",
      { validateToken: () => grant, authorizeMaterializeToken: () => true } as never,
      source as never,
    );

    expect(delivery.authorized).toBe(true);
    if (!delivery.authorized) return;

    // The agent downloads the file and finds the placeholder inside it; nothing about that reaches
    // the directive, which is why the run has to carry the fact instead.
    // The placeholder names the playbook and is impossible to mistake for content; which of the
    // two forms it takes depends on whether the registry answered "no such playbook" or could not
    // be reached at all, and both are degradation.
    expect(delivery.files[0].content.toString("utf8")).toMatch(
      /\[PLAYBOOK (NOT AVAILABLE|ERROR): missing-standard\]/,
    );
    expect(appended).toHaveLength(1);
    expect(appended[0].message).toContain("missing-standard");
  });

  test("records nothing when the delivery itself is refused", async () => {
    // A download that loses its authorization delivers no file, so the run must not carry a note
    // about files it never received; the record follows the delivery, not the render.
    const appended: ExecutionError[] = [];
    const source = {
      getExecution: async () => execution,
      getWorkflowGraph: async () => materializeGraph(),
      appendError: async (_executionId: string, error: ExecutionError) => {
        appended.push(error);
        return true;
      },
    };

    const delivery = await resolveMaterializeDelivery(
      "grant",
      { validateToken: () => grant, authorizeMaterializeToken: () => false } as never,
      source as never,
    );

    expect(delivery).toEqual({ authorized: false, reason: "authorization_lost" });
    expect(appended).toHaveLength(0);
  });
});
