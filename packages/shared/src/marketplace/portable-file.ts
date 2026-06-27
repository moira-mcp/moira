/**
 * Portable flow-file format (the `.moira.json` envelope).
 *
 * ONE self-describing file shape is emitted by BOTH export surfaces — the owner
 * workflow export and the public storefront export-by-reference — and accepted by the
 * single import parser. Before this format the storefront emitted a wrapped
 * `{ listing, workflow }` shape that the import endpoint rejected, so a flow downloaded
 * from the store could not be imported into a self-host instance.
 *
 * The envelope carries:
 *   - `moiraFile` / `formatVersion`: a discriminator so import can recognise the file.
 *   - `source` (optional): provenance — the origin instance + listing/workflow identity
 *     + version. Store exports fill the listing identity; owner exports fill the
 *     workflow identity. Import uses this to dedupe/update on re-import (see
 *     `importFromFile`), so re-pulling an updated flow updates in place instead of
 *     duplicating.
 *   - `workflow`: the raw workflow graph.
 *
 * Pre-v1.0.0: the parser also tolerates a BARE workflow graph (a hand-authored file
 * with top-level `metadata` + `nodes`). This is input tolerance, NOT a back-compat
 * migration layer — two input shapes normalised by one parser.
 */

import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

/** Current portable-file format version. */
export const PORTABLE_FILE_FORMAT_VERSION = 2 as const;

/** The file discriminator value. */
export const PORTABLE_FILE_KIND = "workflow" as const;

/** Provenance of a portable flow file — where it came from, for import dedupe/update. */
export interface PortableFlowSource {
  /** Origin instance base URL (the instance that emitted the file). */
  instance?: string;
  /** Marketplace listing reference `handle/slug` (store exports only). */
  listingRef?: string;
  /** Marketplace listing id (store exports only). */
  listingId?: string;
  /** Source workflow id on the origin instance (owner/in-app exports). */
  workflowId?: string;
  /** Workflow version at export time. */
  version?: string;
}

/** The portable flow-file envelope emitted by both export paths. */
export interface PortableFlowFile {
  moiraFile: typeof PORTABLE_FILE_KIND;
  formatVersion: number;
  source?: PortableFlowSource;
  workflow: WorkflowGraph;
}

/** Result of parsing a portable file (or a bare graph). */
export interface ParsedPortableFile {
  workflow: WorkflowGraph;
  /** Provenance, when the file is an envelope that carried it. */
  source?: PortableFlowSource;
}

/** Thrown when an uploaded file is neither a valid envelope nor a bare workflow graph. */
export class PortableFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableFileParseError";
  }
}

const NOT_A_WORKFLOW = "Not a workflow file: expected an object with metadata and a nodes array";

/** Whether a value looks like a raw workflow graph (top-level metadata + nodes array). */
function isWorkflowGraph(value: unknown): value is WorkflowGraph {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.nodes) && v.metadata != null && typeof v.metadata === "object";
}

/** Drop undefined fields so the serialised `source` stays minimal. */
function compactSource(source: PortableFlowSource): PortableFlowSource | undefined {
  const entries = Object.entries(source).filter(([, val]) => val !== undefined && val !== null);
  return entries.length > 0 ? (Object.fromEntries(entries) as PortableFlowSource) : undefined;
}

/**
 * Build a portable flow-file envelope around a workflow graph. The `source` provenance
 * is optional and compacted (undefined fields dropped).
 */
export function buildPortableFile(
  workflow: WorkflowGraph,
  source?: PortableFlowSource,
): PortableFlowFile {
  const file: PortableFlowFile = {
    moiraFile: PORTABLE_FILE_KIND,
    formatVersion: PORTABLE_FILE_FORMAT_VERSION,
    workflow,
  };
  const compact = source ? compactSource(source) : undefined;
  if (compact) file.source = compact;
  return file;
}

/**
 * Parse an already-JSON-parsed upload into a workflow graph + optional provenance.
 *
 * Accepts (1) a portable-file envelope (`moiraFile: "workflow"` + a `workflow` graph),
 * or (2) a bare workflow graph (top-level `metadata` + `nodes`). Throws
 * {@link PortableFileParseError} for anything else.
 */
export function parsePortableFile(raw: unknown): ParsedPortableFile {
  if (raw === null || typeof raw !== "object") {
    throw new PortableFileParseError(NOT_A_WORKFLOW);
  }
  const obj = raw as Record<string, unknown>;

  // Envelope form — detected strictly by the discriminator (both export paths set it).
  if (obj.moiraFile === PORTABLE_FILE_KIND) {
    if (!isWorkflowGraph(obj.workflow)) {
      throw new PortableFileParseError(NOT_A_WORKFLOW);
    }
    const source =
      obj.source && typeof obj.source === "object"
        ? compactSource(obj.source as PortableFlowSource)
        : undefined;
    return { workflow: obj.workflow, source };
  }

  // Bare graph form (hand-authored input tolerance).
  if (isWorkflowGraph(obj)) {
    return { workflow: obj as unknown as WorkflowGraph };
  }

  throw new PortableFileParseError(NOT_A_WORKFLOW);
}
