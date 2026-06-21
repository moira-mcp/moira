/* eslint-disable no-console */
/**
 * Layout State Management Hook
 * Manages layout state, panel sizing, responsive behavior
 *
 * Note: console.warn used for browser debugging of localStorage failures
 */

import { useState, useEffect, useCallback } from "react";
import { BREAKPOINTS, LAYOUT } from "../theme/tokens";

interface LayoutState {
  explorerWidth: number;
  viewerWidth: number;
  isExplorerCollapsed: boolean;
  isMobile: boolean;
  isTablet: boolean;
  windowWidth: number;
  windowHeight: number;
}

interface LayoutActions {
  setExplorerWidth: (width: number) => void;
  toggleExplorer: () => void;
  collapseExplorer: () => void;
  expandExplorer: () => void;
  resetLayout: () => void;
}

const STORAGE_KEY = "mcp-moira-layout-preferences";

const getInitialExplorerWidth = (): number => {
  if (typeof window === "undefined") return LAYOUT.panelMinWidth;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return Math.max(
        LAYOUT.panelMinWidth,
        Math.min(LAYOUT.panelMaxWidth, parsed.explorerWidth || LAYOUT.panelMinWidth),
      );
    }
  } catch (error) {
    console.warn("Failed to parse layout preferences from localStorage:", error);
  }

  return LAYOUT.panelMinWidth;
};

const calculateResponsiveDimensions = (
  windowWidth: number,
  windowHeight: number,
  explorerWidth: number,
) => {
  const isMobile = windowWidth < BREAKPOINTS.mobile;
  const isTablet = windowWidth >= BREAKPOINTS.mobile && windowWidth < BREAKPOINTS.desktop;

  let actualExplorerWidth = explorerWidth;
  let viewerWidth = windowWidth - explorerWidth;

  // Responsive adjustments
  if (isMobile) {
    actualExplorerWidth = windowWidth; // Full width on mobile
    viewerWidth = 0;
  } else if (isTablet) {
    const maxWidth = Math.floor(windowWidth * 0.4); // Max 40% on tablet
    actualExplorerWidth = Math.min(explorerWidth, maxWidth);
    viewerWidth = windowWidth - actualExplorerWidth;
  }

  return {
    explorerWidth: actualExplorerWidth,
    viewerWidth,
    isMobile,
    isTablet,
  };
};

export const useLayoutState = (): LayoutState & LayoutActions => {
  // Window dimensions state
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  const [windowHeight, setWindowHeight] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800,
  );

  // Explorer width state
  const [explorerWidth, setExplorerWidthState] = useState(getInitialExplorerWidth);
  const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(false);

  // Calculate responsive dimensions
  const dimensions = calculateResponsiveDimensions(windowWidth, windowHeight, explorerWidth);

  // Window resize handler
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Persist layout preferences
  const persistPreferences = useCallback((width: number) => {
    if (typeof window === "undefined") return;

    try {
      const preferences = {
        explorerWidth: width,
        timestamp: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch (error) {
      console.warn("Failed to save layout preferences to localStorage:", error);
    }
  }, []);

  // Actions
  const setExplorerWidth = useCallback(
    (width: number) => {
      const clampedWidth = Math.max(LAYOUT.panelMinWidth, Math.min(LAYOUT.panelMaxWidth, width));
      setExplorerWidthState(clampedWidth);
      persistPreferences(clampedWidth);
    },
    [persistPreferences],
  );

  const toggleExplorer = useCallback(() => {
    setIsExplorerCollapsed((prev) => !prev);
  }, []);

  const collapseExplorer = useCallback(() => {
    setIsExplorerCollapsed(true);
  }, []);

  const expandExplorer = useCallback(() => {
    setIsExplorerCollapsed(false);
  }, []);

  const resetLayout = useCallback(() => {
    setExplorerWidthState(LAYOUT.panelMinWidth);
    setIsExplorerCollapsed(false);
    persistPreferences(LAYOUT.panelMinWidth);
  }, [persistPreferences]);

  return {
    // State
    explorerWidth: isExplorerCollapsed ? 0 : dimensions.explorerWidth,
    viewerWidth: isExplorerCollapsed ? windowWidth : dimensions.viewerWidth,
    isExplorerCollapsed,
    isMobile: dimensions.isMobile,
    isTablet: dimensions.isTablet,
    windowWidth,
    windowHeight,

    // Actions
    setExplorerWidth,
    toggleExplorer,
    collapseExplorer,
    expandExplorer,
    resetLayout,
  };
};
