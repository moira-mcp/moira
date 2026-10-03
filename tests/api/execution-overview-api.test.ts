/**
 * GET /api/executions/overview — the signed-in person's runs as trees, filtered and paged in SQL.
 * Against the real container, as a fresh user whose runs are all created here, so every count is
 * exact: pages agree with `total` for every status filter, each run appears once, a run whose
 * ancestors are all outside the filter is a root that names its parent, a tree is shown when any of
 * its runs matches while the rest come back muted, idleness reads the whole tree, and another
 * person's runs are never visible.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  signInUser,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "Overview-Test-Password-1";

type Status = "waiting-user" | "waiting-agent" | "locked" | "completed";

interface Run {
  executionId: string;
  status: Status;
  matches: boolean;
  title: string;
  note: string | null;
  waitingForUser: { source: string; label?: string } | null;
  parent: { executionId: string; title: string } | null;
  children: { total: number; unfinished: number };
  childRuns: Run[];
  lastActivityAt: number | null;
  subtreeActivityAt: number | null;
}

interface Page {
  total: number;
  runs: Run[];
}

function plainFlow(name: string) {
  return {
    metadata: { name, version: "1.0.0", description: "One step of work" },
    nodes: [
      { type: "start", id: "start", connections: { default: "task" } },
      {
        type: "agent-directive",
        id: "task",
        directive: "Import the orders",
        completionCondition: "Imported",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

function gatedFlow(name: string) {
  return {
    metadata: { name, version: "1.0.0", description: "A step that waits for a person" },
    nodes: [
      { type: "start", id: "start", connections: { default: "draft" } },
      {
        type: "agent-directive",
        id: "draft",
        directive: "Draft the column mapping",
        completionCondition: "Drafted",
        connections: { success: "approve" },
      },
      {
        type: "agent-directive",
        id: "approve",
        directive: "Show the mapping and wait for the decision",
        completionCondition: "Decided",
        humanGate: { label: "Approve the mapping" },
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

/** Every run of the page, the nested ones included. */
function flatten(runs: Run[]): Run[] {
  return runs.flatMap((run) => [run, ...flatten(run.childRuns)]);
}

describe("GET /api/executions/overview", () => {
  const stamp = Date.now();
  let cookie: string;
  let otherCookie: string;
  const cleanups: Array<() => Promise<void>> = [];
  let client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"];

  const ids: Record<string, string> = {};
  let beforeGrandchild = 0;

  async function overview(query: string, as = cookie): Promise<Page> {
    const response = await fetch(`${BASE_URL}/api/executions/overview?${query}`, {
      headers: { Cookie: formatSessionCookie(BASE_URL, as) },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: Page }).data;
  }

  async function start(
    workflowId: string,
    note: string,
    parentExecutionId?: string,
  ): Promise<RunningWorkflowExecution> {
    return startWorkflowExecutionState(client, workflowId, {
      note,
      parentExecutionId,
      skipNotificationCheck: true,
    });
  }

  async function create(workflow: object): Promise<string> {
    const created = await callMCPTool<{ workflowId: string }>(client, "manage", {
      action: "create",
      workflow,
    });
    return created.workflowId;
  }

  beforeAll(async () => {
    const email = `overview-${stamp}@example.test`;
    await createTestUserViaApi(BASE_URL, email, PASSWORD, "Overview Owner");
    const otherEmail = `overview-other-${stamp}@example.test`;
    await createTestUserViaApi(BASE_URL, otherEmail, PASSWORD, "Overview Other");
    cookie = await signInUser(BASE_URL, email, PASSWORD);
    otherCookie = await signInUser(BASE_URL, otherEmail, PASSWORD);
    const mcp = await createAuthenticatedMCPClient({ email, password: PASSWORD });
    client = mcp.client;
    cleanups.push(mcp.cleanup);

    const plain = await create(plainFlow(`Order import ${stamp}`));
    const gated = await create(gatedFlow(`Mapping approval ${stamp}`));

    // Three runs of each status.
    for (let index = 1; index <= 3; index += 1) {
      const waiting = await start(gated, `waiting-user ${index}`);
      await advanceWorkflowExecution(client, waiting, {});
      ids[`waitingUser${index}`] = waiting.processId;

      ids[`waitingAgent${index}`] = (await start(plain, `waiting-agent ${index}`)).processId;

      const locked = await start(plain, `locked ${index}`);
      const lock = await fetch(`${BASE_URL}/api/executions/${locked.processId}/lock`, {
        method: "POST",
        headers: {
          Cookie: formatSessionCookie(BASE_URL, cookie),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Confirm the import" }),
      });
      expect(lock.status).toBeLessThan(300);
      ids[`locked${index}`] = locked.processId;

      const done = await start(plain, `completed ${index}`);
      await advanceWorkflowExecution(client, done, {});
      ids[`completed${index}`] = done.processId;
    }

    // A running child of a finished parent.
    const parent = await start(plain, "finished parent");
    const child = await start(plain, "child of a finished parent", parent.processId);
    await advanceWorkflowExecution(client, parent, {});
    ids.finishedParent = parent.processId;
    ids.orphanChild = child.processId;

    // A run whose agent raised its own question, and a marked step that is also locked.
    const asking = await start(plain, "agent question");
    const raised = await callMCPTool<unknown>(client, "session", {
      action: "await-user",
      executionId: asking.processId,
      question: "Which currency do the prices use?",
    });
    expect(raised).toBeTruthy();
    ids.agentQuestion = asking.processId;
    const lockedGate = await start(gated, "locked gate");
    await advanceWorkflowExecution(client, lockedGate, {});
    const gateLock = await fetch(`${BASE_URL}/api/executions/${lockedGate.processId}/lock`, {
      method: "POST",
      headers: {
        Cookie: formatSessionCookie(BASE_URL, cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "Confirm the mapping" }),
    });
    expect(gateLock.status).toBeLessThan(300);
    ids.lockedGate = lockedGate.processId;

    // A running root with a running child that has its own child, and a finished child.
    const root = await start(plain, "tree root");
    const middle = await start(plain, "tree middle", root.processId);
    const finishedChild = await start(plain, "tree finished child", root.processId);
    await advanceWorkflowExecution(client, finishedChild, {});
    ids.treeRoot = root.processId;
    ids.treeMiddle = middle.processId;
    ids.treeFinishedChild = finishedChild.processId;
    // The grandchild is the tree's latest activity, after every run created so far. The moment is
    // read from the server's own timestamps: the container's clock is not the test's.
    const sofar = await overview(`ids=${Object.values(ids).join(",")}`);
    beforeGrandchild = Math.max(...sofar.runs.map((run) => run.lastActivityAt ?? 0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ids.treeGrandchild = (
      await start(plain, `grandchild needle ${stamp}`, middle.processId)
    ).processId;
  });

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  test.each([
    ["active", ["waiting-user", "waiting-agent", "locked"]],
    ["waiting-user", ["waiting-user"]],
    ["waiting-agent", ["waiting-agent"]],
    ["locked", ["locked"]],
    ["completed", ["completed"]],
    ["all", ["waiting-user", "waiting-agent", "locked", "completed"]],
  ] as const)(
    "status %s: pages of two agree with total, and every root is in the filter",
    async (status, allowed) => {
      const whole = await overview(`status=${status}&limit=100`);
      expect(whole.total).toBe(whole.runs.length);
      expect(whole.total).toBeGreaterThan(2);
      for (const run of whole.runs) expect(allowed).toContain(run.status);

      const paged: string[] = [];
      for (let offset = 0; offset < whole.total; offset += 2) {
        const page = await overview(`status=${status}&limit=2&offset=${offset}`);
        expect(page.total).toBe(whole.total);
        expect(page.runs.length).toBeLessThanOrEqual(2);
        paged.push(...page.runs.map((run) => run.executionId));
      }
      expect(paged).toEqual(whole.runs.map((run) => run.executionId));
    },
  );

  test("runs waiting for their person come first", async () => {
    const { runs } = await overview("status=active&limit=100");
    // Three marked steps and one agent question wait for the person; all four lead the page.
    const firstOther = runs.findIndex((run) => run.status !== "waiting-user");
    expect(firstOther).toBe(4);
    expect(runs.slice(firstOther).map((run) => run.status)).not.toContain("waiting-user");
    expect(
      runs
        .slice(0, 4)
        .map((run) => run.waitingForUser?.source)
        .sort(),
    ).toEqual(["agent", "gate", "gate", "gate"]);
    expect(runs.find((run) => run.waitingForUser?.source === "gate")?.waitingForUser).toEqual(
      expect.objectContaining({ label: "Approve the mapping" }),
    );
  });

  test("by default a running child of a finished parent is a root that names its parent", async () => {
    const { runs } = await overview("limit=100");
    const all = flatten(runs);
    expect(all.map((run) => run.executionId)).not.toContain(ids.finishedParent);
    const child = runs.find((run) => run.executionId === ids.orphanChild);
    expect(child?.parent).toEqual({
      executionId: ids.finishedParent,
      title: `Order import ${stamp}`,
    });
    expect(child?.title).toBe(`Order import ${stamp}`);
    expect(child?.note).toBe("child of a finished parent");
  });

  test("with finished runs included, each run appears once, under its parent", async () => {
    const { runs } = await overview("status=all&limit=100");
    const all = flatten(runs).map((run) => run.executionId);
    expect(new Set(all).size).toBe(all.length);
    const parent = runs.find((run) => run.executionId === ids.finishedParent)!;
    expect(parent.childRuns.map((run) => run.executionId)).toEqual([ids.orphanChild]);
    expect(runs.map((run) => run.executionId)).not.toContain(ids.orphanChild);
  });

  test("a tree is shown when only a grandchild matches; the rest of it comes back muted", async () => {
    const { runs, total } = await overview(`search=${encodeURIComponent(`needle ${stamp}`)}`);
    expect(total).toBe(1);
    const [root] = runs;
    expect(root.executionId).toBe(ids.treeRoot);
    expect(root.matches).toBe(false);
    expect(root.children).toEqual({ total: 2, unfinished: 1 });
    // Unfinished children first; the finished child is outside the default filter, so muted.
    expect(root.childRuns.map((run) => [run.executionId, run.matches])).toEqual([
      [ids.treeMiddle, false],
      [ids.treeFinishedChild, false],
    ]);
    expect(root.childRuns[0].childRuns.map((run) => [run.executionId, run.matches])).toEqual([
      [ids.treeGrandchild, true],
    ]);
  });

  test("idleness reads the whole tree: a tree with a recent grandchild is not idle", async () => {
    const { runs } = await overview(`activeTo=${beforeGrandchild}&limit=100`);
    const roots = runs.map((run) => run.executionId);
    expect(roots).not.toContain(ids.treeRoot);
    expect(roots).toContain(ids.waitingAgent1);

    const tree = (await overview(`search=${encodeURIComponent(`needle ${stamp}`)}`)).runs[0];
    expect(tree.subtreeActivityAt).toBeGreaterThan(beforeGrandchild);
    expect(tree.lastActivityAt).toBeLessThanOrEqual(beforeGrandchild);
  });

  test("another person sees none of these runs, not even by id", async () => {
    const { runs, total } = await overview("status=all&limit=100", otherCookie);
    expect(total).toBe(0);
    expect(runs).toEqual([]);
    const byIds = await overview(`ids=${ids.waitingUser1},${ids.treeRoot}`, otherCookie);
    expect(byIds.runs).toEqual([]);
  });

  test("single rows by id carry the same projection, with their subtree's facts", async () => {
    const { runs } = await overview(`ids=${ids.waitingUser1},${ids.locked1},${ids.treeRoot}`);
    expect(runs.map((run) => [run.executionId, run.status])).toEqual(
      expect.arrayContaining([
        [ids.waitingUser1, "waiting-user"],
        [ids.locked1, "locked"],
        [ids.treeRoot, "waiting-agent"],
      ]),
    );
    const root = runs.find((run) => run.executionId === ids.treeRoot)!;
    expect(root.children).toEqual({ total: 2, unfinished: 1 });
    expect(root.subtreeActivityAt).toBeGreaterThan(beforeGrandchild);
    expect(root.childRuns).toEqual([]);
  });

  test("the agent's own question waits for the person; a lock outranks a marked step", async () => {
    const { runs } = await overview(`ids=${ids.agentQuestion},${ids.lockedGate}`);
    const byId = new Map(runs.map((run) => [run.executionId, run]));
    expect(byId.get(ids.agentQuestion)?.status).toBe("waiting-user");
    expect(byId.get(ids.agentQuestion)?.waitingForUser).toEqual(
      expect.objectContaining({ source: "agent", question: "Which currency do the prices use?" }),
    );
    expect(byId.get(ids.lockedGate)?.status).toBe("locked");
    expect(byId.get(ids.lockedGate)?.waitingForUser).toBeNull();
  });

  test.each([["status=nonsense"], ["idle=toString"], ["idle=2d"], ["limit=0"], ["sort=name"]])(
    "%s is refused",
    async (query) => {
      const response = await fetch(`${BASE_URL}/api/executions/overview?${query}`, {
        headers: { Cookie: formatSessionCookie(BASE_URL, cookie) },
      });
      expect(response.status).toBe(400);
    },
  );
});
