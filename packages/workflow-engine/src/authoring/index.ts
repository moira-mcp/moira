/**
 * Workflow authoring — pure, browser-safe mutations of a workflow definition, shared by every
 * editing path (the browser editor, the `moira-workflow` CLI, scripts). Each function takes a
 * graph and returns a new one; nothing here performs I/O, validates the whole graph or reaches the
 * server. Full validation stays with `GraphValidator`; the process contract is reported by
 * `deriveProcess` (`@mcp-moira/workflow-engine/process`).
 *
 * This module is imported by the browser bundle: it may import engine *types* only, plus other
 * modules of this directory.
 */

export { AuthoringError, type AuthoringErrorCode } from "./errors.js";
export { readChoice, setChoice, type Choice } from "./choice.js";
export {
  checkConnected,
  checkNewStep,
  checkOwnCopy,
  TUTORIAL_CHECKED_LESSONS,
  TUTORIAL_FINDING_CODES,
  type CopyFacts,
  type LessonFinding,
  type LessonResult,
  type ProcessIssue,
} from "./tutorial.js";
export {
  CONNECTION_KEY_PATTERN,
  NODE_ID_PATTERN,
  isValidConnectionKey,
  isValidNodeId,
} from "./node-id.js";
export { PRIMARY_OUTPUTS, primaryOutputOf } from "./outputs.js";
export {
  findNodeReferences,
  findProseMentions,
  rewriteNodeReferences,
  type ReferenceLocation,
} from "./references.js";
export {
  addBlock,
  clearConnectionLabel,
  editBlock,
  removeBlock,
  setConnectionLabel,
  setNodeBlock,
  type BlockInput,
  type CycleExplanation,
} from "./process.js";
export {
  addNode,
  edgeId,
  incomingEdges,
  insertNodeOnEdge,
  removeConnection,
  removeNode,
  renameNode,
  setConnection,
  type Edge,
  type IncomingDecision,
} from "./structure.js";
