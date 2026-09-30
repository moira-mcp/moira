/**
 * The full tour: the screen tours of the main app, one after another, in the order a reader meets
 * the screens. It is carried in the URL (`tour=full` beside `guide` and `step`), so it survives a
 * reload and pauses as soon as the reader navigates anywhere the tour did not take them.
 *
 * Most screens have a fixed address. Two are resolved when the tour gets there: the flow page shows
 * the example flow in the reader's language, and the run page shows the reader's latest run — or,
 * for a reader with no run yet, a step on the runs list that hands over the prompt to try.
 */

/** The URL parameter that marks a guide as a leg of the full tour. */
export const TOUR_PARAM = "tour";
export const FULL_TOUR = "full";

/** Where a leg of the tour opens. */
export type TourStop =
  | { kind: "fixed"; path: string }
  /** The example flow of the reader's language. */
  | { kind: "example-flow" }
  /** The reader's latest run; `fallback` runs on the runs list when there is none. */
  | { kind: "latest-run"; fallback: string };

export interface TourLeg {
  /** The screen tour this leg runs. */
  guide: string;
  stop: TourStop;
}

/** The screen tours of the full tour, in order. Paths are written without the app's base path. */
export const FULL_TOUR_LEGS: readonly TourLeg[] = [
  { guide: "home", stop: { kind: "fixed", path: "/" } },
  { guide: "overview", stop: { kind: "fixed", path: "/overview" } },
  { guide: "flows", stop: { kind: "fixed", path: "/workflows" } },
  { guide: "flow", stop: { kind: "example-flow" } },
  { guide: "runs", stop: { kind: "fixed", path: "/executions" } },
  { guide: "run", stop: { kind: "latest-run", fallback: "runs-empty" } },
  { guide: "notes", stop: { kind: "fixed", path: "/notes" } },
  { guide: "playbooks", stop: { kind: "fixed", path: "/playbooks" } },
  { guide: "artifacts", stop: { kind: "fixed", path: "/artifacts" } },
  { guide: "settings", stop: { kind: "fixed", path: "/settings" } },
];

/** Every guide the full tour may run: each leg's, and a leg's fallback. */
export function tourGuideIds(legs: readonly TourLeg[] = FULL_TOUR_LEGS): string[] {
  return legs.flatMap((leg) =>
    leg.stop.kind === "latest-run" ? [leg.guide, leg.stop.fallback] : [leg.guide],
  );
}

/** The index of the leg a guide belongs to — a leg's fallback guide included — or -1. */
export function legOf(guideId: string, legs: readonly TourLeg[] = FULL_TOUR_LEGS): number {
  return legs.findIndex(
    (leg) =>
      leg.guide === guideId || (leg.stop.kind === "latest-run" && leg.stop.fallback === guideId),
  );
}

/** Where a leg opens, found for this reader: the guide to run and the path to open it on. */
export interface LegTarget {
  guide: string;
  path: string;
}

export interface TourContext {
  /** The slug of the example flow in the reader's language (addressed as `moira/<slug>`). */
  exampleFlowSlug: () => string;
  /** The id of the reader's latest run, or null when they have none. */
  latestRunId: () => Promise<string | null>;
}

/** The guide and path a leg opens on for this reader. */
export async function targetOf(leg: TourLeg, context: TourContext): Promise<LegTarget> {
  switch (leg.stop.kind) {
    case "fixed":
      return { guide: leg.guide, path: leg.stop.path };
    case "example-flow":
      return { guide: leg.guide, path: `/workflows/moira/${context.exampleFlowSlug()}` };
    case "latest-run": {
      const id = await context.latestRunId().catch(() => null);
      return id
        ? { guide: leg.guide, path: `/executions/${encodeURIComponent(id)}` }
        : { guide: leg.stop.fallback, path: "/executions" };
    }
  }
}
