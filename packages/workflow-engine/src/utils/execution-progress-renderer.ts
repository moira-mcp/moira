import sharp from "sharp";
import type { ExecutionProgress } from "./execution-progress-contract.js";
import type { WorkflowVersionStatistics } from "./execution-statistics.js";
import {
  buildExecutionProgressVisualModel,
  type ProgressCardTone,
  type ProgressEdgeKind,
  type ProgressPortKind,
  type ProgressTheme,
  type ProgressVisualModel,
  type ProgressVisualNode,
  type ProgressVisualOptions,
  type ProgressVisualPort,
} from "./execution-progress-visual.js";

export const PROGRESS_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The picture's colours per theme: literal hex, because librsvg (which `sharp` rasterises with)
 * knows neither CSS variables nor `oklch()`. Every value is the app's own token from
 * `packages/web-frontend/src/styles/globals.css` (`:root` and `.dark`) converted to sRGB, and the
 * blends are the map's Tailwind alpha classes over the card or the page — `bandActive` is
 * `bg-primary/15`, `groundDone` the `from-success/10` end of the card gradient, `ground` the
 * diagram's `bg-muted/20` — so the picture is coloured by the interface's tokens, not a third set.
 */
interface Palette {
  background: string;
  ground: string;
  card: string;
  foreground: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  muted: string;
  /** Title-band ground and card ground per tone. */
  band: Record<ProgressCardTone, string>;
  cardGround: Record<ProgressCardTone, string>;
  /** The return port's amber, as `PORT_TONE.return` (Tailwind amber-500 border, amber-600/400 text). */
  returnBorder: string;
  returnText: string;
}

const LIGHT: Palette = {
  background: "#f9fafb",
  ground: "#f8f9fa",
  card: "#ffffff",
  foreground: "#070a10",
  mutedForeground: "#5d636f",
  border: "#dbdee5",
  primary: "#2152cf",
  primaryForeground: "#fafafa",
  success: "#0b7f00",
  successForeground: "#fafafa",
  warning: "#ff880e",
  warningForeground: "#281c18",
  muted: "#f2f3f7",
  band: { neutral: "#fafafc", active: "#dee5f8", waiting: "#ffe7cf", done: "#e2f0e0" },
  cardGround: { neutral: "#ffffff", active: "#edf1fb", waiting: "#fff3e7", done: "#f0f7f0" },
  returnBorder: "#f59e0b",
  returnText: "#d97706",
};

const DARK: Palette = {
  background: "#111419",
  ground: "#16191f",
  card: "#171b20",
  foreground: "#fafafa",
  mutedForeground: "#9da1a7",
  border: "#333840",
  primary: "#4783ff",
  primaryForeground: "#fafafa",
  success: "#006a20",
  successForeground: "#75d78d",
  warning: "#936831",
  warningForeground: "#e1ac6e",
  muted: "#292e36",
  band: { neutral: "#1e2329", active: "#1e2b41", waiting: "#302a23", done: "#142420" },
  cardGround: { neutral: "#171b20", active: "#1b2332", waiting: "#232322", done: "#162020" },
  returnBorder: "#f59e0b",
  returnText: "#fbbf24",
};

export function progressPalette(theme: ProgressTheme): Palette {
  return theme === "dark" ? DARK : LIGHT;
}

/** The rest look of every edge kind: the map's `EDGE_LOOK`, colours resolved per theme. */
interface EdgeLook {
  stroke: (p: Palette) => string;
  width: number;
  opacity: number;
  dash?: string;
  marker: "plain" | "return";
}
const EDGE_LOOK: Record<ProgressEdgeKind, EdgeLook> = {
  forward: { stroke: (p) => p.mutedForeground, width: 2, opacity: 0.75, marker: "plain" },
  skip: {
    stroke: (p) => p.mutedForeground,
    width: 1.5,
    opacity: 0.5,
    dash: "2 4",
    marker: "plain",
  },
  hub: { stroke: (p) => p.mutedForeground, width: 1.25, opacity: 0.4, marker: "plain" },
  return: { stroke: (p) => p.primary, width: 1.5, opacity: 0.6, dash: "6 5", marker: "return" },
  self: { stroke: (p) => p.primary, width: 1.5, opacity: 0.6, dash: "6 5", marker: "return" },
};
/** Returns are drawn over forward lines, hub bundles beneath everything, as the map orders them. */
const EDGE_ORDER: Record<ProgressEdgeKind, number> = {
  hub: 0,
  forward: 1,
  skip: 1,
  return: 2,
  self: 2,
};

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

/** A pill: a rounded rectangle with one line of text vertically centred. */
function pill(
  box: { x: number; y: number; width: number; height: number },
  fill: string,
  stroke: string,
  extra = "",
): string {
  return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${box.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1"${extra}/>`;
}

/** The marker definitions: one arrowhead per look, the same size whatever the line's width. */
function markers(palette: Palette): string {
  const marker = (id: string, fill: string, opacity: number) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${fill}" fill-opacity="${opacity}"/></marker>`;
  return `<defs>${marker("arrow-plain", palette.mutedForeground, 0.75)}${marker("arrow-return", palette.primary, 0.7)}</defs>`;
}

function portTone(
  kind: ProgressPortKind,
  palette: Palette,
): { stroke: string; text: string; dash: string } {
  if (kind === "return")
    return {
      stroke: palette.returnBorder,
      text: palette.returnText,
      dash: ' stroke-dasharray="3 2"',
    };
  return { stroke: palette.border, text: palette.foreground, dash: "" };
}

function toneStroke(tone: ProgressCardTone, palette: Palette): string {
  return tone === "active"
    ? palette.primary
    : tone === "waiting"
      ? palette.warning
      : tone === "done"
        ? palette.success
        : palette.border;
}

function chipColours(node: ProgressVisualNode, palette: Palette): { fill: string; text: string } {
  switch (node.status) {
    case "active":
      return { fill: palette.primary, text: palette.primaryForeground };
    case "waiting":
      return { fill: palette.warning, text: palette.warningForeground };
    case "done":
    case "repeated":
      return { fill: palette.success, text: palette.successForeground };
    default:
      return { fill: palette.muted, text: palette.mutedForeground };
  }
}

function renderPort(
  port: ProgressVisualPort,
  side: "in" | "out" | "loop",
  palette: Palette,
  font: number,
  handleStroke: string,
): string {
  const tone = portTone(port.kind, palette);
  const baseline = port.y + port.height / 2 + font * 0.36;
  const detail = port.detailText
    ? `<text x="${port.x + port.detailX}" y="${baseline}" fill="${palette.mutedForeground}" font-size="${font - 1}">${escapeXml(port.detailText)}</text>`
    : "";
  const dot = (cx: number) =>
    `<circle cx="${cx}" cy="${port.handleY}" r="4" fill="${palette.card}" stroke="${handleStroke}" stroke-width="2"/>`;
  const handle = side === "loop" ? dot(port.handleX) + dot(port.handleX + 18) : dot(port.handleX);
  return `<g data-port="${side}" data-port-kind="${port.kind}" data-transition="${escapeXml(port.id)}">${pill(port, palette.background, tone.stroke, tone.dash)}<text x="${port.x + port.textX}" y="${baseline}" fill="${tone.text}" font-size="${font}" font-weight="600">${escapeXml(port.text)}</text>${detail}${handle}</g>`;
}

function renderCard(
  node: ProgressVisualNode,
  model: ProgressVisualModel,
  palette: Palette,
): string {
  const { type } = model;
  const stroke = toneStroke(node.tone, palette);
  const bandFill = palette.band[node.tone];
  const ground = palette.cardGround[node.tone];
  const parts: string[] = [];
  parts.push(`<title>${escapeXml(`${node.index}. ${node.label} — ${node.statusLine}`)}</title>`);
  // The frame with the tone's accent bar on the left, the band and the rule beneath it.
  parts.push(
    `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" fill="${ground}" stroke="${stroke}" stroke-width="${node.tone === "neutral" ? 1 : 1.5}"${node.collapsed ? ' stroke-dasharray="4 4"' : ""}/>`,
  );
  parts.push(
    `<rect x="${node.x}" y="${node.y}" width="4" height="${node.height}" rx="2" fill="${node.tone === "neutral" ? palette.border : stroke}"/>`,
  );
  parts.push(
    `<path d="M ${node.x + 4} ${node.y} H ${node.x + node.width - 12} Q ${node.x + node.width} ${node.y} ${node.x + node.width} ${node.y + 12} V ${node.y + node.bandHeight} H ${node.x + 4} Z" fill="${bandFill}"/>`,
  );
  parts.push(
    `<line x1="${node.x + 4}" y1="${node.y + node.bandHeight}" x2="${node.x + node.width}" y2="${node.y + node.bandHeight}" stroke="${stroke}" stroke-width="2" stroke-opacity="${node.tone === "neutral" ? 1 : 0.6}"/>`,
  );
  // Index badge, title, pass count, status chip.
  const badgeText = (
    box: { x: number; y: number; width: number; height: number; text: string },
    fill: string,
    weight = "600",
  ) =>
    `<text x="${box.x + box.width / 2}" y="${box.y + box.height / 2 + type.badge * 0.36}" text-anchor="middle" fill="${fill}" font-size="${type.badge}" font-weight="${weight}">${escapeXml(box.text)}</text>`;
  const indexFill = node.tone === "neutral" ? palette.mutedForeground : stroke;
  parts.push(
    `<rect x="${node.indexBadge.x}" y="${node.indexBadge.y}" width="${node.indexBadge.width}" height="${node.indexBadge.height}" rx="6" fill="${indexFill}"/>${badgeText(node.indexBadge, palette.primaryForeground, "700")}`,
  );
  parts.push(
    textLines(
      node.labelLines,
      node.titleX,
      node.titleY,
      type.titleLine,
      `fill="${node.status === "skipped" ? palette.mutedForeground : palette.foreground}" font-size="${type.title}" font-weight="700"${node.status === "skipped" ? ' text-decoration="line-through"' : ""}`,
    ),
  );
  if (node.badge)
    parts.push(
      `<text x="${node.badge.x}" y="${node.badge.y + node.badge.height / 2 + type.badge * 0.36}" fill="${palette.mutedForeground}" font-size="${type.badge}" font-weight="600" data-pass-count="${node.iterations}">${escapeXml(node.badge.text)}</text>`,
    );
  const chip = chipColours(node, palette);
  parts.push(
    `<g data-status="${node.status}">${pill(node.chip, chip.fill, chip.fill)}${badgeText(node.chip, chip.text)}</g>`,
  );
  if (!node.collapsed) {
    // Port columns, separated from the centre by a dashed rule.
    if (node.inputs.length)
      parts.push(
        `<line x1="${node.x + type.card.portColumn}" y1="${node.y + node.bandHeight}" x2="${node.x + type.card.portColumn}" y2="${node.selfBandY ?? node.y + node.height}" stroke="${palette.border}" stroke-dasharray="3 3"/>`,
      );
    if (node.outputs.length)
      parts.push(
        `<line x1="${node.x + node.width - type.card.portColumn}" y1="${node.y + node.bandHeight}" x2="${node.x + node.width - type.card.portColumn}" y2="${node.selfBandY ?? node.y + node.height}" stroke="${palette.border}" stroke-dasharray="3 3"/>`,
      );
    // The centre: description, facts, typical, content.
    parts.push(
      textLines(
        node.descriptionLines,
        node.contentX,
        node.descriptionY,
        type.contentLine,
        `fill="${palette.mutedForeground}" font-size="${type.content}"`,
      ),
    );
    if (node.factsLine)
      parts.push(
        `<text x="${node.contentX}" y="${node.factsY}" fill="${palette.mutedForeground}" font-size="${type.content}" data-facts="">${escapeXml(node.factsLine)}</text>`,
      );
    if (node.typicalLine)
      parts.push(
        `<text x="${node.contentX}" y="${node.typicalY}" fill="${palette.mutedForeground}" font-size="${type.content}" font-style="italic" data-typical="">${escapeXml(node.typicalLine)}</text>`,
      );
    node.lines.forEach((line, index) => {
      const color =
        line.kind === "next"
          ? palette.primary
          : line.kind === "outcome"
            ? palette.success
            : line.kind === "detail"
              ? palette.mutedForeground
              : palette.foreground;
      const weight = line.kind === "summary" ? "650" : "450";
      const y = node.contentY + index * type.contentLine;
      parts.push(
        `<text x="${node.contentX}" y="${y}" fill="${color}" font-size="${type.content}" font-weight="${weight}">${escapeXml(line.prefix + line.text)}</text>`,
      );
    });
    for (const port of node.inputs)
      parts.push(
        renderPort(
          port,
          "in",
          palette,
          type.label,
          port.kind === "return" ? palette.returnBorder : palette.mutedForeground,
        ),
      );
    for (const port of node.outputs)
      parts.push(
        renderPort(
          port,
          "out",
          palette,
          type.label,
          port.kind === "return" ? palette.returnBorder : palette.mutedForeground,
        ),
      );
    if (node.selfBandY !== null) {
      parts.push(
        `<path d="M ${node.x + 4} ${node.selfBandY} H ${node.x + node.width} V ${node.y + node.height - 12} Q ${node.x + node.width} ${node.y + node.height} ${node.x + node.width - 12} ${node.y + node.height} H ${node.x + 4} Z" fill="${palette.band.neutral}"/><line x1="${node.x + 4}" y1="${node.selfBandY}" x2="${node.x + node.width}" y2="${node.selfBandY}" stroke="${palette.border}" stroke-dasharray="3 3"/>`,
      );
      for (const port of node.selfPorts)
        parts.push(renderPort(port, "loop", palette, type.label, palette.returnBorder));
    }
  }
  return `<g data-block-id="${escapeXml(node.id)}" data-tone="${node.tone}"${node.collapsed ? ' data-collapsed="true"' : ""}>${parts.join("")}</g>`;
}

/**
 * The SVG of a visual model. Every font size and line height comes from the model's type scale,
 * so what is drawn is what the model measured; the cards, ports and edges follow the map's
 * vocabulary (tone by status, port kind, edge kind) in the app's own colours.
 */
export function renderProgressVisualSvg(model: ProgressVisualModel): string {
  const palette = progressPalette(model.theme);
  const { type } = model;
  let cursorY = model.headerY;
  const header: string[] = [];
  header.push(
    textLines(
      model.taskTitleLines,
      model.headerX,
      cursorY,
      type.header.taskLine,
      `fill="${palette.foreground}" font-size="${type.header.task}" font-weight="700"`,
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
        `fill="${palette.mutedForeground}" font-size="${type.header.title}" font-weight="600"`,
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
        `fill="${palette.foreground}" font-size="${type.header.goal}"`,
      ),
    );
  }
  const facts = model.facts
    .map((fact) => {
      const tone =
        fact.tone === "critical"
          ? "#dc3e4d"
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
        `fill="${palette.mutedForeground}" font-size="${type.fact.label}" font-weight="600"`,
      );
      const valueY = fact.y + 20 + fact.labelLines.length * type.fact.line;
      const value = textLines(
        fact.valueLines,
        fact.x + 12,
        valueY,
        type.fact.line,
        `fill="${palette.foreground}" font-size="${type.fact.value}" font-weight="650"`,
      );
      return `<g><rect x="${fact.x}" y="${fact.y}" width="${fact.width}" height="${fact.height}" rx="12" fill="${palette.card}" stroke="${tone}" stroke-width="2"/>${label}${value}</g>`;
    })
    .join("");
  const edges = [...model.edges]
    .sort((a, b) => EDGE_ORDER[a.kind] - EDGE_ORDER[b.kind])
    .map((edge) => {
      const look = EDGE_LOOK[edge.kind];
      // A halo in the ground colour under the line, so a crossing reads as over and under.
      const halo = `<path d="${edge.path}" fill="none" stroke="${palette.ground}" stroke-width="6" stroke-opacity="0.9" stroke-linecap="round"/>`;
      const line = `<path d="${edge.path}" fill="none" stroke="${look.stroke(palette)}" stroke-width="${look.width}" stroke-opacity="${look.opacity}"${look.dash ? ` stroke-dasharray="${look.dash}"` : ""} marker-end="url(#arrow-${look.marker})"/>`;
      return `<g data-edge-kind="${edge.kind}" data-transition="${escapeXml(edge.id)}"><title>${escapeXml(edge.label)}</title>${halo}${line}</g>`;
    })
    .join("");
  const nodes = model.nodes.map((node) => renderCard(node, model, palette)).join("");
  const { diagram } = model;
  const ground = `<rect x="${diagram.x}" y="${diagram.y}" width="${Math.round(diagram.width * diagram.scale)}" height="${Math.round(diagram.height * diagram.scale)}" rx="12" fill="${palette.ground}"/>`;
  const transform = `translate(${diagram.x} ${diagram.y})${diagram.scale !== 1 ? ` scale(${diagram.scale})` : ""}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" font-family="DejaVu Sans, sans-serif">${markers(palette)}<rect width="100%" height="100%" fill="${palette.background}"/>${header.join("")}${facts}${ground}<g transform="${transform}" data-diagram="${diagram.preset}">${edges}${nodes}</g></svg>`;
}

export async function renderExecutionProgressPng(
  progress: ExecutionProgress,
  options: ProgressVisualOptions = {},
  statistics?: WorkflowVersionStatistics | null,
): Promise<{ png: Buffer; model: ProgressVisualModel }> {
  const model = await buildExecutionProgressVisualModel(progress, options, statistics);
  const png = await sharp(Buffer.from(renderProgressVisualSvg(model)))
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  if (png.length > PROGRESS_IMAGE_MAX_BYTES)
    throw new Error(`Progress PNG exceeds ${PROGRESS_IMAGE_MAX_BYTES} bytes`);
  return { png, model };
}
