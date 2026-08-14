/**
 * @jest-environment jsdom
 */

import React from "react";
import { beforeAll, describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type {
  MaterializeNodeData,
  SubgraphNodeData,
} from "../../../packages/web-frontend/src/types";

jest.unstable_mockModule("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Top: "top", Right: "right", Bottom: "bottom" },
}));

jest.unstable_mockModule("@/components/ui/tooltip", () => {
  const PassThrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    Tooltip: PassThrough,
    TooltipContent: PassThrough,
    TooltipProvider: PassThrough,
    TooltipTrigger: PassThrough,
  };
});

let CompactNode: typeof import("../../../packages/web-frontend/src/components/nodes/CompactNode").default;

beforeAll(async () => {
  CompactNode = (await import("../../../packages/web-frontend/src/components/nodes/CompactNode"))
    .default;
});

function materializeData(
  description: string,
  basePath: string,
  filePaths: string[],
): MaterializeNodeData {
  return {
    nodeId: "prepare-files",
    nodeType: "materialize",
    label: "Materialize Files",
    description,
    validationStatus: "valid",
    originalNode: {
      type: "materialize",
      id: "prepare-files",
      basePath,
      files: filePaths.map((path) => ({ path, content: "" })),
      connections: { success: "done" },
    },
    basePath,
    filePaths,
    fileCount: filePaths.length,
    successConnection: "done",
  };
}

function subgraphData(onWorkflowNavigate: (workflowId: string) => void): SubgraphNodeData {
  return {
    nodeId: "nested",
    nodeType: "subgraph",
    label: "Nested Workflow",
    description: "Open nested workflow",
    validationStatus: "valid",
    originalNode: {
      type: "subgraph",
      id: "nested",
      graphId: "child-workflow",
      connections: { success: "done" },
    },
    graphId: "child-workflow",
    connections: { success: "done" },
    onWorkflowNavigate,
  };
}

describe("CompactNode", () => {
  test("replaces a stale materialize tooltip after same-node data changes", () => {
    const { rerender } = render(
      <CompactNode
        data={materializeData("1 file → workspace/one", "workspace/one", ["README.md"])}
        selected={false}
      />,
    );

    expect(screen.getByText("1 file → workspace/one")).toBeInTheDocument();

    rerender(
      <CompactNode
        data={materializeData("2 files → workspace/two", "workspace/two", [
          "README.md",
          "src/.keep",
        ])}
        selected={false}
      />,
    );

    expect(screen.getByText("2 files → workspace/two")).toBeInTheDocument();
    expect(screen.queryByText("1 file → workspace/one")).not.toBeInTheDocument();
  });

  test("replaces stale validation text when an invalid node receives a new error", () => {
    const initial = {
      ...materializeData("1 file → workspace", "workspace", ["README.md"]),
      validationStatus: "invalid" as const,
      validationErrors: ["Old validation error"],
    };
    const { rerender } = render(<CompactNode data={initial} selected={false} />);

    expect(screen.getByText("Old validation error")).toBeInTheDocument();

    rerender(
      <CompactNode
        data={{ ...initial, validationErrors: ["New validation error"] }}
        selected={false}
      />,
    );

    expect(screen.getByText("New validation error")).toBeInTheDocument();
    expect(screen.queryByText("Old validation error")).not.toBeInTheDocument();
  });

  test("uses the current subgraph navigation callback after rerender", () => {
    const oldNavigate = jest.fn();
    const currentNavigate = jest.fn();
    const { rerender } = render(<CompactNode data={subgraphData(oldNavigate)} selected={false} />);

    rerender(<CompactNode data={subgraphData(currentNavigate)} selected={false} />);
    fireEvent.doubleClick(screen.getByText("Nested Workflow"));

    expect(currentNavigate).toHaveBeenCalledWith("child-workflow");
    expect(oldNavigate).not.toHaveBeenCalled();
  });
});
