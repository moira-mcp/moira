/** @jest-environment jsdom */
/**
 * The block panel's run facts: the passes the run made through a block with their durations, the
 * list the block is bound to, what the route recorded in the block, and the typical durations of
 * the version. Each renders only what the projection carries: a run recorded before timestamps
 * existed shows "—" everywhere instead of claiming instant passes, a binding that resolves
 * counters but no items shows the counters alone, and a version nobody has finished yet says so.
 */
import { describe, expect, test, beforeAll } from "@jest/globals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import React from "react";
import i18n from "../../../packages/web-frontend/src/i18n";
import { BlockTimings } from "../../../packages/web-frontend/src/components/run/BlockTimings.js";
import { BlockListCard } from "../../../packages/web-frontend/src/components/run/BlockListCard.js";
import { BlockRouteFacts } from "../../../packages/web-frontend/src/components/run/BlockRouteFacts.js";
import { TypicalDurations } from "../../../packages/web-frontend/src/components/run/TypicalDurations.js";
import type {
  RunBlock,
  RunList,
  RunTiming,
  WorkflowVersionStatistics,
} from "../../../packages/web-frontend/src/components/run/model.js";
import type { ExecutionRouteEntry } from "@mcp-moira/workflow-engine/progress-visual";

const NO_TIMING: RunTiming = { passes: [], totalMs: null, currentMs: null, recorded: false };

function block(over: Partial<RunBlock> = {}): RunBlock {
  return {
    id: "review",
    index: 2,
    name: "Review",
    description: "Check the work against the plan.",
    nodeIds: ["review-step"],
    transitions: [{ to: "ship", label: "approved", edges: ["review-step.approved"] }],
    status: "active",
    iterations: 2,
    visits: 3,
    currentNodeId: "review-step",
    content: { summary: null, details: [], outcome: null, next: null },
    timing: NO_TIMING,
    list: null,
    ...over,
  };
}

/** Two closed passes and the open one the run is on now. */
const MEASURED: RunTiming = {
  passes: [
    {
      seq: 3,
      nodeId: "review-step",
      enteredAt: 1_000,
      leftAt: 13_000,
      durationMs: 12_000,
      open: false,
      itemIndex: 0,
    },
    {
      seq: 7,
      nodeId: "review-step",
      enteredAt: 20_000,
      leftAt: 100_000,
      durationMs: 80_000,
      open: false,
      itemIndex: 1,
    },
    {
      seq: 11,
      nodeId: "review-step",
      enteredAt: 120_000,
      leftAt: null,
      durationMs: 5_000,
      open: true,
      itemIndex: 2,
    },
  ],
  totalMs: 97_000,
  currentMs: 5_000,
  recorded: true,
};

const STATISTICS: WorkflowVersionStatistics = {
  workflowId: "wf",
  workflowVersion: "1.2.0",
  sampledRuns: 4,
  versionNotRecorded: 0,
  blocks: [
    {
      blockId: "review",
      pass: {
        sampleCount: 6,
        medianMs: 30_000,
        p25Ms: 20_000,
        p75Ms: 45_000,
        minMs: 10_000,
        maxMs: 60_000,
      },
      run: {
        sampleCount: 4,
        medianMs: 120_000,
        p25Ms: 90_000,
        p75Ms: 150_000,
        minMs: 60_000,
        maxMs: 200_000,
      },
      typicalPasses: 2,
      items: [],
    },
  ],
  computedAt: 1_700_000_000_000,
};

function view(ui: React.ReactElement): void {
  render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("BlockTimings", () => {
  test("lists every pass with its duration, marks the open one and totals them", () => {
    view(<BlockTimings block={block({ timing: MEASURED })} cursor={null} />);
    const passes = screen.getAllByTestId("block-timing-pass");
    expect(passes).toHaveLength(3);
    expect(
      passes.map((row) => within(row).getByTestId("block-timing-pass-duration").textContent),
    ).toEqual(["12 s", "1 min 20 s", "5 s"]);
    expect(passes[2].getAttribute("data-open")).toBe("true");
    expect(within(passes[2]).getByText("in progress")).toBeDefined();
    expect(screen.getByTestId("block-timing-total").textContent).toBe("1 min 37 s");
    expect(screen.getByTestId("block-timing-current").textContent).toBe("5 s");
  });

  test("a run without timestamps reads as unmeasured, never as instant", () => {
    view(
      <BlockTimings
        block={block({
          timing: {
            passes: [
              {
                seq: 3,
                nodeId: "review-step",
                enteredAt: null,
                leftAt: null,
                durationMs: null,
                open: false,
                itemIndex: null,
              },
            ],
            totalMs: null,
            currentMs: null,
            recorded: false,
          },
        })}
        cursor={null}
      />,
    );
    expect(screen.getByTestId("block-timings").getAttribute("data-recorded")).toBe("false");
    expect(screen.getByTestId("block-timing-pass-duration").textContent).toBe("—");
    expect(screen.getByTestId("block-timing-total").textContent).toBe("—");
    expect(screen.queryByText("0 s")).toBeNull();
  });

  test("the version's typical pass and run stand beside the measured ones", () => {
    view(
      <BlockTimings block={block({ timing: MEASURED })} statistics={STATISTICS} cursor={null} />,
    );
    expect(screen.getByTestId("block-timing-typical").textContent).toContain("30 s per pass");
    expect(screen.getByTestId("block-timing-typical").textContent).toContain("2 min per run");
  });

  test("an unsampled entry (a version nobody finished) shows no typical durations", () => {
    const zero = {
      sampleCount: 0,
      medianMs: null,
      p25Ms: null,
      p75Ms: null,
      minMs: null,
      maxMs: null,
    };
    const unsampled: WorkflowVersionStatistics = {
      ...STATISTICS,
      sampledRuns: 0,
      blocks: [{ blockId: "review", pass: zero, run: zero, typicalPasses: null, items: [] }],
    };
    view(<BlockTimings block={block({ timing: MEASURED })} statistics={unsampled} cursor={null} />);
    expect(screen.queryByTestId("block-timing-typical")).toBeNull();
    expect(screen.getByTestId("block-timings").textContent).not.toContain("typically");
  });

  test("a block the statistics do not carry shows no typical durations", () => {
    view(
      <BlockTimings
        block={block({ id: "ship", timing: MEASURED })}
        statistics={STATISTICS}
        cursor={null}
      />,
    );
    expect(screen.queryByTestId("block-timing-typical")).toBeNull();
  });
});

describe("BlockListCard", () => {
  const items: RunList = {
    items: [
      { index: 0, title: "Read the brief", done: true, current: false, durationMs: 12_000 },
      { index: 1, title: "Write the patch", done: false, current: true, durationMs: 80_000 },
      { index: 2, title: "Run the tests", done: false, current: false, durationMs: null },
    ],
    done: 1,
    total: 3,
    current: 1,
    currentTitle: "Write the patch",
  };

  test("shows done of total, the items, the current one and each item's time", () => {
    view(<BlockListCard block={block({ list: items })} />);
    expect(screen.getByTestId("block-list-progress").textContent).toBe("1 of 3 done");
    const rows = screen.getAllByTestId("block-list-item");
    expect(rows.map((row) => row.getAttribute("data-current"))).toEqual(["false", "true", "false"]);
    expect(
      rows.map((row) => within(row).getByTestId("block-list-item-duration").textContent),
    ).toEqual(["12 s", "1 min 20 s", "—"]);
  });

  test("a binding that resolves counters but no items shows the counters alone", () => {
    view(
      <BlockListCard
        block={block({
          list: { items: null, done: 2, total: 5, current: 2, currentTitle: null },
        })}
      />,
    );
    expect(screen.getByTestId("block-list-progress").textContent).toBe("2 of 5 done");
    expect(screen.getByTestId("block-list-counters-only")).toBeDefined();
    expect(screen.queryAllByTestId("block-list-item")).toHaveLength(0);
  });

  test("a block that binds no list renders nothing", () => {
    view(<BlockListCard block={block()} />);
    expect(screen.queryByTestId("block-list")).toBeNull();
  });
});

describe("BlockRouteFacts", () => {
  const route: ExecutionRouteEntry[] = [
    { seq: 3, nodeId: "review-step", blockId: "review", exitKey: "approved", changed: ["verdict"] },
    { seq: 5, nodeId: "ship-step", blockId: "ship", exitKey: null, changed: [] },
    {
      seq: 7,
      nodeId: "review-step",
      blockId: "review",
      exitKey: null,
      changed: [],
      waited: true,
      loop: true,
    },
  ];

  test("lists the block's own visits with the exit in the transition's words", () => {
    view(
      <BlockRouteFacts block={block()} route={route} cursor={null} onSetCursor={() => undefined} />,
    );
    const visits = screen.getAllByTestId("block-route-visit");
    expect(visits.map((row) => row.getAttribute("data-seq"))).toEqual(["3", "7"]);
    expect(screen.getByTestId("block-route-exit").textContent).toContain("approved");
    expect(screen.getByTestId("block-route-changed").textContent).toContain("verdict");
    expect(within(visits[1]).getByTestId("block-route-loop")).toBeDefined();
  });

  test("a visit moves the cursor to itself", () => {
    const moves: Array<number | null> = [];
    view(
      <BlockRouteFacts
        block={block()}
        route={route}
        cursor={null}
        onSetCursor={(at) => moves.push(at)}
      />,
    );
    fireEvent.click(screen.getByText("#7"));
    expect(moves).toEqual([7]);
  });

  test("a block the route never entered says so", () => {
    view(
      <BlockRouteFacts
        block={block({ id: "ship" })}
        route={[route[0]]}
        cursor={null}
        onSetCursor={() => undefined}
      />,
    );
    expect(screen.getByTestId("block-route-facts-empty")).toBeDefined();
  });
});

describe("TypicalDurations", () => {
  test("reads the block's typical pass, run and pass count from the sample", () => {
    view(<TypicalDurations blockId="review" statistics={STATISTICS} />);
    expect(screen.getByTestId("typical-pass").textContent).toBe("30 s");
    expect(screen.getByTestId("typical-run").textContent).toBe("2 min");
    expect(screen.getByTestId("typical-passes").textContent).toBe("×2");
    expect(screen.getByTestId("typical-sample").textContent).toContain("6");
  });

  test("an empty sample says there are no runs yet instead of showing a zero", () => {
    const empty: WorkflowVersionStatistics = {
      ...STATISTICS,
      sampledRuns: 0,
      blocks: [
        {
          blockId: "review",
          pass: {
            sampleCount: 0,
            medianMs: null,
            p25Ms: null,
            p75Ms: null,
            minMs: null,
            maxMs: null,
          },
          run: {
            sampleCount: 0,
            medianMs: null,
            p25Ms: null,
            p75Ms: null,
            minMs: null,
            maxMs: null,
          },
          typicalPasses: null,
          items: [],
        },
      ],
    };
    view(<TypicalDurations blockId="review" statistics={empty} />);
    expect(screen.getByTestId("typical-durations-empty").textContent).toBe("no runs yet");
    expect(screen.queryByTestId("typical-pass")).toBeNull();
  });

  test("statistics that were not loaded read the same as an empty sample", () => {
    view(<TypicalDurations blockId="review" statistics={null} />);
    expect(screen.getByTestId("typical-durations-empty")).toBeDefined();
  });

  test("a fetch in progress and a failed fetch are worded as such, never as no runs", () => {
    view(<TypicalDurations blockId="review" statistics={null} pending />);
    expect(screen.getByTestId("typical-durations-pending").textContent).toBe(
      "loading typical durations…",
    );
    expect(screen.queryByTestId("typical-durations-empty")).toBeNull();
    cleanup();
    view(<TypicalDurations blockId="review" statistics={null} error="HTTP 500" />);
    expect(screen.getByTestId("typical-durations-error").textContent).toBe(
      "typical durations unavailable",
    );
    expect(screen.getByTestId("typical-durations-error").getAttribute("title")).toBe("HTTP 500");
    expect(screen.queryByTestId("typical-durations-empty")).toBeNull();
  });
});
