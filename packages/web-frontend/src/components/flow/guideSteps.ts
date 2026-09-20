/**
 * The flow page's walkthrough: the anchored steps "Explain this page" runs through on a
 * definition — block, step, evidence, loop, editing, explore. It lives beside the page rather
 * than inside it so the anchors can be read (and asserted) without mounting the page.
 *
 * The steps that point inside the block panel also name the panel section they need unfolded: the
 * panel remembers folds per reader and the Steps section starts folded.
 *
 * Every anchor names an element both views draw, because the reader may open the walkthrough on
 * the map or on the graph: the contents sidebar, the block panel and the return ports exist on
 * both, so a step never has to move the reader to a view they did not ask for.
 */

import type { GuideStep } from "../run/Walkthrough";
import type { FlowViewMode } from "./modes";

export type FlowPanelTab = "block" | "variables";

const EVERY_MODE = (selector: string): Partial<Record<FlowViewMode, string>> => ({
  map: selector,
  graph: selector,
});

export function flowGuideSteps(isOwner: boolean): GuideStep<FlowViewMode, FlowPanelTab>[] {
  return [
    {
      id: "process",
      targets: EVERY_MODE('[data-testid="map-contents-list"] [data-block-id]'),
      fallbackView: "map",
    },
    {
      id: "agent",
      targets: EVERY_MODE('[data-testid="block-detail"] [data-node-id]'),
      fallbackView: "map",
      panel: "block",
      section: "steps",
    },
    {
      id: "evidence",
      targets: EVERY_MODE('[data-testid="block-detail"] [data-node-inputs]'),
      fallbackView: "map",
      panel: "block",
      section: "steps",
    },
    {
      id: "loop",
      targets: EVERY_MODE('[data-port-kind="return"]'),
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
      targets: { map: '[data-testid="map-toolbar"]', graph: '[data-testid="graph-toolbar"]' },
      fallbackView: "map",
    },
  ];
}
