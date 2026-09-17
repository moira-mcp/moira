/**
 * The map's layout and port geometry are the engine's: `layoutBlocks` (rows, lanes, presets),
 * `blockRows`, the edge routing and the port-to-lane paths live in the engine's `progress-visual`
 * entry so the progress picture draws the same process the same way. This module is the map's
 * door to them.
 */

export {
  BLOCK_WIDTH,
  PARALLEL_CHIP_MIN,
  blockRows,
  crossesBlock,
  estimatePortedBlockHeight,
  labelPillWidth,
  layoutBlocks,
  overlappingBlocks,
  portRanks,
  portedPath,
  portedPoints,
  roundedPath,
  stackedPoints,
  transitionKey,
  type BlockLayout,
  type LaidOutBlock,
  type LaidOutEdge,
  type LayoutBlock,
  type LayoutBlocksOptions,
  type LayoutTransition,
  type PortSlots,
} from "@mcp-moira/workflow-engine/progress-visual";
