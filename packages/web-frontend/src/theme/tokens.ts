/**
 * Design Tokens - Base Theme System
 * Consistent design tokens for MCP Moira Web UI
 */

// Node Type Colors
export const NODE_COLORS = {
  start: {
    primary: "#10B981", // Green
    background: "#ECFDF5",
    border: "#6EE7B7",
    hover: "#059669",
  },
  agentDirective: {
    primary: "#3B82F6", // Blue
    background: "#EFF6FF",
    border: "#93C5FD",
    hover: "#2563EB",
  },
  condition: {
    primary: "#F59E0B", // Yellow/Amber
    background: "#FFFBEB",
    border: "#FCD34D",
    hover: "#D97706",
  },
  end: {
    primary: "#8B5CF6", // Purple
    background: "#F3E8FF",
    border: "#C4B5FD",
    hover: "#7C3AED",
  },
  telegram: {
    primary: "#0088CC", // Telegram Blue
    background: "#E6F3FF",
    border: "#66B3FF",
    hover: "#0066AA",
  },
  subgraph: {
    primary: "#EC4899", // Pink for workflow composition
    background: "#FDF2F8",
    border: "#F9A8D4",
    hover: "#DB2777",
    selected: "#FCE7F3",
    selectedBorder: "#EC4899",
  },
} as const;

// Spacing System (8px grid)
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

// Typography Scale
export const TYPOGRAPHY = {
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    xxl: 24,
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.7,
  },
} as const;

// Layout Breakpoints
export const BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  desktop: 1280,
} as const;

// Shadow System
export const SHADOWS = {
  sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  base: "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)",
  md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
  lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
} as const;

// Border Radius System
export const BORDER_RADIUS = {
  sm: 4,
  base: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

// Animation Durations
export const ANIMATION = {
  fast: "150ms",
  normal: "300ms",
  slow: "500ms",
} as const;

// Layout Constants
export const LAYOUT = {
  headerHeight: 64,
  explorerWidthPercentage: 30,
  viewerWidthPercentage: 70,
  panelMinWidth: 300,
  panelMaxWidth: 600,
} as const;
