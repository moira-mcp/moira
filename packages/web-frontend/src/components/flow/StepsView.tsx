/**
 * Steps — the simplest picture of a workflow: what the agent is told, top to bottom.
 *
 * Every instruction is a numbered card with the text the agent receives; arrows join them in the
 * order they come; where the agent's answer (or a check Moira makes on its own) chooses the way on,
 * the arrows fork and carry the choice's label; returns are dashed arrows on the side; each end is
 * a finish marker. No node types, ids, schemas or ports. With "variables as words" on, every
 * `{{name}}` in a card reads as the variable's name in plain words, so the whole flow reads as a
 * sequence of sentences. The model comes from `stepsModel`; ELK — the layout engine the technical
 * graph uses — places the cards; the shared diagram substrate supplies pan, zoom, fit and the
 * settled signal.
 *
 * That picture is for small flows. A flow beyond `stepsPresentation`'s size rule reads as a list
 * instead (`StepsList`): the same cards top to bottom at full width, each ending with its way on.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { CircleCheck, Cog, Loader2, Play, Split, WholeWord } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { DiagramViewport } from "../diagram/DiagramViewport";
import { DiagramToolbar, ToolbarButton } from "../diagram/DiagramToolbar";
import { useOpeningPlacement } from "../diagram/placement";
import { Hint } from "../diagram/Hint";
import { TemplateText, VariableProvider, type VariableDefinition } from "../diagram/VariableText";
import type { WorkflowGraph } from "../../types/workflow-types";
import { stepsModel, stepsPresentation, type StepCard, type StepsModel } from "./stepsModel";
import { StepsList } from "./StepsList";

const CARD_WIDTH = 360;
const PILL_WIDTH = 150;
const PILL_HEIGHT = 40;
const SYSTEM_WIDTH = 260;
/** A card shows at most this many lines of its text; the whole text is on hover. */
const MAX_LINES = 7;
/** A system card shows at most this many lines of its message. */
const SYSTEM_MAX_LINES = 3;
const LINE_HEIGHT = 20;
const SYSTEM_LINE_HEIGHT = 16;
const CARD_CHROME = 52;
/** The text box inside a card: its width less the padding (px-4) and the border. */
const CARD_TEXT_WIDTH = CARD_WIDTH - 34;
const SYSTEM_TEXT_WIDTH = SYSTEM_WIDTH - 26;

type StepNodeData = {
  card: StepCard;
  inline: boolean;
  /** The text is longer than the card shows: the whole of it is offered on hover. */
  clamped: boolean;
};
type StepNode = Node<StepNodeData, "step">;

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Width of a run of text in a font, from a canvas; null where the browser offers none. */
function textWidth(text: string, font: string): number | null {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return null;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * How many lines the text takes in a box of this width, wrapped word by word the way the card
 * wraps it — ELK needs every card's height before anything is drawn. Without a canvas it falls
 * back to a conservative count of characters per line.
 */
function lineCount(text: string, width: number, fontSize: number, max: number): number {
  if (!text) return 0;
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  const font = `${fontSize}px ${family}`;
  // A little room for the difference between canvas and layout metrics.
  const room = width * 0.96;
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    let count = 1;
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      const measured = textWidth(candidate, font);
      // An average glyph is taken as two thirds of the font size: wide enough to overestimate.
      if (measured === null)
        return Math.min(max, Math.ceil(text.length / (width / (fontSize * 0.66))));
      if (measured <= room) {
        current = candidate;
        continue;
      }
      if (current) count += 1;
      // A word wider than the box (a path, a URL) breaks across lines of its own.
      const alone = textWidth(word, font) ?? 0;
      count += Math.max(0, Math.ceil(alone / room) - 1);
      current = word;
    }
    lines += count;
    if (lines >= max) return max;
  }
  return Math.min(max, lines);
}

function sizeOf(card: StepCard): { width: number; height: number } {
  if (card.kind === "start" || card.kind === "finish")
    return { width: PILL_WIDTH, height: PILL_HEIGHT };
  if (card.kind === "system" || card.kind === "check") {
    const lines = lineCount(card.text, SYSTEM_TEXT_WIDTH, 12, SYSTEM_MAX_LINES);
    return { width: SYSTEM_WIDTH, height: 44 + (lines ? lines * SYSTEM_LINE_HEIGHT + 4 : 0) };
  }
  return {
    width: CARD_WIDTH,
    height: CARD_CHROME + lineCount(card.text, CARD_TEXT_WIDTH, 14, MAX_LINES) * LINE_HEIGHT,
  };
}

interface StepsLayout {
  positions: Map<string, { x: number; y: number; width: number; height: number }>;
  key: string;
}

async function layoutSteps(model: StepsModel): Promise<StepsLayout> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const laid = await elk.layout({
    id: "steps",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.randomSeed": "1",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
    },
    children: model.cards.map((card) => ({ id: card.id, ...sizeOf(card) })),
    // Returns stay out of the layering: they are drawn on the side and must not pull the step
    // they return to below the step they return from.
    edges: model.edges
      .filter((edge) => !edge.back)
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  const positions = new Map(
    (laid.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 },
    ]),
  );
  const extent = [...positions.values()].reduce(
    (size, at) => ({
      width: Math.max(size.width, at.x + at.width),
      height: Math.max(size.height, at.y + at.height),
    }),
    { width: 0, height: 0 },
  );
  return {
    positions,
    key: `${Math.round(extent.width)}x${Math.round(extent.height)}|${model.cards.length}`,
  };
}

const HANDLE = "!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent";

function StepNodeView({ data }: NodeProps<StepNode>): React.JSX.Element {
  const { t } = useTranslation();
  const { card, inline } = data;
  const handles = (
    <>
      <Handle type="target" position={Position.Top} className={HANDLE} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className={HANDLE} isConnectable={false} />
      <Handle
        id="back-out"
        type="source"
        position={Position.Right}
        className={HANDLE}
        isConnectable={false}
      />
      <Handle
        id="back-in"
        type="target"
        position={Position.Right}
        className={HANDLE}
        isConnectable={false}
      />
    </>
  );
  const common = {
    "data-testid": "steps-card",
    "data-step-kind": card.kind,
    "data-node-id": card.id,
  };
  if (card.kind === "start" || card.kind === "finish") {
    const Icon = card.kind === "start" ? Play : CircleCheck;
    return (
      <div
        {...common}
        className={cn(
          "flex h-full w-full items-center justify-center gap-1.5 rounded-full border text-sm font-medium",
          card.kind === "start"
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-success/50 bg-success/10 text-success dark:border-success-foreground/50 dark:bg-success/25 dark:text-success-foreground",
        )}
      >
        {handles}
        <Icon className="size-4" aria-hidden="true" />
        {t(card.kind === "start" ? "pages.flowPage.steps.start" : "pages.flowPage.steps.finish")}
      </div>
    );
  }
  if (card.kind === "check" || card.kind === "system") {
    const Icon = card.kind === "check" ? Split : Cog;
    const label =
      card.kind === "check"
        ? t("pages.flowPage.steps.check")
        : t(`pages.flowPage.steps.system.${card.nodeType}`, {
            defaultValue: t("pages.flowPage.steps.system.other"),
          });
    return (
      <div
        {...common}
        className="flex h-full w-full flex-col justify-center gap-1 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      >
        {handles}
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </span>
        {card.text && (
          <span className="line-clamp-3 whitespace-pre-line [overflow-wrap:anywhere]">
            <TemplateText text={card.text} inline={inline} />
          </span>
        )}
      </div>
    );
  }
  const text = (
    <p
      className="whitespace-pre-line text-sm leading-5 text-foreground [overflow-wrap:anywhere]"
      style={{
        display: "-webkit-box",
        WebkitLineClamp: MAX_LINES,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
    >
      <TemplateText text={card.text} inline={inline} />
    </p>
  );
  return (
    <div
      {...common}
      className="flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-xl border bg-card px-4 py-3 shadow-sm"
    >
      {handles}
      <span className="inline-flex items-center gap-2 text-xs font-semibold text-primary">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
          {card.number}
        </span>
        {t("pages.flowPage.steps.step", { number: card.number })}
      </span>
      {data.clamped ? (
        <Hint
          content={
            <span className="whitespace-pre-line">
              <TemplateText text={card.text} inline={inline} />
            </span>
          }
          width="lg"
          delay={400}
        >
          {text}
        </Hint>
      ) : (
        text
      )}
    </div>
  );
}

const nodeTypes = { step: StepNodeView };

export function StepsView({
  workflow,
  inline,
  onToggleInline,
  toolbarModes,
  toolbarTrailing,
}: {
  workflow: Pick<WorkflowGraph, "nodes" | "variableRegistry">;
  /** Variables read as plain words. */
  inline: boolean;
  onToggleInline: () => void;
  /** The page's view-mode switch, first in the toolbar. */
  toolbarModes?: React.ReactNode;
  /** The page's trailing controls (guide, pending indicator). */
  toolbarTrailing?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { actualTheme } = useTheme();
  const model = useMemo(() => stepsModel(workflow), [workflow]);
  const presentation = stepsPresentation(model);
  const [layout, setLayout] = useState<StepsLayout | null>(null);
  const [layoutFailed, setLayoutFailed] = useState(false);
  useEffect(() => {
    // A reading list needs no layout
    if (presentation === "list") return;
    let live = true;
    setLayoutFailed(false);
    layoutSteps(model).then(
      (laid) => {
        if (live) setLayout(laid);
      },
      () => {
        // The layout engine could not be loaded or refused the graph: say so instead of spinning.
        if (live) setLayoutFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [model, presentation]);

  const numberOf = useMemo(
    () => new Map(model.cards.map((card) => [card.id, card.number])),
    [model],
  );
  const nodes = useMemo<StepNode[]>(() => {
    if (!layout) return [];
    return model.cards.map((card) => {
      const at = layout.positions.get(card.id) ?? { x: 0, y: 0, ...sizeOf(card) };
      return {
        id: card.id,
        type: "step",
        position: { x: at.x, y: at.y },
        width: at.width,
        height: at.height,
        draggable: false,
        selectable: false,
        data: {
          card,
          inline,
          clamped:
            card.kind === "instruction" &&
            lineCount(card.text, CARD_TEXT_WIDTH, 14, MAX_LINES + 1) > MAX_LINES,
        },
      };
    });
  }, [layout, model, inline]);
  const edges = useMemo<Edge[]>(
    () =>
      model.edges.map((edge) => {
        const number = numberOf.get(edge.target);
        const label =
          edge.label ??
          (edge.back
            ? number
              ? t("pages.flowPage.steps.backTo", { number })
              : t("pages.flowPage.steps.back")
            : undefined);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.back ? "back-out" : undefined,
          targetHandle: edge.back ? "back-in" : undefined,
          type: edge.back ? "default" : "smoothstep",
          label,
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 6,
          labelStyle: { fontSize: 12, fill: "var(--foreground)" },
          labelBgStyle: { fill: "var(--card)", stroke: "var(--border)" },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: edge.back
            ? { strokeDasharray: "6 4", stroke: "var(--muted-foreground)" }
            : { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
          selectable: false,
          focusable: false,
          data: { back: edge.back },
        };
      }),
    [model, numberOf, t],
  );

  const rfRef = useRef<ReactFlowInstance<StepNode, Edge> | null>(null);
  // Open at the first step: fitted when the flow is short, the top of it at a readable zoom when
  // it is long.
  const place = useCallback(async (instance: ReactFlowInstance<StepNode, Edge>) => {
    await instance.fitView({ padding: 0.12, minZoom: 0.6, maxZoom: 1, duration: 0 });
    const viewport = instance.getViewport();
    const first = instance.getNodes()[0];
    if (first && viewport.zoom <= 0.6) {
      await instance.setViewport({
        x: viewport.x,
        y: 24 - first.position.y * viewport.zoom,
        zoom: viewport.zoom,
      });
    }
  }, []);
  const { onInit, onReady, onMoveStart, onMoveEnd, placed } = useOpeningPlacement(
    place,
    layout?.key ?? null,
  );
  const handleInit = useCallback(
    (instance: ReactFlowInstance<StepNode, Edge>) => {
      rfRef.current = instance;
      onInit(instance);
    },
    [onInit],
  );

  const inlineLabel = t("pages.flowPage.steps.inline");
  const registry = (workflow.variableRegistry ?? {}) as Record<string, VariableDefinition>;
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid="steps-view"
      data-presentation={presentation}
    >
      <DiagramToolbar
        modes={toolbarModes}
        leading={
          <ToolbarButton
            onClick={onToggleInline}
            title={t("pages.flowPage.steps.inlineHint")}
            label={inlineLabel}
            active={inline}
            className="w-auto gap-1.5 px-2 text-xs"
            dataAttributes={{
              "data-testid": "steps-inline-toggle",
              "data-inline": inline ? "on" : "off",
            }}
          >
            <WholeWord className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{inlineLabel}</span>
          </ToolbarButton>
        }
        presets={false}
        {...(presentation === "diagram" && {
          onZoomIn: () => void rfRef.current?.zoomIn({ duration: 200 }),
          onZoomOut: () => void rfRef.current?.zoomOut({ duration: 200 }),
          onFit: () => void rfRef.current?.fitView({ padding: 0.12, duration: 200 }),
        })}
        trailing={toolbarTrailing}
        testId="steps-toolbar"
      />
      <div className="min-h-0 flex-1 overflow-hidden bg-muted/20" data-testid="steps-canvas">
        {model.cards.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t("pages.flowPage.steps.empty")}</p>
        ) : presentation === "list" ? (
          <VariableProvider value={{ registry }}>
            <StepsList model={model} inline={inline} />
          </VariableProvider>
        ) : layoutFailed ? (
          <p
            className="p-6 text-sm text-destructive"
            role="alert"
            data-testid="steps-layout-failed"
          >
            {t("pages.flowPage.steps.layoutFailed")}
          </p>
        ) : !layout ? (
          <div
            className="flex h-full items-center justify-center text-sm text-muted-foreground"
            role="status"
            data-testid="steps-loading"
          >
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
            {t("pages.flowPage.steps.loading")}
          </div>
        ) : (
          <VariableProvider value={{ registry }}>
            <DiagramViewport<StepNode, Edge>
              kind="canvas"
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode={actualTheme}
              onInit={handleInit}
              onReady={onReady}
              onMoveStart={onMoveStart}
              onMoveEnd={onMoveEnd}
              settled={placed}
              showControls={false}
            >
              <Background gap={24} size={1} />
            </DiagramViewport>
          </VariableProvider>
        )}
      </div>
    </div>
  );
}
