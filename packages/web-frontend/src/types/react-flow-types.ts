/**
 * React Flow specific type definitions for MCP Moira
 */

import { WorkflowNode, StructuredCondition } from "./workflow-types";

export interface Node {
  id: string;
  type?: string;
  position: {
    x: number;
    y: number;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  draggable?: boolean;
  selectable?: boolean;
  deletable?: boolean;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  label?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  style?: Record<string, any>;
  animated?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export const Position = {
  Left: "left",
  Top: "top",
  Right: "right",
  Bottom: "bottom",
} as const;

export type Position = (typeof Position)[keyof typeof Position];

export type MoiraNodeType =
  | "start"
  | "agent-directive"
  | "condition"
  | "subgraph"
  | "telegram-notification"
  | "expression"
  | "read-note"
  | "write-note"
  | "upsert-note"
  | "end"
  | "fallback";

export interface MoiraNodeData extends Record<string, unknown> {
  nodeId: string;
  nodeType: MoiraNodeType;
  label: string;
  description?: string;
  validationStatus: "valid" | "invalid" | "warning";
  validationErrors?: string[];
  validationWarnings?: string[];
  color?: string;
  icon?: string;
  originalNode: WorkflowNode;
}

export interface StartNodeData extends MoiraNodeData {
  nodeType: "start";
  initialData?: Record<string, unknown>;
  defaultConnection: string;
}

export interface AgentDirectiveNodeData extends MoiraNodeData {
  nodeType: "agent-directive";
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
  maxRetries?: number;
  retryMessage?: string;
  connections: {
    success: string;
    error?: string;
    timeout?: string;
    maxRetriesExceeded?: string;
  };
}

export interface ConditionNodeData extends MoiraNodeData {
  nodeType: "condition";
  condition: StructuredCondition;
  conditionSummary: string;
  trueConnection: string;
  falseConnection: string;
}

export interface TelegramNodeData extends MoiraNodeData {
  nodeType: "telegram-notification";
  message: string;
  chatId?: string;
  parseMode?: string;
}

export interface SubgraphNodeData extends MoiraNodeData {
  nodeType: "subgraph";
  graphId: string;
  inputMapping?: Record<string, string>;
  outputMapping?: Record<string, string>;
  connections: {
    success: string;
    error?: string;
  };
  onWorkflowNavigate?: (folder: string, workflowId: string) => void;
}

export interface EndNodeData extends MoiraNodeData {
  nodeType: "end";
  finalOutput?: string[];
  outputDescription?: string;
}

export interface ExpressionNodeData extends MoiraNodeData {
  nodeType: "expression";
  expressions: string[];
  defaultConnection: string;
  errorConnection?: string;
}

export interface ReadNoteNodeData extends MoiraNodeData {
  nodeType: "read-note";
  outputVariable: string;
  filter?: {
    tag?: string;
    keyPattern?: string;
    keySearch?: string;
  };
  singleMode?: boolean;
  defaultConnection: string;
  errorConnection?: string;
}

export interface WriteNoteNodeData extends MoiraNodeData {
  nodeType: "write-note";
  key?: string;
  source: string;
  tags?: string[];
  batchMode?: boolean;
  defaultConnection: string;
  errorConnection?: string;
}

export interface UpsertNoteNodeData extends MoiraNodeData {
  nodeType: "upsert-note";
  search?: {
    tag?: string;
    keyPattern?: string;
  };
  keyTemplate: string;
  value: string;
  tags?: string[];
  outputVariable?: string;
  defaultConnection: string;
  errorConnection?: string;
}

/**
 * Fallback node data for unknown/unsupported node types
 * Displays with warning badge instead of crashing the application
 */
export interface FallbackNodeData extends MoiraNodeData {
  nodeType: "fallback";
  /** The original unrecognized node type string */
  originalType: string;
  /** Generic connections extracted from original node */
  connections?: Record<string, string>;
}

export type MoiraNodeDataUnion =
  | StartNodeData
  | AgentDirectiveNodeData
  | ConditionNodeData
  | SubgraphNodeData
  | TelegramNodeData
  | ExpressionNodeData
  | ReadNoteNodeData
  | WriteNoteNodeData
  | UpsertNoteNodeData
  | EndNodeData
  | FallbackNodeData;

export interface MoiraReactFlowNode extends Node {
  type: MoiraNodeType;
  data: MoiraNodeDataUnion;
  measured?: {
    width?: number;
    height?: number;
  };
}

export interface MoiraReactFlowEdge extends Edge {
  type?: "smart" | "default" | "straight" | "step" | "smoothstep";
  markerEnd?: {
    type: "arrow" | "arrowclosed";
    color?: string;
    width?: number;
    height?: number;
  };
  data?: {
    connectionType:
      | "default"
      | "success"
      | "error"
      | "timeout"
      | "true"
      | "false"
      | "maxRetriesExceeded";
    label?: string;
    color?: string;
    style?: "solid" | "dashed" | "dotted";
  };
}

export interface WorkflowVisualizationData {
  nodes: MoiraReactFlowNode[];
  edges: MoiraReactFlowEdge[];
  metadata: {
    workflowId: string;
    workflowName: string;
    nodeCount: number;
    edgeCount: number;
    validationStatus: "valid" | "invalid" | "warning";
    lastModified?: number;
  };
}

export interface LayoutOptions {
  algorithm: "dagre" | "manual" | "force" | "hierarchical";
  direction: "TB" | "BT" | "LR" | "RL";
  nodeSpacing: number;
  rankSpacing: number;
  padding: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  algorithm: "dagre",
  direction: "TB",
  nodeSpacing: 150,
  rankSpacing: 100,
  padding: {
    top: 40,
    right: 40,
    bottom: 40,
    left: 40,
  },
};

export interface NodeStyleConfig {
  nodeType: MoiraNodeType;
  colors: {
    primary: string;
    background: string;
    border: string;
    text: string;
  };
  shape: "circle" | "rectangle" | "diamond" | "octagon";
  icon: string;
  minWidth: number;
  minHeight: number;
}

/**
 * Default node styles - compact dimensions for redesigned visualization
 * All node types now use ~120x40px for uniform compact appearance
 */
export const DEFAULT_NODE_STYLES: Record<MoiraNodeType, NodeStyleConfig> = {
  start: {
    nodeType: "start",
    colors: {
      primary: "#22c55e",
      background: "#f0fdf4",
      border: "#86efac",
      text: "#166534",
    },
    shape: "rectangle",
    icon: "play",
    minWidth: 120,
    minHeight: 40,
  },
  "agent-directive": {
    nodeType: "agent-directive",
    colors: {
      primary: "#3b82f6",
      background: "#eff6ff",
      border: "#93c5fd",
      text: "#1e40af",
    },
    shape: "rectangle",
    icon: "bot",
    minWidth: 120,
    minHeight: 40,
  },
  condition: {
    nodeType: "condition",
    colors: {
      primary: "#f59e0b",
      background: "#fffbeb",
      border: "#fcd34d",
      text: "#b45309",
    },
    shape: "rectangle",
    icon: "git-branch",
    minWidth: 120,
    minHeight: 40,
  },
  "telegram-notification": {
    nodeType: "telegram-notification",
    colors: {
      primary: "#a855f7",
      background: "#faf5ff",
      border: "#d8b4fe",
      text: "#7c3aed",
    },
    shape: "rectangle",
    icon: "send",
    minWidth: 120,
    minHeight: 40,
  },
  subgraph: {
    nodeType: "subgraph",
    colors: {
      primary: "#ec4899",
      background: "#fdf2f8",
      border: "#f9a8d4",
      text: "#db2777",
    },
    shape: "rectangle",
    icon: "workflow",
    minWidth: 120,
    minHeight: 40,
  },
  end: {
    nodeType: "end",
    colors: {
      primary: "#ef4444",
      background: "#fef2f2",
      border: "#fca5a5",
      text: "#b91c1c",
    },
    shape: "rectangle",
    icon: "square",
    minWidth: 120,
    minHeight: 40,
  },
  expression: {
    nodeType: "expression",
    colors: {
      primary: "#8b5cf6",
      background: "#f5f3ff",
      border: "#c4b5fd",
      text: "#6d28d9",
    },
    shape: "rectangle",
    icon: "code",
    minWidth: 120,
    minHeight: 40,
  },
  "read-note": {
    nodeType: "read-note",
    colors: {
      primary: "#06b6d4",
      background: "#ecfeff",
      border: "#67e8f9",
      text: "#0e7490",
    },
    shape: "rectangle",
    icon: "file-text",
    minWidth: 120,
    minHeight: 40,
  },
  "write-note": {
    nodeType: "write-note",
    colors: {
      primary: "#14b8a6",
      background: "#f0fdfa",
      border: "#5eead4",
      text: "#0f766e",
    },
    shape: "rectangle",
    icon: "file-edit",
    minWidth: 120,
    minHeight: 40,
  },
  "upsert-note": {
    nodeType: "upsert-note",
    colors: {
      primary: "#0ea5e9",
      background: "#f0f9ff",
      border: "#7dd3fc",
      text: "#0369a1",
    },
    shape: "rectangle",
    icon: "file-plus",
    minWidth: 120,
    minHeight: 40,
  },
  fallback: {
    nodeType: "fallback",
    colors: {
      primary: "#78716c",
      background: "#fafaf9",
      border: "#d6d3d1",
      text: "#57534e",
    },
    shape: "rectangle",
    icon: "help-circle",
    minWidth: 120,
    minHeight: 40,
  },
};

export const NODE_HANDLE_POSITIONS: Record<
  MoiraNodeType,
  {
    targets: Position[];
    sources: Position[];
  }
> = {
  start: {
    targets: [],
    sources: [Position.Bottom],
  },
  "agent-directive": {
    targets: [Position.Top],
    sources: [Position.Bottom, Position.Right],
  },
  condition: {
    targets: [Position.Top],
    sources: [Position.Left, Position.Right],
  },
  "telegram-notification": {
    targets: [Position.Top],
    sources: [Position.Bottom],
  },
  subgraph: {
    targets: [Position.Left],
    sources: [Position.Right],
  },
  end: {
    targets: [Position.Top],
    sources: [],
  },
  expression: {
    targets: [Position.Top],
    sources: [Position.Bottom],
  },
  "read-note": {
    targets: [Position.Top],
    sources: [Position.Bottom],
  },
  "write-note": {
    targets: [Position.Top],
    sources: [Position.Bottom],
  },
  "upsert-note": {
    targets: [Position.Top],
    sources: [Position.Bottom],
  },
  fallback: {
    targets: [Position.Top],
    sources: [Position.Bottom],
  },
};

export interface EdgeStyleConfig {
  connectionType: string;
  color: string;
  style: "solid" | "dashed" | "dotted";
  width: number;
  animated?: boolean;
}

export const DEFAULT_EDGE_STYLES: Record<string, EdgeStyleConfig> = {
  default: {
    connectionType: "default",
    color: "#52c41a",
    style: "solid",
    width: 2,
    animated: false,
  },
  success: {
    connectionType: "success",
    color: "#52c41a",
    style: "solid",
    width: 2,
    animated: false,
  },
  error: {
    connectionType: "error",
    color: "#f5222d",
    style: "dashed",
    width: 2,
    animated: false,
  },
  timeout: {
    connectionType: "timeout",
    color: "#faad14",
    style: "dotted",
    width: 2,
    animated: false,
  },
  true: {
    connectionType: "true",
    color: "#52c41a",
    style: "solid",
    width: 2,
    animated: false,
  },
  false: {
    connectionType: "false",
    color: "#f5222d",
    style: "solid",
    width: 2,
    animated: false,
  },
  maxRetriesExceeded: {
    connectionType: "maxRetriesExceeded",
    color: "#cf1322",
    style: "dashed",
    width: 2,
    animated: true,
  },
};

export interface WorkflowValidationStatus {
  isValid: boolean;
  nodeValidation: Record<
    string,
    {
      isValid: boolean;
      errors: string[];
      warnings: string[];
    }
  >;
  globalErrors: string[];
  globalWarnings: string[];
}
