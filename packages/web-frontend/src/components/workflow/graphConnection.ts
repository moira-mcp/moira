/** Completion of a connection drag belongs to its actual release in the owning graph. */
export interface GraphConnectionState {
  fromNode: { id: string } | null;
  fromHandle: { id?: string | null; type?: string } | null;
  toNode: { id: string } | null;
  isValid: boolean | null;
}

type Gesture = { source: string; sourceHandle: string | null };
export type GraphConnectionCompletion =
  | { kind: "connect"; gesture: Gesture & { target: string } }
  | { kind: "canvas"; gesture: Gesture; blockId: string | null };

function owns(pane: HTMLElement, element: Element): boolean {
  return element.closest(".react-flow") === pane;
}

/** Groups do not receive pointer events, so their owned boxes determine canvas block assignment. */
export function blockAtPoint(pane: HTMLElement | null, x: number, y: number): string | null {
  if (!pane) return null;
  for (const group of pane.querySelectorAll<HTMLElement>("[data-graph-group]")) {
    const box = group.getBoundingClientRect();
    if (owns(pane, group) && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
      return group.getAttribute("data-block-id");
    }
  }
  return null;
}

/** Card bodies accept drops too, but only when the actual reachable point belongs to this pane. */
function releaseAt(
  pane: HTMLElement,
  x: number,
  y: number,
): { node: string } | "canvas" | "outside" {
  const frame = pane.getBoundingClientRect();
  const top = pane.ownerDocument.elementFromPoint(x, y);
  if (
    x < frame.left ||
    x > frame.right ||
    y < frame.top ||
    y > frame.bottom ||
    !top ||
    !owns(pane, top) ||
    // Native MiniMap/Controls panels belong to the wrapper, but are not graph drop surfaces.
    !!top.closest(".react-flow__panel")
  )
    return "outside";
  for (const element of pane.ownerDocument.elementsFromPoint(x, y)) {
    const card = element.closest("[data-graph-node]");
    if (card && owns(pane, card)) return { node: card.getAttribute("data-graph-node")! };
  }
  return "canvas";
}

/**
 * XYFlow retains a geometric handle before mouse-up. Its target assists an inside-pane release;
 * it cannot admit a release over a panel, another graph, or a source card. No effect is emitted
 * before this final mouse/touch event, and no parallel gesture history is required.
 */
export function completeGraphConnection(
  pane: HTMLElement | null,
  event: MouseEvent | TouchEvent,
  state: GraphConnectionState,
): GraphConnectionCompletion | null {
  if (
    !pane?.isConnected ||
    event.type === "touchcancel" ||
    !state.fromNode ||
    state.fromHandle?.type !== "source"
  )
    return null;
  const point = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return null;
  const source = state.fromNode.id;
  const cards = [...pane.querySelectorAll<HTMLElement>("[data-graph-node]")].filter((card) =>
    owns(pane, card),
  );
  const hasNode = (id: string) => cards.some((card) => card.getAttribute("data-graph-node") === id);
  if (!hasNode(source)) return null;
  const at = releaseAt(pane, point.clientX, point.clientY);
  if (at === "outside" || (at !== "canvas" && at.node === source)) return null;
  const gesture = { source, sourceHandle: state.fromHandle.id ?? null };
  // Keep valid near-handle assistance inside the pane, even when the pointer is beside the card.
  const target = state.isValid && state.toNode ? state.toNode.id : at === "canvas" ? null : at.node;
  if (target !== null) {
    if (target === source || !hasNode(target)) return null;
    return { kind: "connect", gesture: { ...gesture, target } };
  }
  return { kind: "canvas", gesture, blockId: blockAtPoint(pane, point.clientX, point.clientY) };
}
