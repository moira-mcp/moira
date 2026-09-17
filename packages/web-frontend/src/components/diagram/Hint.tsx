/**
 * The one tooltip of the application. Every hint — a plain sentence over a toolbar button, a
 * rich card over a port (heading, body, a monospace block), the list of steps over a fact chip —
 * is drawn on the same theme-aware surface (the popover colours, a hairline border, a soft
 * shadow), from the same side and with the same delay, so the reader meets one tooltip
 * everywhere instead of a browser title here and an inverted bubble there.
 *
 * `Hint` wraps a trigger explicitly. `HintLayer`, mounted once at the root, gives the same
 * surface to every element carrying `data-hint="text"`: the drop-in replacement for a native
 * `title`, which the browser draws in its own style and which ignores the theme.
 */

import React, { useEffect, useRef, useState } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export type HintSide = "top" | "right" | "bottom" | "left";

/** The surface every hint shares. */
export const HINT_SURFACE =
  "z-50 rounded-md border border-border bg-popover text-popover-foreground shadow-lg shadow-black/10 dark:shadow-black/40";

export const HINT_ARROW = "fill-popover stroke-border";

const HINT_MAX_WIDTH: Record<NonNullable<HintProps["width"]>, string> = {
  sm: "max-w-[240px]",
  md: "max-w-[360px]",
  lg: "max-w-[480px]",
};

export interface HintProps {
  /** Plain text or the rich body. */
  content: React.ReactNode;
  /** A heading above the body (rich hints). */
  title?: React.ReactNode;
  /** Monospace body that keeps line breaks: authored text, conditions, ids. */
  mono?: boolean;
  side?: HintSide;
  align?: "start" | "center" | "end";
  width?: "sm" | "md" | "lg";
  /** Ms before the hint opens; 0 for controls, longer for text the reader passes over. */
  delay?: number;
  /** No padding: the content brings its own (a list of rows). */
  flush?: boolean;
  children: React.ReactElement;
  className?: string;
  /** Controlled open state (the delegated layer uses it). */
  open?: boolean;
}

export function HintBody({
  title,
  content,
  mono = false,
  flush = false,
  width = "md",
  className,
}: Pick<
  HintProps,
  "title" | "content" | "mono" | "flush" | "width" | "className"
>): React.JSX.Element {
  return (
    <div
      className={cn(
        HINT_MAX_WIDTH[width],
        !flush && "px-3 py-2",
        "text-left text-xs leading-[1.5] [text-wrap:initial]",
        className,
      )}
      data-hint-body=""
    >
      {title && (
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </div>
      )}
      <div className={cn(mono && "whitespace-pre-wrap font-mono text-[11px]")}>{content}</div>
    </div>
  );
}

export function Hint({
  content,
  title,
  mono,
  side = "top",
  align = "center",
  width = "md",
  delay = 150,
  flush,
  children,
  className,
  open,
}: HintProps): React.JSX.Element {
  if (content === null || content === undefined || content === "") return children;
  return (
    <TooltipPrimitive.Provider delayDuration={delay}>
      <TooltipPrimitive.Root open={open}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              HINT_SURFACE,
              "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            )}
            data-slot="hint"
          >
            <HintBody
              title={title}
              content={content}
              mono={mono}
              flush={flush}
              width={width}
              className={className}
            />
            <TooltipPrimitive.Arrow className={HINT_ARROW} width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/**
 * The delegated layer: one listener on the document shows a `Hint` for whatever element under
 * the pointer (or focus) carries `data-hint`, anchored to that element. Mount once at the root.
 */
export function HintLayer(): React.JSX.Element | null {
  const [target, setTarget] = useState<{
    element: Element;
    text: string;
    /** Where the hint is anchored when the element asked for the pointer (`data-hint-at`). */
    point: { x: number; y: number } | null;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const show = (element: Element, point: { x: number; y: number } | null) => {
      const text = element.getAttribute("data-hint");
      if (!text) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setTarget({ element, text, point }), 250);
    };
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setTarget(null);
    };
    const onOver = (event: Event) => {
      const element = (event.target as Element | null)?.closest("[data-hint]");
      if (!element) return hide();
      // A long line's box is not where the pointer is: an element that says
      // `data-hint-at="pointer"` anchors the hint at the pointer when there is one (focus has none).
      const atPointer =
        element.getAttribute("data-hint-at") === "pointer" && event instanceof MouseEvent;
      show(element, atPointer ? { x: event.clientX, y: event.clientY } : null);
    };
    const onOut = (event: MouseEvent) => {
      const from = (event.target as Element | null)?.closest("[data-hint]");
      const to = (event.relatedTarget as Element | null)?.closest?.("[data-hint]");
      if (from && from !== to) hide();
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onOver);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onOver);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("scroll", hide, true);
    };
  }, []);
  if (!target) return null;
  const rect = target.point
    ? { left: target.point.x, top: target.point.y - 4, width: 1, height: 8 }
    : target.element.getBoundingClientRect();
  const side: HintSide =
    (target.element.getAttribute("data-hint-side") as HintSide | null) ?? "top";
  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <TooltipPrimitive.Root open>
        <TooltipPrimitive.Trigger asChild>
          <span
            aria-hidden="true"
            style={{
              position: "fixed",
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              pointerEvents: "none",
            }}
          />
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className={cn(HINT_SURFACE, "animate-in fade-in-0 zoom-in-95")}
            // The delegated hint is text, never a target: a surface that could come under the
            // pointer (it is anchored at the pointer for a line) would steal the hover and hide
            // itself, over and over.
            style={{ pointerEvents: "none" }}
            data-slot="hint"
            data-hint-layer=""
          >
            <HintBody content={target.text} width="sm" />
            <TooltipPrimitive.Arrow className={HINT_ARROW} width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
