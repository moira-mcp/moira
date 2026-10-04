/**
 * GET /api/executions/overview — the signed-in person's runs as trees, filtered and paged in SQL.
 * Against the real container, as a fresh user whose runs are all created here, so every count is
 * exact: pages agree with `total` for every status filter, each run appears once, required owned
 * ancestors remain as context, unrelated siblings are pruned, idleness reads the whole tree, and another
 * person's runs are never visible.
 */

import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getTestBaseUrl, isExternalTarget } from "../utils/test-config.js";
import { dockerExecAsync, dockerExecSync } from "../utils/docker-command.js";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type {
  ExecutionStopResult,
  OverviewChildCounts,
} from "@mcp-moira/shared/execution-management";
import {
  advanceWorkflowExecution,
  callMCPTool,
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  formatSessionCookie,
  getAdminSessionCookie,
  signInUser,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "Overview-Test-Password-1";
const localOwnedFixtureTest =
  !isExternalTarget() &&
  !process.env.REMOTE_DOCKER_CONTEXT &&
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname)
    ? test
    : test.skip;

type Status = "waiting-user" | "waiting-agent" | "locked" | "completed" | "stopped";

interface Run {
  executionId: string;
  status: Status;
  matches: boolean;
  title: string;
  note: string | null;
  waitingForUser: { source: string; label?: string } | null;
  parent: { executionId: string; title: string } | null;
  children: OverviewChildCounts;
  childrenTotal: OverviewChildCounts;
  childRuns: Run[];
  lastActivityAt: number | null;
  subtreeActivityAt: number | null;
  idleActivityAt: number | null;
  createdAt: number | null;
}

interface Page {
  total: number;
  runs: Run[];
  evaluatedAt?: number;
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
    "status %s: pages of two agree with total, and every eligible run is in the filter",
    async (status, allowed) => {
      const whole = await overview(`status=${status}&limit=100`);
      expect(whole.total).toBe(whole.runs.length);
      expect(whole.total).toBeGreaterThan(2);
      for (const run of flatten(whole.runs).filter((run) => run.matches))
        expect(allowed).toContain(run.status);

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

  test("UTC-hour activity ordering is stable and retains all waiting reasons", async () => {
    const { runs } = await overview("status=active&limit=100");
    const sorted = [...runs].sort(
      (a, b) =>
        Math.floor((b.subtreeActivityAt ?? 0) / 3_600_000) -
          Math.floor((a.subtreeActivityAt ?? 0) / 3_600_000) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        (a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0),
    );
    expect(runs.map((run) => run.executionId)).toEqual(sorted.map((run) => run.executionId));
    expect(
      runs
        .filter((run) => run.status === "waiting-user")
        .map((run) => run.waitingForUser?.source)
        .sort(),
    ).toEqual(["agent", "gate", "gate", "gate"]);
    expect(runs.find((run) => run.waitingForUser?.source === "gate")?.waitingForUser).toEqual(
      expect.objectContaining({ label: "Approve the mapping" }),
    );
  });

  test("by default a running child retains its finished parent as context", async () => {
    const { runs } = await overview("limit=100");
    const all = flatten(runs);
    const parent = runs.find((run) => run.executionId === ids.finishedParent)!;
    expect(parent).toMatchObject({ status: "completed", matches: false });
    expect(all.map((run) => run.executionId)).toContain(ids.orphanChild);
    const child = parent.childRuns.find((run) => run.executionId === ids.orphanChild);
    expect(child?.matches).toBe(true);
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
    expect(root.children).toEqual({ total: 1, unfinished: 1 });
    expect(root.childrenTotal).toEqual({ total: 2, unfinished: 1 });
    expect(root.childRuns.map((run) => [run.executionId, run.matches])).toEqual([
      [ids.treeMiddle, false],
    ]);
    expect(root.childRuns[0].childRuns.map((run) => [run.executionId, run.matches])).toEqual([
      [ids.treeGrandchild, true],
    ]);
  });

  test("absolute activity eligibility prunes fresh descendants while idle facts retain the full subtree", async () => {
    const { runs } = await overview(`activeTo=${beforeGrandchild}&limit=100`);
    const roots = runs.map((run) => run.executionId);
    expect(roots).toContain(ids.treeRoot);
    expect(roots).toContain(ids.waitingAgent1);
    const oldTree = runs.find((run) => run.executionId === ids.treeRoot)!;
    expect(flatten([oldTree]).map((run) => run.executionId)).not.toContain(ids.treeGrandchild);
    expect(oldTree.subtreeActivityAt).toBeLessThanOrEqual(beforeGrandchild);
    expect(oldTree.idleActivityAt).toBeGreaterThan(beforeGrandchild);
    expect((await overview("idle=1h&limit=100")).total).toBe(0);

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
    expect(root.children).toEqual({ total: 0, unfinished: 0 });
    expect(root.childrenTotal).toEqual({ total: 2, unfinished: 1 });
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

  test.each([
    ["status=nonsense"],
    ["idle=toString"],
    ["idle=2d"],
    ["idle=1h&period=7d"],
    ["idle=1h&activeFrom=1"],
    ["activeFrom=2&activeTo=1"],
    ["activeFrom=-1"],
    ["period=old"],
    ["limit=0"],
    ["sort=name"],
  ])("%s is refused", async (query) => {
    const response = await fetch(`${BASE_URL}/api/executions/overview?${query}`, {
      headers: { Cookie: formatSessionCookie(BASE_URL, cookie) },
    });
    expect(response.status).toBe(400);
  });

  test("REST stop enforces ownership/revision, distinguishes stopping and leaves children running", async () => {
    const workflowId = await create(plainFlow(`REST stop ${stamp}`));
    const parent = await start(workflowId, "REST stop parent");
    const child = await start(workflowId, "REST stop child", parent.processId);
    const detailResponse = await fetch(`${BASE_URL}/api/executions/${parent.processId}`, {
      headers: { Cookie: formatSessionCookie(BASE_URL, cookie) },
    });
    expect(detailResponse.status).toBe(200);
    const detail = (
      (await detailResponse.json()) as {
        data: {
          execution: { revision: number; stopCapability: { available: boolean; revision: number } };
        };
      }
    ).data.execution;
    expect(detail.stopCapability).toEqual({ available: true, revision: detail.revision });
    const input = { expectedRevision: detail.revision, reason: "  Requirements changed  " };
    const send = (id: string, body: object, as = cookie) =>
      fetch(`${BASE_URL}/api/executions/${id}/stop`, {
        method: "POST",
        headers: { Cookie: formatSessionCookie(BASE_URL, as), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await send(parent.processId, input, otherCookie)).status).toBe(403);
    expect((await send("missing-stop-execution", input)).status).toBe(404);
    expect((await send(parent.processId, { ...input, reason: " " })).status).toBe(400);
    expect(
      (await send(parent.processId, { ...input, expectedRevision: detail.revision + 1 })).status,
    ).toBe(409);
    const accepted = await send(parent.processId, input);
    expect(accepted.status).toBe(200);
    const stopped = ((await accepted.json()) as { data: ExecutionStopResult }).data;
    expect(stopped).toMatchObject({
      changed: true,
      displayStatus: "stopped",
      stopReason: "Requirements changed",
      revision: detail.revision + 1,
    });
    const replay = await send(parent.processId, input);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { data: ExecutionStopResult }).data).toEqual({
      ...stopped,
      changed: false,
    });
    const terminal = await send(parent.processId, {
      ...input,
      expectedRevision: stopped.revision,
      reason: "Another reason",
    });
    expect(terminal.status).toBe(409);
    expect(((await terminal.json()) as { error: { details: object } }).error.details).toMatchObject(
      {
        stopRefusal: "terminal",
        currentRevision: stopped.revision,
        stopCapability: { available: false, revision: stopped.revision, reason: "terminal" },
      },
    );
    const selected = await overview(`status=stopped&search=${parent.processId}`);
    expect(selected.total).toBe(1);
    expect(selected.runs[0]).toMatchObject({ executionId: parent.processId, status: "stopped" });
    expect(flatten((await overview(`status=completed&search=${parent.processId}`)).runs)).toEqual(
      [],
    );
    const active = await overview(`search=${child.processId}`);
    expect(active.runs[0]).toMatchObject({
      executionId: parent.processId,
      status: "stopped",
      matches: false,
    });
    expect(active.runs[0].childRuns[0]).toMatchObject({
      executionId: child.processId,
      status: "waiting-agent",
      matches: true,
    });
  });

  localOwnedFixtureTest(
    "current Cyrillic default/dependency headings are searched before exact count/page and explicit names hide old headings",
    async () => {
      if (
        isExternalTarget() ||
        new URL(BASE_URL).port !== process.env.DOCKER_PORT ||
        !process.env.DOCKER_CONTAINER_NAME
      )
        throw new Error(
          "The isolated current-heading fixture requires the explicit local HTTP/Docker target",
        );
      const email = `overview-heading-${stamp}@example.test`;
      let headingOwner: string | undefined;
      let headingMCP: Awaited<ReturnType<typeof createAuthenticatedMCPClient>> | undefined;
      let headingCookie: string | undefined;
      const createdRuns: string[] = [];
      try {
        headingOwner = (await createTestUserViaApi(BASE_URL, email, PASSWORD, "Heading Owner"))
          .userId;
        headingCookie = await signInUser(BASE_URL, email, PASSWORD);
        headingMCP = await createAuthenticatedMCPClient({ email, password: PASSWORD });
        const plain = plainFlow(`Isolated heading source ${stamp}`);
        const definition = {
          ...plain,
          visibility: "private",
          variableRegistry: {
            task_prompt: {
              type: "string",
              description: "Canonical authored heading",
              default: "{{task_heading}}",
            },
            task_heading: {
              type: "string",
              description: "Current heading dependency",
              default: "Импорт квартала",
            },
          },
          progress: {
            title: "{{task_prompt}}",
            nodes: [{ id: "work", label: "Work", content: { summary: "Import the orders" } }],
          },
          nodes: plain.nodes.map((node) => ({ ...node, progressNodeId: "work" })),
        };
        const created = await callMCPTool<{ workflowId: string }>(headingMCP.client, "manage", {
          action: "create",
          workflow: definition,
        });
        expect(created).toEqual(expect.objectContaining({ workflowId: expect.any(String) }));
        const flowResponse = await fetch(
          `${BASE_URL}/api/workflows?access=mine&search=${encodeURIComponent(plain.metadata.name)}`,
          {
            headers: { Cookie: formatSessionCookie(BASE_URL, headingCookie) },
          },
        );
        expect(flowResponse.status).toBe(200);
        const flows = (
          (await flowResponse.json()) as {
            data: { workflows: Array<{ id: string; visibility: string }> };
          }
        ).data.workflows;
        expect(flows.map(({ id, visibility }) => ({ id, visibility }))).toEqual([
          { id: created.workflowId, visibility: "private" },
        ]);
        for (const note of [
          "Independent diagnostic memo A",
          "Independent diagnostic memo B",
          "Independent diagnostic memo C",
        ])
          createdRuns.push(
            (
              await startWorkflowExecutionState(headingMCP.client, created.workflowId, {
                note,
                skipNotificationCheck: true,
              })
            ).processId,
          );
        const query = `workflowId=${created.workflowId}&search=${encodeURIComponent("ИМПОРТ КВАРТАЛА")}`;
        const initial = await overview(`${query}&limit=10`, headingCookie);
        expect(initial.total).toBe(3);
        expect(initial.runs.map((run) => run.title)).toEqual([
          "Импорт квартала",
          "Импорт квартала",
          "Импорт квартала",
        ]);
        expect(
          initial.runs.every((run) => run.note?.startsWith("Independent diagnostic memo")),
        ).toBe(true);
        const detailResponse = await fetch(`${BASE_URL}/api/executions/${createdRuns[2]}`, {
          headers: { Cookie: formatSessionCookie(BASE_URL, headingCookie) },
        });
        expect(detailResponse.status).toBe(200);
        const execution = (
          (await detailResponse.json()) as {
            data: { execution: { revision: number; metadataRevisions: { taskIdentity: string } } };
          }
        ).data.execution;
        const named = await fetch(`${BASE_URL}/api/executions/${createdRuns[2]}/task-title`, {
          method: "PUT",
          headers: {
            Cookie: formatSessionCookie(BASE_URL, headingCookie),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            taskTitle: "Новая задача импорта",
            expectedRevision: execution.revision,
            expectedTaskIdentityRevision: execution.metadataRevisions.taskIdentity,
          }),
        });
        expect(named.status).toBe(200);
        const beyond = await overview(`${query}&limit=1&offset=2`, headingCookie);
        expect(beyond).toMatchObject({ total: 2, runs: [] });
        const oldHeading = await overview(`${query}&limit=10`, headingCookie);
        expect(oldHeading.runs.map((run) => run.executionId).sort()).toEqual(
          createdRuns.slice(0, 2).sort(),
        );
        const renamed = await overview(
          `workflowId=${created.workflowId}&search=${encodeURIComponent("НОВАЯ ЗАДАЧА ИМПОРТА")}`,
          headingCookie,
        );
        expect(renamed.total).toBe(1);
        expect(renamed.runs[0]).toMatchObject({
          executionId: createdRuns[2],
          title: "Новая задача импорта",
          note: "Independent diagnostic memo C",
        });
        const noteSearch = await overview(
          `workflowId=${created.workflowId}&search=${encodeURIComponent("memo C")}`,
          headingCookie,
        );
        expect(noteSearch.total).toBe(1);
        expect(noteSearch.runs[0]).toMatchObject({
          executionId: createdRuns[2],
          title: "Новая задача импорта",
        });
        expect(await overview(`${query}&limit=10`, otherCookie)).toMatchObject({
          total: 0,
          runs: [],
        });
        // Await the first actual native write, then overlap forty reads with a finite workload.
        // Exhausting the reader's generation retries is valid during those writes; after the
        // writer finishes, the same API must recover and return the current visible headings.
        let signalReady!: () => void;
        const ready = new Promise<void>((resolve) => {
          signalReady = resolve;
        });
        let writerOutput = "";
        const writer = dockerExecAsync(
          [
            "node",
            "--input-type=commonjs",
            "-e",
            `
        (async()=>{
          const {owner,ids}=JSON.parse(process.argv[1]);
          const db=new (require('better-sqlite3'))('/app/data/moira.db');
          db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
          try {
              const update=db.prepare("UPDATE workflowExecution SET context=json_set(context,'$.variables.task_heading',?,'$.variables.task_prompt',?) WHERE userId=? AND executionId IN (?,?) AND state='running'");
            const startedAt=Date.now();
            let turn=0;
            let lastMutationAt=startedAt;
            while(turn<24) {
                const title=turn%2===0?'Импорт квартала':'Другой квартал';
                const changed=db.transaction(()=>update.run(title,title,owner,...ids).changes)();
              if(changed!==2) throw new Error('Heading writer lost its exact owned rows');
              lastMutationAt=Date.now();
              if(turn===0) console.log('heading-writer-ready');
              turn++;
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            console.log(JSON.stringify({updates:turn,rows:2,startedAt,lastMutationAt,finishedAt:Date.now()}));
          } finally { db.close(); }
        })().catch(error=>{console.error(error);process.exitCode=1;});
      `,
            JSON.stringify({ owner: headingOwner, ids: createdRuns.slice(0, 2) }),
          ],
          undefined,
          (chunk) => {
            writerOutput += chunk;
            if (writerOutput.includes("heading-writer-ready\n")) signalReady();
          },
        );
        await Promise.race([
          ready,
          writer.then(() => {
            throw new Error("Heading writer exited before signaling readiness");
          }),
        ]);
        const readers = (async () => {
          let refused = 0;
          const successful: number[] = [];
          const latencies: number[] = [];
          for (let request = 0; request < 40; request++) {
            const started = performance.now();
            const response = await fetch(`${BASE_URL}/api/executions/overview?${query}&limit=10`, {
              headers: { Cookie: formatSessionCookie(BASE_URL, headingCookie!) },
            });
            const body = (await response.json()) as {
              success: boolean;
              data: Page;
              error?: { message: string };
            };
            const elapsed = performance.now() - started;
            latencies.push(elapsed);
            expect(elapsed).toBeLessThanOrEqual(500);
            if (response.status === 409) {
              refused++;
              expect(body.success).toBe(false);
              expect(body.error?.message).toMatch(/changed while reading/);
              continue;
            }
            expect(response.status).toBe(200);
            expect([0, 2]).toContain(body.data.total);
            expect(body.data.runs).toHaveLength(body.data.total);
            expect(body.data.runs.map((run) => run.executionId).sort()).toEqual(
              body.data.total === 2 ? createdRuns.slice(0, 2).sort() : [],
            );
            expect(
              body.data.runs.every((run) => run.matches && run.title === "Импорт квартала"),
            ).toBe(true);
            if (typeof body.data.evaluatedAt !== "number")
              throw new Error("The authoritative overview clock is missing");
            successful.push(body.data.evaluatedAt);
          }
          return { refused, successful, latencies };
        })();
        // Always await BOTH real operations before public stop/owned-row cleanup, even on failure.
        const [writeOutcome, readOutcome] = await Promise.allSettled([writer, readers]);
        if (writeOutcome.status === "rejected") throw writeOutcome.reason;
        if (readOutcome.status === "rejected") throw readOutcome.reason;
        const written = JSON.parse(writeOutcome.value.trim().split("\n").at(-1)!) as {
          updates: number;
          rows: number;
          startedAt: number;
          lastMutationAt: number;
          finishedAt: number;
        };
        expect(written.rows).toBe(2);
        expect(written.updates).toBe(24);
        expect(readOutcome.value.successful.length + readOutcome.value.refused).toBe(40);
        expect(written.lastMutationAt).toBeLessThanOrEqual(written.finishedAt);
        // Only the actual mutation interval counts as overlap, never later process occupancy.
        // Zero successes in that interval is an honest, permitted conflict result.
        const overlapping = readOutcome.value.successful.filter(
          (at) => at >= written.startedAt && at <= written.lastMutationAt,
        );
        const recoveryLatencies: number[] = [];
        const recoveredOverview = async (recoveryQuery: string) => {
          const started = performance.now();
          const page = await overview(recoveryQuery, headingCookie);
          const elapsed = performance.now() - started;
          recoveryLatencies.push(elapsed);
          expect(elapsed).toBeLessThanOrEqual(500);
          return page;
        };
        // A resolved initial default cannot make this pass as a storage-only writer: the actual
        // progress.title input is updated too, and the final B heading must replace initial A.
        expect(await recoveredOverview(`${query}&limit=10`)).toMatchObject({
          total: 0,
          runs: [],
        });
        const finalHeading = await recoveredOverview(
          `workflowId=${created.workflowId}&search=${encodeURIComponent("ДРУГОЙ КВАРТАЛ")}&limit=10`,
        );
        expect(finalHeading.total).toBe(2);
        expect(finalHeading.runs.map((run) => run.executionId).sort()).toEqual(
          createdRuns.slice(0, 2).sort(),
        );
        expect(finalHeading.runs.every((run) => run.title === "Другой квартал")).toBe(true);
        for (const id of createdRuns.slice(0, 2)) {
          const response = await fetch(`${BASE_URL}/api/executions/${id}`, {
            headers: { Cookie: formatSessionCookie(BASE_URL, headingCookie) },
          });
          expect(response.status).toBe(200);
          const execution = (
            (await response.json()) as {
              data: { execution: { context: { variables: Record<string, unknown> } } };
            }
          ).data.execution;
          expect(execution.context.variables).toMatchObject({
            task_prompt: "Другой квартал",
            task_heading: "Другой квартал",
          });
        }
        console.log(
          JSON.stringify({
            kind: "current-heading-concurrency",
            requests: 40,
            successful: readOutcome.value.successful.length,
            refused409: readOutcome.value.refused,
            overlappingSuccessful: overlapping.length,
            writerUpdates: written.updates,
            mutationStartedAt: written.startedAt,
            mutationFinishedAt: written.lastMutationAt,
            writerFinishedAt: written.finishedAt,
            recoverySuccessful: recoveryLatencies.length,
            maximumRecoveryMs: Math.max(...recoveryLatencies),
            maximumResponseMs: Math.max(...readOutcome.value.latencies),
            budgetMs: 500,
          }),
        );
      } finally {
        try {
          // Finish real starts through the public stop so the active gauge follows the fixture.
          if (headingCookie)
            for (const id of createdRuns) {
              const detailResponse = await fetch(`${BASE_URL}/api/executions/${id}`, {
                headers: { Cookie: formatSessionCookie(BASE_URL, headingCookie) },
              });
              expect(detailResponse.status).toBe(200);
              const execution = (
                (await detailResponse.json()) as { data: { execution: { revision: number } } }
              ).data.execution;
              const stopped = await fetch(`${BASE_URL}/api/executions/${id}/stop`, {
                method: "POST",
                headers: {
                  Cookie: formatSessionCookie(BASE_URL, headingCookie),
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  expectedRevision: execution.revision,
                  reason: "Current-heading HTTP fixture cleanup",
                }),
              });
              expect(stopped.status).toBe(200);
            }
        } finally {
          await headingMCP?.cleanup();
          if (headingOwner)
            dockerExecSync([
              "node",
              "--input-type=commonjs",
              "-e",
              `
          const db=new (require('better-sqlite3'))('/app/data/moira.db');
          db.pragma('busy_timeout=5000'); db.pragma('foreign_keys=ON');
          db.transaction(()=>{
            db.prepare('DELETE FROM workflowExecution WHERE userId=?').run(process.argv[1]);
            db.prepare('DELETE FROM workflow WHERE userId=?').run(process.argv[1]);
            db.prepare('DELETE FROM user WHERE id=?').run(process.argv[1]);
          })(); db.close();
        `,
              headingOwner,
            ]);
        }
      }
    },
  );
  localOwnedFixtureTest(
    "ordinary and administrator mixed locked/stopped lists preserve both stored markers",
    async () => {
      if (new URL(BASE_URL).port !== process.env.DOCKER_PORT || !process.env.DOCKER_CONTAINER_NAME)
        throw new Error("The owned status fixture requires the explicit local HTTP/Docker target");
      const prefix = `mixed-stopped-${randomUUID()}`;
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const workflowId = await create({ ...plainFlow(prefix), visibility: "private" });
      let fixtureOwner: string | undefined;
      try {
        fixtureOwner = JSON.parse(
          dockerExecSync([
            "node",
            "--input-type=commonjs",
            "-e",
            `
        const db=new(require('better-sqlite3'))('/app/data/moira.db');
        console.log(JSON.stringify(db.prepare('SELECT userId FROM workflow WHERE id=?').get(process.argv[1]).userId));db.close();
      `,
            workflowId,
          ]),
        ) as string;
        const scope = JSON.stringify({
          workflowId,
          owner: fixtureOwner,
          ids,
          prefix,
          now: Date.now(),
        });
        dockerExecSync([
          "node",
          "--input-type=commonjs",
          "-e",
          `
        const p=JSON.parse(process.argv[1]);const db=new(require('better-sqlite3'))('/app/data/moira.db');
        db.pragma('foreign_keys=ON');
        const insert=db.prepare('INSERT INTO workflowExecution (executionId,workflowId,userId,state,context,visits,createdAt,updatedAt,lastActivityAt,completedAt,note,stopReason,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)');
        db.transaction(()=>{p.ids.forEach((id,i)=>insert.run(id,p.workflowId,p.owner,i===0?'completed':'running',JSON.stringify({variables:{},nodeStates:{},executionId:id,workflowId:p.workflowId,userId:p.owner}),'[]',p.now+i,p.now,p.now,i===0?p.now:null,p.prefix,i===0?'Intentional fixture stop':i===1?'':null));})();db.close();
      `,
          scope,
        ]);
        const snapshot = () =>
          dockerExecSync([
            "node",
            "--input-type=commonjs",
            "-e",
            `
        const p=JSON.parse(process.argv[1]);const db=new(require('better-sqlite3'))('/app/data/moira.db');
        console.log(JSON.stringify(db.prepare('SELECT * FROM workflowExecution WHERE workflowId=? AND userId=? ORDER BY executionId').all(p.workflowId,p.owner)));db.close();
      `,
            scope,
          ]);
        const before = snapshot();
        const administrator = await getAdminSessionCookie(BASE_URL);
        for (const surface of ["ordinary", "admin"] as const) {
          for (const status of ["stopped", "locked,stopped"]) {
            const params = new URLSearchParams({ status, search: prefix, limit: "100" });
            if (surface === "ordinary") {
              params.set("workflowId", workflowId);
              params.set("mine", "true");
            } else params.set("userId", fixtureOwner);
            const response = await fetch(
              `${BASE_URL}/api/${surface === "ordinary" ? "executions" : "admin/executions"}?${params}`,
              {
                headers: {
                  Cookie: formatSessionCookie(
                    BASE_URL,
                    surface === "ordinary" ? cookie : administrator,
                  ),
                },
              },
            );
            expect(response.status).toBe(200);
            const result = (
              (await response.json()) as {
                data: {
                  total: number;
                  executions: Array<{
                    executionId: string;
                    status: string;
                    displayStatus: string;
                    stopReason: string | null;
                  }>;
                };
              }
            ).data;
            expect(result.total).toBe(2);
            expect(result.executions.map((row) => row.executionId).sort()).toEqual(
              ids.slice(0, 2).sort(),
            );
            expect(result.executions).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  executionId: ids[0],
                  status: "completed",
                  displayStatus: "stopped",
                  stopReason: "Intentional fixture stop",
                }),
                expect.objectContaining({
                  executionId: ids[1],
                  status: "running",
                  displayStatus: "stopped",
                  stopReason: "",
                }),
              ]),
            );
            expect(result.executions.map((row) => row.executionId)).not.toContain(ids[2]);
          }
        }
        expect(snapshot()).toBe(before);
      } finally {
        // These native-only fixtures emit no start/gauge effects and are removed by exact scope.
        const remaining = JSON.parse(
          dockerExecSync([
            "node",
            "--input-type=commonjs",
            "-e",
            `
        const {workflowId,owner}=JSON.parse(process.argv[1]);const db=new(require('better-sqlite3'))('/app/data/moira.db');
        db.pragma('foreign_keys=ON');db.transaction(()=>{
          db.prepare('DELETE FROM workflowExecution WHERE workflowId=? AND userId=?').run(workflowId,owner);
          db.prepare('DELETE FROM workflow WHERE id=? AND userId=?').run(workflowId,owner);
        })();console.log(JSON.stringify({rows:db.prepare('SELECT COUNT(*) AS n FROM workflowExecution WHERE workflowId=?').get(workflowId).n,workflow:db.prepare('SELECT COUNT(*) AS n FROM workflow WHERE id=?').get(workflowId).n}));db.close();
      `,
            JSON.stringify({ workflowId, owner: fixtureOwner }),
          ]),
        );
        expect(remaining).toEqual({ rows: 0, workflow: 0 });
      }
    },
  );
});
