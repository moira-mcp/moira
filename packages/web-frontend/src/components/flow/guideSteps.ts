/**
 * The flow page's walkthrough: the anchored steps "Explain this page" runs through on a
 * definition — who builds flows (the agent, not the reader), the plain steps, block, step,
 * evidence, loop, editing, explore. It lives beside the page rather
 * than inside it so the anchors can be read (and asserted) without mounting the page.
 *
 * The steps that point inside the block panel also name the panel section they need unfolded: the
 * panel remembers folds per reader and the Steps section starts folded.
 *
 * An anchor names an element every view that can show it draws, because the reader may open the
 * walkthrough on any view: the header is above all three; the contents sidebar, the block panel
 * and the return ports belong to the two diagrams of the process (the steps view keeps the page to
 * its one picture); the numbered instruction cards exist only on the steps view. A step whose element the open view lacks moves the reader to
 * its fallback view.
 */

import type { GuideStep } from "../run/Walkthrough";
import type { FlowViewMode } from "./modes";

export type FlowPanelTab = "block" | "variables";

const EVERY_MODE = (selector: string): Partial<Record<FlowViewMode, string>> => ({
  steps: selector,
  map: selector,
  graph: selector,
});

/** The two diagrams of the process: the map and the graph. */
const PROCESS_VIEWS = (selector: string): Partial<Record<FlowViewMode, string>> => ({
  map: selector,
  graph: selector,
});

export function flowGuideSteps(isOwner: boolean): GuideStep<FlowViewMode, FlowPanelTab>[] {
  return [
    {
      // Moira is agent-first: the reader describes the task and the agent picks or builds a flow.
      id: "intro",
      targets: EVERY_MODE('[data-testid="flow-header"]'),
      fallbackView: "steps",
    },
    {
      // The numbered instruction cards: the flow read as what the agent is told. On the map and
      // the graph the step points at the switch that opens them, so it keeps the reader's view.
      id: "steps",
      targets: {
        steps: '[data-testid="steps-card"][data-step-kind="instruction"]',
        map: '[data-testid="flow-modes"] [data-mode="steps"]',
        graph: '[data-testid="flow-modes"] [data-mode="steps"]',
      },
      fallbackView: "steps",
    },
    {
      id: "process",
      targets: PROCESS_VIEWS('[data-testid="map-contents-list"] [data-block-id]'),
      fallbackView: "map",
    },
    {
      id: "agent",
      targets: PROCESS_VIEWS('[data-testid="block-detail"] [data-node-id]'),
      fallbackView: "map",
      panel: "block",
      section: "steps",
    },
    {
      id: "evidence",
      targets: PROCESS_VIEWS('[data-testid="block-detail"] [data-node-inputs]'),
      fallbackView: "map",
      panel: "block",
      section: "steps",
    },
    {
      id: "loop",
      targets: PROCESS_VIEWS('[data-port-kind="return"]'),
      fallbackView: "map",
    },
    {
      id: "edit",
      targets: EVERY_MODE(
        isOwner ? '[data-testid="flow-edit-toggle"]' : '[data-testid="flow-header"]',
      ),
      fallbackView: "map",
    },
    {
      // The toolbar itself: it carries both facts the step names — the view switch and the
      // layout presets — and one ring around the row reads better than two. Each diagram mounts
      // its own, so the two views name different elements here.
      id: "explore",
      targets: {
        steps: '[data-testid="steps-toolbar"]',
        map: '[data-testid="map-toolbar"]',
        graph: '[data-testid="graph-toolbar"]',
      },
      fallbackView: "map",
    },
  ];
}
