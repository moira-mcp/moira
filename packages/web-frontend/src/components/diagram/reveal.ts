/**
 * "Bring this into view" for an element that may live inside a diagram. The page scrolls to an
 * element with `scrollIntoView`, but a card inside a React Flow canvas sits under a transform
 * that scrolling cannot reach; the mounted diagram listens for this event and moves its camera
 * to the node that contains the element. Anything that points a reader at an element — the
 * walkthrough today — calls `requestReveal`; it is harmless for elements outside a diagram.
 */

export const REVEAL_EVENT = "moira:reveal";

export function requestReveal(element: Element): void {
  element.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
}
