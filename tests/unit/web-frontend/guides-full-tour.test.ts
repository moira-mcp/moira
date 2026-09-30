/**
 * The full tour's chain: which screens it visits, in which order, and where each leg opens for a
 * given reader. The chain is data, so these hold it to the coverage list and to the route table
 * without a browser; walking it through the real app is the E2E's.
 */

import { describe, expect, test } from "@jest/globals";
import { GUIDES, guideById } from "../../../packages/web-frontend/src/guides/registry.js";
import {
  FULL_TOUR_LEGS,
  legOf,
  targetOf,
  tourGuideIds,
  type TourContext,
} from "../../../packages/web-frontend/src/guides/fullTour.js";
import { ALL_ROUTES } from "../../../packages/web-frontend/src/routes/routeTable.js";

const context = (latest: string | null, slug = "example-simple-steps"): TourContext => ({
  exampleFlowSlug: () => slug,
  latestRunId: async () => latest,
});

describe("the full tour", () => {
  test("visits every toured main-app screen once, in the order a reader meets them", () => {
    expect(FULL_TOUR_LEGS.map((leg) => leg.guide)).toEqual([
      "home",
      "overview",
      "flows",
      "flow",
      "runs",
      "run",
      "notes",
      "playbooks",
      "artifacts",
      "settings",
    ]);
    // Every screen the route table tours is in the chain; no admin route is.
    const toured = new Set(
      ALL_ROUTES.flatMap((route) => ("screen" in route.coverage ? [route.coverage.screen] : [])),
    );
    const screens = FULL_TOUR_LEGS.map((leg) => guideById(leg.guide)!.screen);
    expect(new Set(screens)).toEqual(toured);
    for (const leg of FULL_TOUR_LEGS) {
      expect(guideById(leg.guide)?.kind).toBe("screen");
      if (leg.stop.kind === "fixed") expect(leg.stop.path.startsWith("/admin")).toBe(false);
    }
  });

  test("runs every guide it names, a leg's fallback included", () => {
    for (const id of tourGuideIds()) expect(GUIDES.map((guide) => guide.id)).toContain(id);
    expect(tourGuideIds()).toContain("runs-empty");
    expect(legOf("runs-empty")).toBe(legOf("run"));
    expect(legOf("settings-github")).toBe(-1);
  });

  test.each([
    ["the home page", "home", context(null), { guide: "home", path: "/" }],
    [
      "the flow page on the example of the reader's language",
      "flow",
      context(null, "example-simple-steps-ru"),
      { guide: "flow", path: "/workflows/moira/example-simple-steps-ru" },
    ],
    [
      "the run page on the latest run",
      "run",
      context("0d4c 7a1e"),
      { guide: "run", path: "/executions/0d4c%207a1e" },
    ],
    [
      "the runs list's first-run step for a reader with no run",
      "run",
      context(null),
      { guide: "runs-empty", path: "/executions" },
    ],
  ])("opens %s", async (_label, guide, tourContext, expected) => {
    const leg = FULL_TOUR_LEGS.find((candidate) => candidate.guide === guide)!;
    expect(await targetOf(leg, tourContext)).toEqual(expected);
  });

  test("falls back to the runs list when the latest run cannot be read", async () => {
    const leg = FULL_TOUR_LEGS.find((candidate) => candidate.guide === "run")!;
    const failing: TourContext = {
      exampleFlowSlug: () => "example-simple-steps",
      latestRunId: () => Promise.reject(new Error("offline")),
    };
    expect(await targetOf(leg, failing)).toEqual({ guide: "runs-empty", path: "/executions" });
  });
});
