/**
 * @jest-environment jsdom
 */

import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { I18nextProvider } from "react-i18next";
import type {
  FallbackNodeData,
  MaterializeNodeData,
  SubgraphNodeData,
} from "../../../packages/web-frontend/src/types";
import i18n from "../../../packages/web-frontend/src/i18n";

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

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
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

function fallbackData(
  fallbackReason: FallbackNodeData["fallbackReason"],
  originalType: string,
  extensionName?: string,
): FallbackNodeData {
  return {
    nodeId: "unknown-node",
    nodeType: "fallback",
    label: originalType,
    validationStatus: "warning",
    originalNode: {
      id: "unknown-node",
      type: originalType,
      connections: { default: "done" },
    } as FallbackNodeData["originalNode"],
    originalType,
    fallbackReason,
    extensionName,
  };
}

function renderCompact(data: FallbackNodeData) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CompactNode data={data} selected={false} />
    </I18nextProvider>,
  );
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

  test("explains missing, unavailable and unknown node types in English", () => {
    const { rerender } = renderCompact(
      fallbackData("extension-missing", "corporate-messenger.send", "corporate-messenger"),
    );
    expect(
      screen.getByText('Type of extension "corporate-messenger", which is not installed here'),
    ).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <CompactNode
          data={fallbackData(
            "extension-unavailable",
            "corporate-messenger.send",
            "corporate-messenger",
          )}
          selected={false}
        />
      </I18nextProvider>,
    );
    expect(
      screen.getByText('Type of extension "corporate-messenger", which is not connected here'),
    ).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <CompactNode data={fallbackData("unknown", "not-a-type")} selected={false} />
      </I18nextProvider>,
    );
    expect(screen.getByText("Unknown node type: not-a-type")).toBeInTheDocument();
  });

  test("explains missing, unavailable and unknown node types in Russian", async () => {
    await i18n.changeLanguage("ru");
    const { rerender } = renderCompact(
      fallbackData("extension-missing", "corporate-messenger.send", "corporate-messenger"),
    );
    expect(
      screen.getByText("Тип расширения «corporate-messenger», которое здесь не установлено"),
    ).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <CompactNode
          data={fallbackData(
            "extension-unavailable",
            "corporate-messenger.send",
            "corporate-messenger",
          )}
          selected={false}
        />
      </I18nextProvider>,
    );
    expect(
      screen.getByText(
        "Тип расширения «corporate-messenger», подключение к которому здесь недоступно",
      ),
    ).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <CompactNode data={fallbackData("unknown", "not-a-type")} selected={false} />
      </I18nextProvider>,
    );
    expect(screen.getByText("Неизвестный тип узла: not-a-type")).toBeInTheDocument();
    expect(screen.queryByText("Unknown node type: not-a-type")).not.toBeInTheDocument();
  });
});
