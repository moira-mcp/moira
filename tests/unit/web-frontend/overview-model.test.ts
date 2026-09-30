/**
 * The overview's view model: the plan window a card shows around the current item in a fixed
 * number of lines, the placement of a run tree as groups and nested groups, the filters kept in the
 * URL, and refreshed rows taking the place of their old copies.
 */

import { describe, expect, test } from "@jest/globals";
import type { OverviewRun } from "../../../packages/web-frontend/src/services/api-client.js";
import {
  boardNode,
  cardPlan,
  DEFAULT_FILTERS,
  filtersFromParams,
  isStale,
  flattenRuns,
  paramsWithFilters,
  planLines,
  planRows,
  planSlots,
  stageItems,
  replaceRows,
  withoutRun,
  type BoardNode,
  type PlanItem,
  type PlanRow,
} from "../../../packages/web-frontend/src/components/overview/model.js";

function items(count: number, current: number | null, doneBefore = current ?? count): PlanItem[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    title: `Item ${index + 1}`,
    done: index < doneBefore,
    current: index === current,
    durationMs: null,
  }));
}

/** The overview sends at most five items around the current one; the card sees only those. */
function serverWindow(all: PlanItem[], size = 5): PlanItem[] {
  const current = all.findIndex((item) => item.current);
  const at = current < 0 ? all.length - 1 : current;
  const start = Math.max(0, Math.min(at - Math.floor(size / 2), all.length - size));
  return all.slice(start, start + size);
}

/** The rows as text: `↑N`, `[3*]` for the current item (`**` when it takes two lines), `↓N`. */
function shape(rows: PlanRow[]): string[] {
  return rows.map((row) =>
    row.kind === "above"
      ? `↑${row.count}`
      : row.kind === "below"
        ? `↓${row.count}`
        : `${row.item.index + 1}${row.item.current ? (row.twoLines ? "**" : "*") : ""}`,
  );
}

function run(id: string, overrides: Partial<OverviewRun> = {}): OverviewRun {
  return {
    executionId: id,
    workflowId: "wf",
    workflowName: "Order import",
    workflowVersion: "1.0.0",
    title: `Import ${id}`,
    status: "waiting-agent",
    stopReason: null,
    matches: true,
    waitingForUser: null,
    refusalCount: 0,
    note: null,
    current: { stepName: "Map the columns", directiveShownAt: 1 },
    stages: null,
    list: null,
    lastActivityAt: 1,
    subtreeActivityAt: 1,
    createdAt: 1,
    completedAt: null,
    parentExecutionId: null,
    parent: null,
    children: { total: 0, unfinished: 0 },
    childRuns: [],
    ...overrides,
  };
}

describe("the plan window of a card", () => {
  test.each([
    [
      "the tenth of ten items, the list sent whole",
      items(10, 9),
      10,
      6,
      ["↑5", "6", "7", "8", "9", "10*"],
    ],
    [
      "the fifth of ten items, as the overview sends it",
      serverWindow(items(10, 4)),
      10,
      6,
      ["↑3", "4", "5*", "6", "7", "↓3"],
    ],
    ["the first of ten items", serverWindow(items(10, 0)), 10, 5, ["1*", "2", "3", "4", "↓6"]],
    ["the last of ten items", serverWindow(items(10, 9)), 10, 5, ["↑6", "7", "8", "9", "10*"]],
    ["three items, all fitting", items(3, 1), 3, 6, ["1", "2*", "3"]],
  ])("%s: centred on the current item, the rest folded", (_name, list, total, slots, expected) => {
    const rows = planRows(list, total, slots, false);
    expect(shape(rows)).toEqual(expected);
    expect(planLines(rows)).toBeLessThanOrEqual(slots);
  });

  test("a long current item takes two lines and the window gives up a row for it", () => {
    const list = serverWindow(items(10, 4)).map((item) =>
      item.current
        ? { ...item, title: "Reconcile the regional revenue with the sales team's figures" }
        : item,
    );
    const rows = planRows(list, 10, 6, false);
    expect(shape(rows)).toEqual(["↑3", "4", "5**", "6", "↓4"]);
    expect(planLines(rows)).toBe(6);
  });

  test("a finished run with no current item shows the end of its list", () => {
    const rows = planRows(serverWindow(items(10, null, 10)), 10, 6, true);
    expect(shape(rows)).toEqual(["↑5", "6", "7", "8", "9", "10"]);
  });

  test("an unfinished run with no current item stands on the first item not done", () => {
    const rows = planRows(items(10, null, 3), 10, 5, false);
    expect(shape(rows)).toEqual(["↑2", "3", "4", "5", "↓5"]);
  });

  test("the plan has one line more when no strip row sits above it", () => {
    const withList = run("a", {
      list: { title: "Checklist", done: 1, total: 3, items: items(3, 1, 1) },
    });
    const withListAndStages = run("b", {
      list: withList.list,
      stages: { labels: ["Plan", "Work", "Check"], activeIndex: 1, doneCount: 1 },
    });
    const waiting = run("c", {
      status: "waiting-user",
      waitingForUser: { source: "gate", label: "Approve the plan", notification: null },
      stages: withListAndStages.stages,
    });
    expect(planSlots(withList)).toBe(6);
    expect(planSlots(withListAndStages)).toBe(5);
    expect(planSlots(waiting)).toBe(5);
    // Without a list the stages themselves are the plan, marked done up to the active one.
    const plan = cardPlan(waiting);
    expect(plan.kind).toBe("stages");
    expect(plan.kind === "stages" && plan.items.map((item) => [item.done, item.current])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });
});

/** The placement as text: a group lists its card, then its children; `…N` is a folded group. */
function placement(node: BoardNode): unknown {
  if (node.kind === "card") return node.run.executionId;
  const folded = node.foldable ? `…${node.descendants}` : null;
  return [node.run.executionId, ...(folded ? [folded] : []), ...node.children.map(placement)];
}

describe("a run tree on the board", () => {
  const tree = run("root", {
    childRuns: [
      run("branch", {
        childRuns: [run("deep", { childRuns: [run("deeper")] }), run("leaf-2")],
      }),
      run("leaf-1"),
    ],
  });

  test("children without children come before nested groups, and each run appears once", () => {
    expect(placement(boardNode(tree))).toEqual([
      "root",
      "leaf-1",
      ["branch", "leaf-2", ["deep", "…1", "deeper"]],
    ]);
    expect(
      flattenRuns([tree])
        .map((entry) => entry.executionId)
        .sort(),
    ).toEqual(["branch", "deep", "deeper", "leaf-1", "leaf-2", "root"].sort());
  });

  test("only groups from the third level on start folded", () => {
    const root = boardNode(tree);
    const levels: Array<[number, boolean]> = [];
    const visit = (node: BoardNode) => {
      if (node.kind !== "group") return;
      levels.push([node.depth, node.foldable]);
      node.children.forEach(visit);
    };
    visit(root);
    expect(levels).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
  });

  test("a refreshed row keeps where it sits in the tree: dimmed or not, and the parent it names", () => {
    const tree = [
      run("root", {
        parent: { executionId: "gone", title: "Import the catalog" },
        childRuns: [run("muted", { matches: false })],
      }),
    ];
    const fresh = new Map([
      ["root", run("root", { title: "Import renamed" })],
      ["muted", run("muted", { title: "Muted renamed" })],
    ]);
    const [root] = replaceRows(tree, fresh);
    expect(root.title).toBe("Import renamed");
    expect(root.parent).toEqual({ executionId: "gone", title: "Import the catalog" });
    expect(root.childRuns[0].title).toBe("Muted renamed");
    expect(root.childRuns[0].matches).toBe(false);
  });

  test("a refreshed row replaces its copy and keeps the children already on the page", () => {
    const fresh = run("branch", { title: "Import renamed", childRuns: [] });
    const [replaced] = replaceRows([tree], new Map([["branch", fresh]]));
    const branch = replaced.childRuns.find((child) => child.executionId === "branch")!;
    expect(branch.title).toBe("Import renamed");
    expect(branch.childRuns.map((child) => child.executionId)).toEqual(["deep", "leaf-2"]);
    expect(flattenRuns(withoutRun([tree], "deep")).map((entry) => entry.executionId)).not.toContain(
      "deeper",
    );
  });
});

describe("the filters in the URL", () => {
  test("stopped is an explicit filter and the default remains in progress", () => {
    expect(filtersFromParams(new URLSearchParams()).status).toBe("active");
    expect(filtersFromParams(new URLSearchParams("status=stopped")).status).toBe("stopped");
    expect(
      paramsWithFilters(new URLSearchParams(), { ...DEFAULT_FILTERS, status: "stopped" }).get(
        "status",
      ),
    ).toBe("stopped");
  });
  test("every filter survives a trip through the URL, and defaults stay out of it", () => {
    const filters = {
      ...DEFAULT_FILTERS,
      status: "waiting-user" as const,
      idle: "7d" as const,
      activeFrom: 1_700_000_000_000,
      activeTo: 1_700_100_000_000,
      workflowId: "wf-1",
      sort: "idle" as const,
      refusals: true,
      search: "orders",
      layout: "lanes" as const,
      page: 3,
    };
    const params = paramsWithFilters(new URLSearchParams("run=abc&guide=overview"), filters);
    expect(filtersFromParams(params)).toEqual(filters);
    // What is not a filter is kept.
    expect(params.get("run")).toBe("abc");
    expect(params.get("guide")).toBe("overview");
    expect(paramsWithFilters(new URLSearchParams(), DEFAULT_FILTERS).toString()).toBe("");
  });

  test("unknown or malformed values read as the defaults", () => {
    expect(
      filtersFromParams(
        new URLSearchParams(
          "status=nonsense&idle=2d&sort=name&layout=table&activeFrom=yesterday&page=-4",
        ),
      ),
    ).toEqual(DEFAULT_FILTERS);
  });
});

describe("stopped runs", () => {
  test("preserve completed stages without marking the remaining stages current or done", () => {
    const stopped = run("stopped", {
      status: "stopped",
      stopReason: "The user changed the task",
      stages: { labels: ["Plan", "Work", "Check"], activeIndex: 1, doneCount: 1 },
    });
    expect(stageItems(stopped).map(({ done, current }) => [done, current])).toEqual([
      [true, false],
      [false, false],
      [false, false],
    ]);
    expect(isStale(stopped, 30 * 24 * 60 * 60_000)).toBe(false);
    expect(stageItems({ ...stopped, status: "completed" }).every((item) => item.done)).toBe(true);
  });

  test("a stopped checklist retains its results but no longer has a current item", () => {
    const plan = cardPlan(
      run("stopped", {
        status: "stopped",
        list: { title: "Plan", done: 1, total: 3, items: items(3, 1, 1) },
      }),
    );
    expect(plan).toMatchObject({ kind: "list", done: 1, total: 3 });
    expect(plan.kind === "list" && plan.items.map(({ done, current }) => [done, current])).toEqual([
      [true, false],
      [false, false],
      [false, false],
    ]);
  });
});
