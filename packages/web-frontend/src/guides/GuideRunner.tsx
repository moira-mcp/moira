/**
 * Shows the open guide's current step: brings the page into the state the step needs, finds the
 * step's element once it has come to rest, dims everything else around it, and puts the step card
 * beside it — a popover anchored to the element on a wide screen, a sheet along the bottom on a
 * narrow one.
 *
 * Nothing here writes to the explained element: the spotlight is a separate layer that lets every
 * pointer event through, so a step never gets in the way of the control it is about. A step in the
 * app sidebar opens it first, and the runner closes again what it opened. The keyboard
 * moves through the guide unless the reader is typing, focus goes into the card, and each step is
 * announced once through the provider's live region.
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Popover as PopoverPrimitive } from "radix-ui";
import { LazyMotion, domAnimation, m } from "motion/react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import i18n from "@/i18n";
import { ChevronLeft, ChevronRight, CircleHelp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { useBeginnerPanels } from "@/components/onboarding/beginnerPanels";
import { requestReveal } from "../components/diagram/reveal";
import { findAnchor } from "./anchors";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";
import { GUIDE_PARAM, ONLY_PARAM, STEP_PARAM, useGuides } from "./GuideContext";
import { TOUR_PARAM } from "./fullTour";
import { changeProgress, finishGuide, recordStep, type ProgressChange } from "./progress";
import { anchorIn, fallbackView } from "./types";

/** How long a missing element is waited for before the step is treated as absent. */
const RESOLVE_TICKS = 30;
const TICK_MS = 100;
/** A box that keeps moving is accepted after this many ticks anyway. */
const SETTLE_TICKS = 20;
/**
 * An element taller than this share of the window leaves no room beside it for a card: the card
 * waits in the corner instead, and the spotlight still marks the element.
 */
const TALL_SHARE = 0.5;

type Box = { left: number; top: number; width: number; height: number };

/**
 * Where the card sits: beside its element (a wide screen), in the corner (no element, or one too
 * tall to sit beside), or as a sheet along the bottom or the top of a narrow screen.
 */
export type CardDock = "beside" | "corner" | "bottom" | "top";

/**
 * The edge a narrow screen's sheet docks to: the bottom, unless the element is under it there and a
 * sheet along the top would cover less of it — the page could not scroll the element up far enough.
 */
export function sheetEdge(box: Box, sheetHeight: number, windowHeight: number): "bottom" | "top" {
  const underBottom = Math.max(0, box.top + box.height - (windowHeight - sheetHeight));
  const underTop = Math.max(0, sheetHeight - box.top);
  return underTop < underBottom ? "top" : "bottom";
}

function boxOf(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/** Keys belong to the page while the reader is typing: in the editor above all. */
/**
 * The dialog an element sits in — the phone sidebar's sheet is one. Everything outside an open modal
 * is inert, so the card must be rendered inside it to be reached. A popover is a dialog too, but not
 * a modal, and its positioning wrapper is transformed, which would carry a fixed card with it: an
 * element in a popover keeps the card in the page.
 */
export function modalOf(element: HTMLElement | null): HTMLElement | null {
  const dialog = element?.closest<HTMLElement>('[role="dialog"]');
  if (!dialog || dialog.dataset.testid === "guide-card") return null;
  return dialog.closest("[data-radix-popper-content-wrapper]") ? null : dialog;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/** Why a step was passed without being shown. */
type SkipReason = "hidden" | "narrow";
/** The steps passed since the reader last moved, by reason, for the note on the next card. */
type SkipCounts = Partial<Record<SkipReason, number>>;
/**
 * The note belongs to the card the skips led to: reached any other way — the browser's history, a
 * link — that card has nothing skipped on its way, and the note is not shown.
 */
type SkipNote = { forStep: string; counts: SkipCounts };

/** One more step passed, from `from` towards `to`; skips in a row add up. */
function addSkip(note: SkipNote | null, reason: SkipReason, from: string, to: string): SkipNote {
  const counts = note && note.forStep === from ? note.counts : {};
  return { forStep: to, counts: { ...counts, [reason]: (counts[reason] ?? 0) + 1 } };
}

/** Save a change to the reader's progress; a save that fails is undone by the store and reported. */
function saveProgress(change: ProgressChange): void {
  changeProgress(change).catch(() => toast.error(i18n.t("guides.ui.saveFailed")));
}

export default function GuideRunner(): React.JSX.Element | null {
  const { t } = useTranslation();
  const {
    guide,
    steps,
    stepId,
    partial,
    controller,
    start,
    go,
    close,
    announce,
    tour,
    continueTour,
  } = useGuides();
  const location = useLocation();
  const isMobile = useIsMobile();
  const reduceMotion = usePrefersReducedMotion();

  const index = steps.findIndex((step) => step.id === stepId);
  const step = index >= 0 ? steps[index] : undefined;
  const anchor = step ? anchorIn(step, controller?.view) : null;

  const [note, setNote] = useState<SkipNote | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  /** The step (and anchor) whose element was last found; an optional step waits for it. */
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [missing, setMissing] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(0);

  // The way the reader last moved: a step that cannot be shown is passed in that direction, so Back
  // crosses it instead of being sent forward again.
  const direction = useRef<"forward" | "back">("forward");
  const advance = useCallback(
    (skipped?: SkipReason) => {
      direction.current = "forward";
      const current = steps[index];
      const following = steps[index + 1];
      setNote((previous) =>
        skipped && current && following
          ? addSkip(previous, skipped, current.id, following.id)
          : null,
      );
      // A step passed without being shown leaves no history entry (see `go`).
      if (following) go(following.id, !!skipped);
      else {
        // Walked to the end: the guide is finished, with nothing left to resume. A run of only its
        // changed steps finishes nothing: the rest of the tour was not walked.
        if (guide && !partial) saveProgress(finishGuide(guide, steps));
        // A leg of the full tour hands over to the next screen's tour.
        if (tour && !partial) continueTour();
        else close(!!skipped);
      }
    },
    [steps, index, go, close, guide, partial, tour, continueTour],
  );
  const back = useCallback(() => {
    direction.current = "back";
    setNote(null);
    const previous = steps[index - 1];
    if (previous) go(previous.id);
  }, [steps, index, go]);
  // Pass the current step, with a note on the card that follows. Going back from the first step
  // there is nothing behind, so the guide returns forward. In a run of only the changed steps, a
  // step passed this way counts as offered: it is recorded at its revision, or "What is this?"
  // would keep offering a change the reader's page cannot show.
  const skip = useCallback(
    (reason: SkipReason) => {
      if (partial && guide && step) saveProgress(recordStep(guide.id, step, "", false));
      const previous = steps[index - 1];
      if (direction.current === "back" && previous) {
        setNote((current) => (step ? addSkip(current, reason, step.id, previous.id) : current));
        go(previous.id, true);
      } else advance(reason);
    },
    [steps, index, go, advance, partial, guide, step],
  );

  // A step is skipped at once, with a note, when its element cannot be on the page: one only a wide
  // screen draws, on a narrow one; or one the step declares absent — in a beginner panel the reader
  // hid, or in a view the page opens only from a link. It is never shown or announced on the way: a
  // card flashed for it could take the next click. Until the hidden panels are known, such a step
  // waits for its element like any optional step.
  const panels = useBeginnerPanels();
  const absentWhen = step?.absentWhen;
  const knownAbsent =
    !!absentWhen &&
    ((!!absentWhen.panelHidden && panels.loaded && panels.isHidden(absentWhen.panelHidden)) ||
      (!!absentWhen.queryMissing &&
        !new URLSearchParams(location.search).has(absentWhen.queryMissing)));
  const skipReason: SkipReason | null =
    step?.wide && isMobile ? "narrow" : knownAbsent ? "hidden" : null;
  const skipping = skipReason !== null;
  // An optional step explains something that may be absent (a hidden panel, a view opened only by
  // a link). Until its element is found it is not shown, announced or recorded: a card for it would
  // tell the reader about something that is not there, and it may be skipped a moment later.
  const stepKey = step ? `${step.id}|${anchor ?? ""}` : null;
  // A step whose open view does not draw it waits too, while the page switches to a view that does.
  const switchesView = anchor === null && !!step && !!fallbackView(step) && !!controller?.setView;
  const resolving =
    !!step?.optional && (anchor !== null || switchesView) && resolvedFor !== stepKey;
  // The switch has the same bound as any wait for an element: a page that never draws the step is
  // passed, not waited on for ever.
  useEffect(() => {
    if (!switchesView) return;
    const timer = window.setTimeout(() => skip("hidden"), (RESOLVE_TICKS + 1) * TICK_MS);
    return () => window.clearTimeout(timer);
  }, [switchesView, stepKey, skip]);
  const hidden = skipping || resolving;
  useEffect(() => {
    if (skipReason) skip(skipReason);
  }, [skipReason, skip]);

  // Bring the page into the state the step needs: a view that draws it, the panel, the section.
  useEffect(() => {
    if (!step || !controller) return;
    const fallback = fallbackView(step);
    const needsOtherView =
      !anchor || (step.prepare?.route && !controller.routeRecorded && controller.view !== fallback);
    if (fallback && needsOtherView && controller.view !== fallback) controller.setView?.(fallback);
    if (step.prepare?.currentBlock) controller.selectCurrentBlock?.();
    if (step.prepare?.playbookNode) controller.selectPlaybookNode?.();
    if (step.prepare?.panel) controller.openPanel?.(step.prepare.panel);
    if (step.prepare?.section) controller.openSection?.(step.prepare.section);
  }, [step, anchor, controller]);

  // Open the app sidebar for a step whose element is in it, and close again what the guide opened
  // once a step no longer needs it or the guide closes. A collapsed desktop sidebar is expanded
  // and collapsed back, so the person's own choice, which the sidebar remembers, is left as it was.
  const sidebar = useOptionalSidebar();
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;
  const openedSidebar = useRef<"sheet" | "rail" | null>(null);
  const restoreSidebar = useCallback(() => {
    const current = sidebarRef.current;
    if (openedSidebar.current === "sheet") current?.setOpenMobile(false);
    if (openedSidebar.current === "rail") current?.setOpen(false);
    openedSidebar.current = null;
  }, []);
  const needsSidebar = !!step?.prepare?.sidebar;
  useEffect(() => {
    const current = sidebarRef.current;
    if (!current) return;
    if (!needsSidebar) {
      restoreSidebar();
      return;
    }
    if (current.isMobile && !current.openMobile) {
      current.setOpenMobile(true);
      openedSidebar.current = "sheet";
    } else if (!current.isMobile && !current.open) {
      current.setOpen(true);
      openedSidebar.current = "rail";
    }
  }, [needsSidebar, step, restoreSidebar]);
  useEffect(() => restoreSidebar, [restoreSidebar]);

  // Find the element once the page has drawn it and it has stopped moving: a diagram card exists
  // before its layout and the opening camera have placed it, and revealing it earlier is undone.
  useEffect(() => {
    setTarget(null);
    setBox(null);
    setMissing(false);
    if (!step || !anchor || skipping) return;
    let tries = 0;
    let settling = 0;
    let last: Box | null = null;
    const timer = window.setInterval(() => {
      const found = findAnchor(anchor);
      tries += 1;
      if (!found) {
        if (tries > RESOLVE_TICKS && step.optional) {
          window.clearInterval(timer);
          skip("hidden");
        } else if (tries === RESOLVE_TICKS + 1) {
          // A required step says it cannot find its element, and keeps looking: a page whose code
          // or data arrives late (the next screen of the full tour) still gets its step.
          setMissing(true);
        }
        return;
      }
      setMissing(false);
      const current = boxOf(found);
      settling += 1;
      if (!sameBox(current, last) && settling < SETTLE_TICKS) {
        last = current;
        return;
      }
      window.clearInterval(timer);
      // On a narrow screen the sheet covers the bottom of the window: the element goes to the top.
      found.scrollIntoView({
        block: isMobile ? "start" : "center",
        behavior: reduceMotion ? "auto" : "smooth",
      });
      // A diagram card lives in a transformed viewport that scrolling cannot reach.
      requestReveal(found);
      setTarget(found);
      setResolvedFor(`${step.id}|${anchor}`);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [step, anchor, skipping, isMobile, reduceMotion, skip, t]);

  // Follow the element while it moves: the page scrolls to it and a diagram's camera glides.
  useEffect(() => {
    if (!target) return;
    let frame = 0;
    const follow = () => {
      if (!target.isConnected) {
        setTarget(null);
        return;
      }
      const next = boxOf(target);
      setBox((previous) => (sameBox(previous, next) ? previous : next));
      frame = window.requestAnimationFrame(follow);
    };
    follow();
    return () => window.cancelAnimationFrame(frame);
  }, [target]);

  // A step shown is seen at its revision, and it is where the reader stopped.
  const pagePath = useMemo(() => {
    const query = new URLSearchParams(location.search);
    [GUIDE_PARAM, STEP_PARAM, ONLY_PARAM, TOUR_PARAM].forEach((param) => query.delete(param));
    const rest = query.toString();
    return rest ? `${location.pathname}?${rest}` : location.pathname;
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!guide || !step || hidden) return;
    saveProgress(
      recordStep(guide.id, step, pagePath, !partial, { owner: controller?.owner, tour }),
    );
    // Recorded once per step shown, and again when a run of the changed steps becomes the whole
    // tour on the same step (only then does it become the place to resume); the page's path at that
    // moment is the one to come back to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guide?.id, step?.id, hidden, partial]);

  // Announce each step once.
  const titleKey = guide && step ? `guides.${guide.id}.steps.${step.id}.title` : null;
  useEffect(() => {
    if (!guide || !titleKey || hidden) return;
    announce(
      t("guides.ui.announce", {
        guide: t(`guides.${guide.id}.title`),
        step: t(titleKey),
        index: index + 1,
        total: steps.length,
      }),
    );
  }, [guide, titleKey, hidden, index, steps.length, announce, t]);

  // Arrows and Enter move, Escape closes; never while the reader types. One listener for the life of
  // the guide, reading the current moves: re-attaching it on every step would leave moments with no
  // listener at all, and a key pressed in one would be lost.
  const moves = useRef({ advance, back, close });
  moves.current = { advance, back, close };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        moves.current.close();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moves.current.advance();
      } else if (event.key === "Enter") {
        // Enter on a focused button or link is that control's own click.
        if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
          return;
        event.preventDefault();
        moves.current.advance();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        moves.current.back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const boxRef = useRef<Box | null>(box);
  boxRef.current = box;
  const virtualAnchor = useMemo(
    () => ({
      current: {
        // The card sits beside the part of the element the reader can see.
        getBoundingClientRect: () => {
          const current = boxRef.current ?? { left: 0, top: 0, width: 0, height: 0 };
          const top = Math.max(current.top, 0);
          const bottom = Math.min(current.top + current.height, window.innerHeight);
          return DOMRect.fromRect({
            x: current.left,
            y: top,
            width: current.width,
            height: Math.max(bottom - top, 0),
          });
        },
      },
    }),
    [],
  );

  if (!guide || !step || hidden) return null;

  const tall = !!box && box.height > window.innerHeight * TALL_SHARE;
  const container = modalOf(target) ?? document.body;
  const dock: CardDock = isMobile
    ? box
      ? sheetEdge(box, sheetHeight, window.innerHeight)
      : "bottom"
    : box && !tall
      ? "beside"
      : "corner";

  const card = (
    <GuideCard
      guideId={guide.id}
      stepId={step.id}
      anchor={anchor}
      index={index}
      total={steps.length}
      note={note && note.forStep === step.id ? note.counts : null}
      missing={missing}
      onBack={back}
      onNext={() => advance()}
      onClose={close}
      onWholeTour={partial ? () => start(guide.id) : undefined}
      dock={dock}
      onHeight={setSheetHeight}
    />
  );

  return (
    <LazyMotion features={domAnimation}>
      {box &&
        createPortal(
          <div
            className="pointer-events-none fixed inset-0 z-[60]"
            data-testid="guide-spotlight"
            data-guide-anchor={anchor ?? undefined}
          >
            <m.div
              className="absolute rounded-[10px]"
              style={{
                boxShadow: "0 0 0 3px var(--primary), 0 0 0 9999px var(--guide-dim)",
              }}
              initial={false}
              animate={{
                left: box.left - 6,
                top: box.top - 6,
                width: box.width + 12,
                height: box.height + 12,
              }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: "easeOut" }}
            />
          </div>,
          document.body,
        )}
      {dock === "beside" ? (
        <PopoverPrimitive.Root open modal={false}>
          <PopoverPrimitive.Anchor virtualRef={virtualAnchor} />
          <PopoverPrimitive.Portal container={container}>
            <PopoverPrimitive.Content
              side="bottom"
              align="center"
              sideOffset={14}
              collisionPadding={16}
              updatePositionStrategy="always"
              onOpenAutoFocus={(event) => event.preventDefault()}
              onInteractOutside={(event) => event.preventDefault()}
              onEscapeKeyDown={(event) => event.preventDefault()}
              className="z-[61] outline-none"
            >
              {card}
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      ) : (
        createPortal(card, container)
      )}
    </LazyMotion>
  );
}

function GuideCard({
  guideId,
  stepId,
  anchor,
  index,
  total,
  note,
  missing,
  onBack,
  onNext,
  onClose,
  onWholeTour,
  dock,
  onHeight,
}: {
  guideId: string;
  stepId: string;
  anchor: string | null;
  index: number;
  total: number;
  note: SkipCounts | null;
  missing: boolean;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
  /** Present when the guide runs only its new steps: the last card offers the whole tour. */
  onWholeTour?: () => void;
  dock: CardDock;
  /** Reports the card's height, which decides the edge a narrow screen's sheet docks to. */
  onHeight: (height: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const reduceMotion = usePrefersReducedMotion();

  // The height without the bottom padding, which only the bottom-docked sheet has: the edge is
  // chosen from this height, so it must not change with the edge, or the sheet would flip between
  // edges on every render.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card) onHeight(card.offsetHeight - parseFloat(getComputedStyle(card).paddingBottom || "0"));
  });

  // Focus goes into the card when the guide opens and stays with it from step to step.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [stepId]);

  const last = index === total - 1;
  return (
    <m.div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="guide-card"
      data-guide-id={guideId}
      data-guide-step={stepId}
      data-guide-anchor={anchor ?? undefined}
      data-guide-dock={dock}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
      className={cn(
        "w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl outline-none",
        dock === "corner" && "fixed bottom-4 right-4 z-[61]",
        (dock === "bottom" || dock === "top") &&
          "fixed inset-x-0 z-[61] w-full max-w-none border-x-0",
        dock === "bottom" && "bottom-0 rounded-b-none pb-6",
        dock === "top" && "top-0 rounded-t-none",
      )}
    >
      <div className="flex items-start gap-2">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t(`guides.${guideId}.title`)} · {index + 1}/{total}
          </p>
          <h2 id={titleId} className="mt-0.5 text-base font-semibold leading-6">
            {t(`guides.${guideId}.steps.${stepId}.title`)}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground" data-testid="guide-body">
            {t(`guides.${guideId}.steps.${stepId}.body`)}
          </p>
          {(note || missing) && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="guide-note">
              {missing
                ? t("guides.ui.notFound")
                : [
                    note?.hidden ? t("guides.ui.skippedHidden", { count: note.hidden }) : null,
                    note?.narrow ? t("guides.ui.skippedNarrow", { count: note.narrow }) : null,
                  ]
                    .filter(Boolean)
                    .join(" ")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("guides.ui.close")}
          data-testid="guide-close"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          disabled={index === 0}
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40"
          data-testid="guide-back"
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          {t("guides.ui.back")}
        </button>
        <div className="flex gap-1" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={cn("size-1.5 rounded-full", i === index ? "bg-primary" : "bg-border")}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={onNext}
          // The dark theme's primary is too light for white small text; its background reads.
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 dark:text-background"
          data-testid={last ? "guide-finish" : "guide-next"}
        >
          {last ? t("guides.ui.finish") : t("guides.ui.next")}
          {!last && <ChevronRight className="size-3.5" aria-hidden="true" />}
        </button>
      </div>
      {last && onWholeTour && (
        <button
          type="button"
          onClick={onWholeTour}
          className="mt-2 text-xs font-medium text-primary underline-offset-4 hover:underline"
          data-testid="guide-whole-tour"
        >
          {t("guides.ui.wholeTour")}
        </button>
      )}
    </m.div>
  );
}
