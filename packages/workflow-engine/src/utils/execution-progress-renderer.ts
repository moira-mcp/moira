import sharp from "sharp";
import type { ExecutionProgress } from "./execution-progress-contract.js";
import {
  buildExecutionProgressVisualModel,
  type ProgressVisualModel,
  type ProgressVisualOptions,
} from "./execution-progress-visual.js";

export const PROGRESS_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textLines(
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
  attributes: string,
): string {
  if (!lines.length) return "";
  return `<text x="${x}" y="${y}" ${attributes}>${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

/**
 * The SVG of a visual model. Every font size and line height comes from the model's type scale,
 * so what is drawn is what the model measured; the block colours follow the web map — accent for
 * the block the run is on, green for a completed or repeated one, muted for skipped and pending.
 */
export function renderProgressVisualSvg(model: ProgressVisualModel): string {
  const dark = model.theme === "dark";
  const { type } = model;
  const palette = {
    background: dark ? "#10131a" : "#f7f8fb",
    text: dark ? "#f4f6fb" : "#172033",
    muted: dark ? "#aeb7c8" : "#596579",
    pending: dark ? "#252b38" : "#ffffff",
    skipped: dark ? "#1a1e28" : "#eef0f4",
    completed: dark ? "#18372d" : "#e8f7ef",
    current: dark ? "#243d73" : "#e8efff",
    border: dark ? "#4d586d" : "#c8cfda",
    accent: "#4f7cff",
    success: "#27a66a",
    warning: "#d18a00",
    critical: "#dc3e4d",
  };
  let cursorY = model.headerY;
  const header: string[] = [];
  header.push(
    textLines(
      model.taskTitleLines,
      model.headerX,
      cursorY,
      type.header.taskLine,
      `fill="${palette.text}" font-size="${type.header.task}" font-weight="700"`,
    ),
  );
  cursorY += model.taskTitleLines.length * type.header.taskLine;
  if (model.titleLines.length) {
    cursorY += 6;
    header.push(
      textLines(
        model.titleLines,
        model.headerX,
        cursorY,
        type.header.titleLine,
        `fill="${palette.muted}" font-size="${type.header.title}" font-weight="600"`,
      ),
    );
    cursorY += model.titleLines.length * type.header.titleLine;
  }
  if (model.goalLines.length) {
    cursorY += 10;
    header.push(
      textLines(
        model.goalLines,
        model.headerX,
        cursorY,
        type.header.goalLine,
        `fill="${palette.text}" font-size="${type.header.goal}"`,
      ),
    );
  }
  const facts = model.facts
    .map((fact) => {
      const tone =
        fact.tone === "critical"
          ? palette.critical
          : fact.tone === "warning"
            ? palette.warning
            : fact.tone === "positive"
              ? palette.success
              : palette.border;
      const label = textLines(
        fact.labelLines,
        fact.x + 12,
        fact.y + 20,
        type.fact.line,
        `fill="${palette.muted}" font-size="${type.fact.label}" font-weight="600"`,
      );
      const valueY = fact.y + 20 + fact.labelLines.length * type.fact.line;
      const value = textLines(
        fact.valueLines,
        fact.x + 12,
        valueY,
        type.fact.line,
        `fill="${palette.text}" font-size="${type.fact.value}" font-weight="650"`,
      );
      return `<g><rect x="${fact.x}" y="${fact.y}" width="${fact.width}" height="${fact.height}" rx="12" fill="${palette.pending}" stroke="${tone}" stroke-width="2"/>${label}${value}</g>`;
    })
    .join("");
  const edges = model.edges
    .map((edge) => {
      const loop = edge.cycle || edge.direction === "backward";
      const path = `<path d="${edge.path}" fill="none" stroke="${loop ? palette.accent : palette.border}" stroke-width="3" stroke-linecap="round"${loop ? ' stroke-dasharray="7 6"' : ""}/>`;
      if (!edge.labelLines.length) return path;
      const anchor = edge.labelAnchor;
      const label = `<text x="${edge.labelX}" y="${edge.labelY}" text-anchor="${anchor}" fill="${loop ? palette.accent : palette.muted}" font-size="${type.label}" font-weight="600">${edge.labelLines.map((line, index) => `<tspan x="${edge.labelX}" dy="${index === 0 ? 0 : type.labelLine}">${escapeXml(line)}</tspan>`).join("")}</text>`;
      return path + label;
    })
    .join("");
  const nodes = model.nodes
    .map((node) => {
      const finished = node.status === "done" || node.status === "repeated";
      const onBlock = node.status === "active" || node.status === "waiting";
      const muted = node.status === "skipped" || node.status === "pending";
      const fill = onBlock
        ? palette.current
        : finished
          ? palette.completed
          : node.status === "skipped"
            ? palette.skipped
            : palette.pending;
      const stroke = onBlock ? palette.accent : finished ? palette.success : palette.border;
      const statusColor = onBlock ? palette.accent : finished ? palette.success : palette.muted;
      const titleColor = muted ? palette.muted : palette.text;
      const title = textLines(
        node.labelLines,
        node.titleX,
        node.titleY,
        type.titleLine,
        `fill="${titleColor}" font-size="${type.title}" font-weight="700"${node.status === "skipped" ? ' text-decoration="line-through"' : ""}`,
      );
      // The repeat count is a secondary badge beside the mark, never part of the title.
      const badge = node.badge
        ? `<rect x="${node.badge.x}" y="${node.badge.y}" width="${node.badge.width}" height="${node.badge.height}" rx="${node.badge.height / 2}" fill="${palette.background}" stroke="${palette.border}" stroke-width="1"/><text x="${node.badge.x + 5}" y="${node.badge.y + node.badge.height - 4}" fill="${palette.muted}" font-size="${type.badge}" font-weight="600">${escapeXml(node.badge.text)}</text>`
        : "";
      const body = node.collapsed
        ? ""
        : `<text x="${node.titleX}" y="${node.statusY}" fill="${statusColor}" font-size="${type.content}" font-weight="600">${escapeXml(node.statusLine)}</text><text x="${node.titleX}" y="${node.factsY}" fill="${palette.muted}" font-size="${type.content}">${escapeXml(node.factsLine)}</text>`;
      const content = node.lines
        .map((line, index) => {
          const color =
            line.kind === "next"
              ? statusColor
              : line.kind === "outcome"
                ? palette.success
                : line.kind === "detail"
                  ? palette.muted
                  : palette.text;
          const weight = line.kind === "summary" ? "650" : "450";
          const y = node.contentY + index * type.contentLine;
          return `<text x="${node.contentX}" y="${y}" fill="${color}" font-size="${type.content}" font-weight="${weight}">${escapeXml(line.prefix + line.text)}</text>`;
        })
        .join("");
      const markY = node.titleY + Math.round((type.mark - type.title) / 4);
      return `<g${node.collapsed ? ' data-collapsed="true"' : ""}><title>${escapeXml(`${node.statusLine}: ${node.label}`)}</title><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.collapsed ? node.height / 2 : 16}" fill="${fill}" stroke="${stroke}" stroke-width="${onBlock ? 4 : 2}"${node.collapsed ? ' stroke-dasharray="4 4"' : ""}/><text x="${node.markX}" y="${markY}" fill="${stroke}" font-size="${type.mark}" font-weight="700">${node.mark}</text>${badge}${title}${body}${content}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" font-family="DejaVu Sans, sans-serif"><rect width="100%" height="100%" fill="${palette.background}"/>${header.join("")}${facts}${edges}${nodes}</svg>`;
}

export async function renderExecutionProgressPng(
  progress: ExecutionProgress,
  options: ProgressVisualOptions = {},
): Promise<{ png: Buffer; model: ProgressVisualModel }> {
  const model = buildExecutionProgressVisualModel(progress, options);
  const png = await sharp(Buffer.from(renderProgressVisualSvg(model)))
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  if (png.length > PROGRESS_IMAGE_MAX_BYTES)
    throw new Error(`Progress PNG exceeds ${PROGRESS_IMAGE_MAX_BYTES} bytes`);
  return { png, model };
}
