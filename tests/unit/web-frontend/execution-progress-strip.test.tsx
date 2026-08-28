/** @jest-environment jsdom */
import React from "react";
import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExecutionProgressStrip } from "../../../packages/web-frontend/src/components/execution/ExecutionProgressStrip.js";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";

const progress: ExecutionProgress = {
  taskTitle: "Implement a complete progress map without hidden content",
  title: "Development",
  goal: "Show decisions, current activity, and the next significant step",
  facts: [
    { label: "Mode", value: "Autonomous", tone: "neutral" },
    { label: "Attention", value: "Not required", tone: "positive" },
  ],
  activeNodeId: "review",
  workflowVersion: "1.0.0",
  executionRevision: 3,
  executionStatus: "running",
  diagnostics: [],
  nodes: [
    {
      id: "build",
      label: "Build",
      state: "completed",
      connections: { default: "review" },
      primaryNodeIds: ["build-node"],
      focusNodeId: "build-node",
      content: {
        summary: "Plan revision 2",
        details: ["Core model", "Visible UI"],
        outcome: "Plan accepted",
        next: "Independent review",
      },
    },
    {
      id: "review",
      label: "Independent review",
      state: "current",
      connections: { default: "repair" },
      primaryNodeIds: ["review-a", "review-b"],
      focusNodeId: "review-b",
      content: {
        summary: "Unit 2 of 4 · iteration 1",
        details: ["Review the shared semantic model"],
        outcome: null,
        next: "Repair or checkpoint",
      },
    },
    {
      id: "repair",
      label: "Repair",
      state: "pending",
      connections: { default: "review" },
      primaryNodeIds: ["repair-node"],
      focusNodeId: null,
      content: { summary: "Not started", details: [], outcome: null, next: null },
    },
  ],
};

describe("ExecutionProgressStrip", () => {
  beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "execution-progress-scroller" ? 360 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "execution-progress-scroller" ? 300 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "progress-node-review" ? 500 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "progress-node-review" ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "progress-node-review" ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "progress-node-review" ? 200 : 0;
      },
    });
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([], this);
        void target;
      }
      unobserve() {}
      disconnect() {}
    };
  });

  test("renders shared model states/back edge and focuses projection-selected nodes", () => {
    const focus = jest.fn();
    render(<ExecutionProgressStrip progress={progress} onFocusNode={focus} />);
    expect(screen.getByTestId("execution-progress")).toBeTruthy();
    expect(screen.getByTestId("execution-progress-scroller").className).toContain("overflow-auto");
    expect(screen.getByTestId("execution-progress-model").style.width).toBe("360px");
    expect(screen.getByTestId("progress-node-review").getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("progress-node-review").getAttribute("aria-label")).toBeNull();
    expect(screen.getByTestId("execution-progress-scroller").scrollTop).toBe(484);
    expect(screen.getByTestId("execution-progress-scroller").scrollLeft).toBe(20);
    expect(
      screen.getByRole("button", {
        name: /Independent review.*current.*Unit 2 of 4.*Review the shared semantic model.*Repair or checkpoint/i,
      }),
    ).toBeTruthy();
    expect(screen.getByTestId("execution-progress-task-title").textContent).toContain(
      "complete progress map",
    );
    expect(screen.getByTestId("execution-progress-goal").textContent).toContain(
      "next significant step",
    );
    expect(screen.getByText("Plan revision 2")).toBeTruthy();
    expect(screen.getByText(/Repair or checkpoint/)).toBeTruthy();
    expect(screen.getByText("Autonomous")).toBeTruthy();
    expect(screen.getByText("Not required")).toBeTruthy();
    expect(screen.getByTestId("progress-node-build").getAttribute("data-state")).toBe("completed");
    expect(document.querySelector('path[data-direction="cross-row"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId("progress-node-review"));
    expect(focus).toHaveBeenCalledWith("review-b");
    fireEvent.click(screen.getByTestId("progress-node-build"));
    expect(focus).toHaveBeenCalledWith("build-node");
    expect(screen.getByTestId("progress-node-repair").tagName).toBe("ARTICLE");
    expect(screen.getByTestId("progress-node-build").textContent).toMatch(/completed/i);
    expect(screen.getByTestId("progress-node-review").textContent).toMatch(/current/i);
    expect(screen.getByTestId("progress-node-repair").textContent).toMatch(/pending/i);
  });
});
