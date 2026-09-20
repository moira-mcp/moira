/**
 * How the diagrams and their panels say what can be clicked. Three affordances, used everywhere:
 * `clickable` goes somewhere (a port, a step row, a variable token, an edge); `hoverOnly` has a
 * tooltip and nothing else (a fact chip); `static` is text. The classes carry the cursor, the
 * hover treatment and the focus ring, so a reader learns one rule for the whole interface.
 */

export const INTERACTIVE_CURSOR = {
  clickable: "pointer",
  hoverOnly: "help",
  static: "default",
} as const;

export const INTERACTIVE = {
  /** Something that goes somewhere on click. */
  clickable:
    "cursor-pointer transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
  /** Something that only explains itself on hover. */
  hoverOnly: "cursor-help",
  /** Plain content. */
  static: "cursor-default",
} as const;
