/**
 * Guide anchors: the attribute a guide step points at.
 *
 * An element that a guide explains carries `data-guide` with one or more space-separated anchor
 * names, written through `guideAnchor("screen.name")` so the name stays a literal a static check can
 * find. Test ids keep their own purpose. A name may be shared by a family of elements — the rows of
 * a list — and the step then points at the first one that is visible.
 */

export function guideAnchor(...names: string[]): { "data-guide": string } {
  return { "data-guide": names.join(" ") };
}

/** The selector for every element that carries an anchor name among its `data-guide` names. */
export function anchorSelector(name: string): string {
  return `[data-guide~="${name}"]`;
}

/** The first visible element carrying the anchor, or null. */
export function findAnchor(name: string, root: ParentNode = document): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(anchorSelector(name))) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return element;
  }
  return null;
}
