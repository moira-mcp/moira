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

function truncateLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
}

function wrapLabel(value: string, lineLength: number): [string, string] {
  const words = truncateLabel(value).split(" ");
  const lines = ["", ""];
  let current = 0;
  for (const word of words) {
    if (!lines[current] && word.length > lineLength) {
      lines[current] = word.slice(0, lineLength);
      if (current === 0) {
        current = 1;
        lines[current] = word.slice(lineLength, lineLength * 2);
      }
      continue;
    }
    const candidate = lines[current] ? `${lines[current]} ${word}` : word;
    if (candidate.length <= lineLength) lines[current] = candidate;
    else if (current === 0) {
      current = 1;
      lines[current] = word.slice(0, lineLength);
    } else break;
  }
  const represented = `${lines[0]} ${lines[1]}`.trim().length;
  if (represented < truncateLabel(value).length && lines[1])
    lines[1] = `${lines[1].slice(0, Math.max(1, lineLength - 1))}…`;
  return [lines[0], lines[1]];
}

export function renderProgressVisualSvg(model: ProgressVisualModel): string {
  const dark = model.theme === "dark";
  const palette = {
    background: dark ? "#10131a" : "#f7f8fb",
    text: dark ? "#f4f6fb" : "#172033",
    muted: dark ? "#9aa4b7" : "#687386",
    pending: dark ? "#252b38" : "#ffffff",
    completed: dark ? "#18372d" : "#e8f7ef",
    current: dark ? "#243d73" : "#e8efff",
    border: dark ? "#4d586d" : "#c8cfda",
    accent: "#4f7cff",
    success: "#27a66a",
  };
  const title = model.title
    ? `<text x="40" y="34" fill="${palette.text}" font-size="20" font-weight="700">${escapeXml(truncateLabel(model.title))}</text>`
    : "";
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
      const label = truncateLabel(node.label);
      const lineLength = Math.max(9, Math.floor((node.width - 42) / 7.2));
      const [firstLine, secondLine] = wrapLabel(label, lineLength);
      return `<g><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="16" fill="${fill}" stroke="${stroke}" stroke-width="${node.state === "current" ? 4 : 2}"/><text x="${node.x + 14}" y="${node.y + 29}" fill="${stroke}" font-size="18" font-weight="700">${mark}</text><text x="${node.x + 38}" y="${node.y + 29}" fill="${palette.text}" font-size="14" font-weight="650">${escapeXml(firstLine)}</text><text x="${node.x + 38}" y="${node.y + 52}" fill="${palette.muted}" font-size="11">${escapeXml(secondLine)}</text></g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" font-family="DejaVu Sans, sans-serif"><rect width="100%" height="100%" fill="${palette.background}"/>${title}${edges}${nodes}</svg>`;
}

export async function renderExecutionProgressPng(
  progress: ExecutionProgress,
  options: ProgressVisualOptions = {},
): Promise<{ png: Buffer; model: ProgressVisualModel }> {
  const model = buildExecutionProgressVisualModel(progress, options);
  const png = await sharp(Buffer.from(renderProgressVisualSvg(model)))
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  if (png.length > PROGRESS_IMAGE_MAX_BYTES) {
    throw new Error(`Progress PNG exceeds ${PROGRESS_IMAGE_MAX_BYTES} bytes`);
  }
  return { png, model };
}
