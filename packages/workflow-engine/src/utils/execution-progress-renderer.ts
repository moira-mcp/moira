import sharp from "sharp";
import type { ExecutionProgress } from "./execution-progress.js";
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

export function renderProgressVisualSvg(model: ProgressVisualModel): string {
  const dark = model.theme === "dark";
  const palette = {
    background: dark ? "#10131a" : "#f7f8fb",
    text: dark ? "#f4f6fb" : "#172033",
    muted: dark ? "#aeb7c8" : "#596579",
    pending: dark ? "#252b38" : "#ffffff",
    completed: dark ? "#18372d" : "#e8f7ef",
    current: dark ? "#243d73" : "#e8efff",
    border: dark ? "#4d586d" : "#c8cfda",
    accent: "#4f7cff",
    success: "#27a66a",
    warning: "#d18a00",
    critical: "#dc3e4d",
  };
  let cursorY = 28;
  const header: string[] = [];
  header.push(
    textLines(
      model.taskTitleLines,
      40,
      cursorY,
      26,
      `fill="${palette.text}" font-size="20" font-weight="700"`,
    ),
  );
  cursorY += model.taskTitleLines.length * 26;
  if (model.titleLines.length) {
    cursorY += 6;
    header.push(
      textLines(
        model.titleLines,
        40,
        cursorY,
        18,
        `fill="${palette.muted}" font-size="13" font-weight="600"`,
      ),
    );
    cursorY += model.titleLines.length * 18;
  }
  if (model.goalLines.length) {
    cursorY += 10;
    header.push(
      textLines(model.goalLines, 40, cursorY, 20, `fill="${palette.text}" font-size="14"`),
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
        17,
        `fill="${palette.muted}" font-size="11" font-weight="600"`,
      );
      const valueY = fact.y + 20 + fact.labelLines.length * 17;
      const value = textLines(
        fact.valueLines,
        fact.x + 12,
        valueY,
        17,
        `fill="${palette.text}" font-size="13" font-weight="650"`,
      );
      return `<g><rect x="${fact.x}" y="${fact.y}" width="${fact.width}" height="${fact.height}" rx="12" fill="${palette.pending}" stroke="${tone}" stroke-width="2"/>${label}${value}</g>`;
    })
    .join("");
  const edges = model.edges
    .map(
      (edge) =>
        `<path d="${edge.path}" fill="none" stroke="${edge.direction === "backward" ? palette.accent : palette.border}" stroke-width="3" stroke-linecap="round"${edge.direction === "backward" ? ' stroke-dasharray="7 6"' : ""}/>`,
    )
    .join("");
  const nodes = model.nodes
    .map((node) => {
      const fill =
        node.state === "current"
          ? palette.current
          : node.state === "completed"
            ? palette.completed
            : palette.pending;
      const stroke =
        node.state === "current"
          ? palette.accent
          : node.state === "completed"
            ? palette.success
            : palette.border;
      const mark = node.state === "completed" ? "✓" : node.state === "current" ? "●" : "○";
      const state =
        node.state === "completed" ? "Completed" : node.state === "current" ? "Current" : "Pending";
      const labelY = node.y + 26;
      const label = textLines(
        node.labelLines,
        node.x + 38,
        labelY,
        20,
        `fill="${palette.text}" font-size="14" font-weight="700"`,
      );
      let lineY = labelY + Math.max(1, node.labelLines.length) * 20 + 12;
      const content = node.lines
        .map((line) => {
          const prefix = !line.marker
            ? ""
            : line.kind === "detail"
              ? "• "
              : line.kind === "outcome"
                ? "✓ "
                : line.kind === "next"
                  ? "→ "
                  : "";
          const color =
            line.kind === "next"
              ? stroke
              : line.kind === "outcome"
                ? palette.success
                : line.kind === "detail"
                  ? palette.muted
                  : palette.text;
          const weight = line.kind === "summary" ? "650" : "450";
          const rendered = `<text x="${node.x + 18}" y="${lineY}" fill="${color}" font-size="12" font-weight="${weight}">${escapeXml(prefix + line.text)}</text>`;
          lineY += 18;
          return rendered;
        })
        .join("");
      return `<g><title>${escapeXml(`${state}: ${node.label}`)}</title><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="${node.state === "current" ? 4 : 2}"/><text x="${node.x + 14}" y="${node.y + 27}" fill="${stroke}" font-size="18" font-weight="700">${mark}</text>${label}${content}</g>`;
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
