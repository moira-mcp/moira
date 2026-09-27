/**
 * The progress picture a notification carries: the run as a list of its blocks, the way a phone
 * shows a flow — one row per block in process order with its number, title, status and, for a
 * block that binds a list, `done/total: current item`. It is drawn at a phone width at the phone
 * type scale and grows downwards; nothing is ever scaled, so every text reads at its own size.
 * The map (`execution-progress-visual.ts`) does not read at a phone width: its cards and return
 * lanes are several times wider than a phone, so a notification never sends it.
 */

import sharp from "sharp";
import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { WorkflowExecution } from "../types/base-types.js";
import type { ExecutionProgress } from "./execution-progress-contract.js";
import {
  PROGRESS_IMAGE_MAX_BYTES,
  escapeXml,
  progressPalette,
} from "./execution-progress-renderer.js";
import {
  ellipsizeProgressText,
  progressTextWidth,
  wrapProgressTextToWidth,
  type ProgressFontWeight,
} from "./execution-progress-text.js";
import {
  progressCardTone,
  progressStatusText,
  progressTypeScale,
  type ProgressCardTone,
  type ProgressTheme,
} from "./execution-progress-visual.js";
import type { RenderedExecutionProgressImage } from "./execution-progress-image.js";
import { projectExecutionRun } from "./execution-run-projection.js";
import { listProgressLabel } from "./progress-facts.js";

/** The width a phone shows a picture at, in CSS pixels; the picture is drawn at exactly this. */
export const PROGRESS_STEPS_WIDTH = 390;
/** The picture is rasterised at this density, so it stays sharp on a phone's screen. */
export const PROGRESS_STEPS_DENSITY = 3;

const PADDING = 16;
const ROW_PADDING = 12;
const ROW_GAP = 8;
const INDEX_GAP = 10;
const HEADER_MAX_LINES = 3;

/** One piece of text in the picture: its lines, face, and the box they must stay inside. */
export interface ProgressStepsText {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  weight: ProgressFontWeight;
  x: number;
  /** Top of the first line's box. */
  y: number;
  /** The width no line may exceed. */
  maxWidth: number;
}

export interface ProgressStepsRow {
  id: string;
  tone: ProgressCardTone;
  x: number;
  y: number;
  width: number;
  height: number;
  index: { text: string; x: number; y: number; width: number; height: number };
  title: ProgressStepsText;
  chip: { text: string; x: number; y: number; width: number; height: number; fontSize: number };
  list: ProgressStepsText | null;
}

export interface ProgressStepsModel {
  theme: ProgressTheme;
  width: number;
  height: number;
  header: ProgressStepsText;
  rows: ProgressStepsRow[];
}

function clampLines(
  value: string,
  maxWidth: number,
  fontSize: number,
  weight: ProgressFontWeight,
  maxLines: number,
): string[] {
  const wrapped = wrapProgressTextToWidth(value, maxWidth, fontSize, weight);
  if (wrapped.length <= maxLines) return wrapped;
  const rest = wrapped.slice(maxLines - 1).join(" ");
  return [
    ...wrapped.slice(0, maxLines - 1),
    ellipsizeProgressText(`${rest}…`, maxWidth, fontSize, weight),
  ];
}

/** The steps picture of a projected run, laid out at the phone width. */
export function buildProgressStepsModel(
  progress: ExecutionProgress,
  options: { theme?: ProgressTheme } = {},
): ProgressStepsModel {
  const width = PROGRESS_STEPS_WIDTH;
  const type = progressTypeScale(width);
  const inner = width - PADDING * 2;
  const headerLines = clampLines(
    progress.taskTitle || progress.title || "Execution progress",
    inner,
    type.header.task,
    "bold",
    HEADER_MAX_LINES,
  );
  const header: ProgressStepsText = {
    lines: headerLines,
    fontSize: type.header.task,
    lineHeight: type.header.taskLine,
    weight: "bold",
    x: PADDING,
    y: PADDING,
    maxWidth: inner,
  };
  let cursorY = PADDING + headerLines.length * type.header.taskLine + 12;

  const rows = progress.nodes.map((node, position): ProgressStepsRow => {
    const x = PADDING;
    const rowInner = inner - ROW_PADDING * 2;
    const indexText = String(position + 1);
    const indexWidth = Math.max(
      type.badgeHeight,
      progressTextWidth(indexText, type.badge, "semibold") + 12,
    );
    const titleX = x + ROW_PADDING + indexWidth + INDEX_GAP;
    const titleWidth = rowInner - indexWidth - INDEX_GAP;
    const titleLines = clampLines(node.label, titleWidth, type.title, "bold", 2);
    let y = cursorY + ROW_PADDING;
    const title: ProgressStepsText = {
      lines: titleLines.length ? titleLines : [" "],
      fontSize: type.title,
      lineHeight: type.titleLine,
      weight: "bold",
      x: titleX,
      y,
      maxWidth: titleWidth,
    };
    const index = {
      text: indexText,
      x: x + ROW_PADDING,
      y: y + Math.round((type.titleLine - type.badgeHeight) / 2),
      width: indexWidth,
      height: type.badgeHeight,
    };
    y += title.lines.length * type.titleLine + 6;
    const chipText = ellipsizeProgressText(
      progressStatusText(node.status, node.iterations, progress.waitingFor),
      titleWidth - 16,
      type.badge,
      "semibold",
    );
    const chip = {
      text: chipText,
      x: titleX,
      y,
      width: progressTextWidth(chipText, type.badge, "semibold") + 16,
      height: type.badgeHeight,
      fontSize: type.badge,
    };
    y += type.badgeHeight;
    let list: ProgressStepsText | null = null;
    const count = listProgressLabel(node.list);
    if (node.list && count !== null) {
      const text = node.list.currentTitle ? `${count}: ${node.list.currentTitle}` : count;
      y += 6;
      list = {
        lines: clampLines(text, titleWidth, type.content, "regular", 2),
        fontSize: type.content,
        lineHeight: type.contentLine,
        weight: "regular",
        x: titleX,
        y,
        maxWidth: titleWidth,
      };
      y += list.lines.length * type.contentLine;
    }
    const height = y + ROW_PADDING - cursorY;
    const row: ProgressStepsRow = {
      id: node.id,
      tone: progressCardTone(node.status),
      x,
      y: cursorY,
      width: inner,
      height,
      index,
      title,
      chip,
      list,
    };
    cursorY += height + ROW_GAP;
    return row;
  });

  return {
    theme: options.theme === "dark" ? "dark" : "light",
    width,
    height: cursorY - ROW_GAP + PADDING,
    header,
    rows,
  };
}

const WEIGHT: Record<ProgressFontWeight, number> = { regular: 400, semibold: 600, bold: 700 };

function textSvg(text: ProgressStepsText, fill: string): string {
  const baseline = text.y + text.fontSize;
  const spans = text.lines
    .map(
      (line, index) =>
        `<tspan x="${text.x}" dy="${index === 0 ? 0 : text.lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return `<text x="${text.x}" y="${baseline}" fill="${fill}" font-size="${text.fontSize}" font-weight="${WEIGHT[text.weight]}">${spans}</text>`;
}

/** The SVG of a steps model, coloured with the map's palette. */
export function renderProgressStepsSvg(model: ProgressStepsModel): string {
  const palette = progressPalette(model.theme);
  const chip: Record<ProgressCardTone, { fill: string; text: string }> = {
    active: { fill: palette.primary, text: palette.primaryForeground },
    waiting: { fill: palette.warning, text: palette.warningForeground },
    done: { fill: palette.success, text: palette.successForeground },
    neutral: { fill: palette.muted, text: palette.mutedForeground },
  };
  const stroke: Record<ProgressCardTone, string> = {
    active: palette.primary,
    waiting: palette.warning,
    done: palette.border,
    neutral: palette.border,
  };
  const rows = model.rows
    .map((row) => {
      const colours = chip[row.tone];
      const box = `<rect x="${row.x}" y="${row.y}" width="${row.width}" height="${row.height}" rx="12" fill="${palette.cardGround[row.tone]}" stroke="${stroke[row.tone]}" stroke-width="${row.tone === "active" || row.tone === "waiting" ? 2 : 1}"/>`;
      const index = `<rect x="${row.index.x}" y="${row.index.y}" width="${row.index.width}" height="${row.index.height}" rx="${row.index.height / 2}" fill="${palette.band[row.tone]}" stroke="${palette.border}"/><text x="${row.index.x + row.index.width / 2}" y="${row.index.y + row.index.height / 2}" text-anchor="middle" dominant-baseline="central" fill="${palette.foreground}" font-size="${row.chip.fontSize}" font-weight="600">${escapeXml(row.index.text)}</text>`;
      const chipSvg = `<rect x="${row.chip.x}" y="${row.chip.y}" width="${row.chip.width}" height="${row.chip.height}" rx="${row.chip.height / 2}" fill="${colours.fill}"/><text x="${row.chip.x + 8}" y="${row.chip.y + row.chip.height / 2}" dominant-baseline="central" fill="${colours.text}" font-size="${row.chip.fontSize}" font-weight="600">${escapeXml(row.chip.text)}</text>`;
      const list = row.list ? textSvg(row.list, palette.mutedForeground) : "";
      return `<g data-block="${escapeXml(row.id)}" data-tone="${row.tone}">${box}${index}${textSvg(row.title, palette.foreground)}${chipSvg}${list}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" font-family="DejaVu Sans, sans-serif"><rect width="100%" height="100%" fill="${palette.background}"/>${textSvg(model.header, palette.foreground)}${rows}</svg>`;
}

/** The steps picture of a run as a PNG, sharp at a phone's density. */
export async function renderProgressStepsPng(
  progress: ExecutionProgress,
  options: { theme?: ProgressTheme } = {},
): Promise<{ png: Buffer; model: ProgressStepsModel }> {
  const model = buildProgressStepsModel(progress, options);
  const png = await sharp(Buffer.from(renderProgressStepsSvg(model)), {
    density: 72 * PROGRESS_STEPS_DENSITY,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  if (png.length > PROGRESS_IMAGE_MAX_BYTES)
    throw new Error(`Progress PNG exceeds ${PROGRESS_IMAGE_MAX_BYTES} bytes`);
  return { png, model };
}

/**
 * The notification picture of a run: its steps picture, or null when the workflow has no
 * progress definition. `width` and `height` are the picture's CSS size; the PNG holds
 * `PROGRESS_STEPS_DENSITY` pixels per unit.
 */
export async function renderExecutionProgressStepsImage(
  workflow: WorkflowGraph,
  execution: WorkflowExecution,
): Promise<RenderedExecutionProgressImage | null> {
  const progress = projectExecutionRun(workflow, execution);
  if (!progress) return null;
  const { png, model } = await renderProgressStepsPng(progress);
  return {
    buffer: png,
    mimeType: "image/png",
    width: model.width,
    height: model.height,
    workflowVersion: progress.workflowVersion,
    executionRevision: progress.executionRevision,
  };
}
