/** @jest-environment jsdom */
import React from "react";
import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import { ExecutionProgressStrip } from "../../../packages/web-frontend/src/components/execution/ExecutionProgressStrip.js";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";

const progress: ExecutionProgress = {
  title: "Development",
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
    },
    {
      id: "review",
      label: "Independent review",
      state: "current",
      connections: { default: "repair" },
      primaryNodeIds: ["review-a", "review-b"],
      focusNodeId: "review-b",
    },
    {
      id: "repair",
      label: "Repair",
      state: "pending",
      connections: { default: "review" },
      primaryNodeIds: ["repair-node"],
      focusNodeId: "repair-node",
    },
  ],
};

describe("ExecutionProgressStrip", () => {
  beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  test("renders shared model states/back edge and focuses projection-selected nodes", () => {
    const focus = jest.fn();
    render(<ExecutionProgressStrip progress={progress} onFocusNode={focus} />);
    expect(screen.getByTestId("execution-progress")).toBeTruthy();
    expect(screen.getByTestId("progress-node-review").getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("progress-node-review").className).toContain("motion-safe:animate");
    expect(screen.getByTestId("progress-node-repair").className).not.toContain(
      "motion-safe:animate",
    );
    expect(screen.getByTestId("progress-node-build").getAttribute("data-state")).toBe("completed");
    expect(document.querySelector('path[data-direction="backward"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId("progress-node-review"));
    expect(focus).toHaveBeenCalledWith("review-b");
    fireEvent.click(screen.getByTestId("progress-node-build"));
    expect(focus).toHaveBeenCalledWith("build-node");
  });
});
