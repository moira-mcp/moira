/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import McpPromptsEditor, {
  PROMPT_TYPES,
  PROMPT_LABELS,
  parseHistoryChanges,
} from "@/components/settings/McpPromptsEditor";

// Mock react-i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Mock cn utility
jest.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  Loader2: (props: any) => <span data-testid="loader" {...props} />,
  Save: (props: any) => <span data-testid="save-icon" {...props} />,
  RotateCcw: (props: any) => <span data-testid="reset-icon" {...props} />,
  History: (props: any) => <span data-testid="history-icon" {...props} />,
}));

// Mock UI components to simple HTML equivalents
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

jest.mock("@/components/ui/select", () => ({
  Select: ({ children, onValueChange, value, disabled }: any) => (
    <div data-value={value} data-disabled={disabled}>
      {React.Children.map(children, (child: any) =>
        child ? React.cloneElement(child, { onValueChange }) : null,
      )}
    </div>
  ),
  SelectTrigger: ({ children, ...props }: any) => (
    <div role="combobox" {...props}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value, ...props }: any) => (
    <option value={value} {...props}>
      {children}
    </option>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
}));

const mockFetchValue = jest
  .fn()
  .mockResolvedValue({ value: "test prompt content", key: "settings.systemPrompt.default" });
const mockSave = jest.fn().mockResolvedValue(undefined);
const mockReset = jest.fn().mockResolvedValue(undefined);

const defaultProps = {
  onFetchValue: mockFetchValue,
  onSave: mockSave,
  onReset: mockReset,
  testIdPrefix: "mcp-prompt",
};

describe("McpPromptsEditor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Master-detail layout", () => {
    it("renders left panel with all 10 prompt items", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      const promptList = screen.getByTestId("prompt-list");
      expect(promptList).toBeInTheDocument();

      for (const pt of PROMPT_TYPES) {
        const testId = `prompt-item-${pt.replace(".", "-")}`;
        expect(screen.getByTestId(testId)).toHaveTextContent(PROMPT_LABELS[pt]);
      }
    });

    it("renders section headers for System Prompts and Tool Descriptions", () => {
      render(<McpPromptsEditor {...defaultProps} />);

      expect(screen.getByText("admin.mcpPrompts.systemPrompts")).toBeInTheDocument();
      expect(screen.getByText("admin.mcpPrompts.toolDescriptions")).toBeInTheDocument();
    });

    it("selects systemPrompt by default and renders its editor", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("mcp-prompt-systemPrompt")).toBeInTheDocument();
      });

      // First call should be for systemPrompt
      expect(mockFetchValue).toHaveBeenCalledWith("systemPrompt", "default", null);
    });

    it("switches editor when clicking a different prompt", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      // Wait for initial load
      await waitFor(() => {
        expect(mockFetchValue).toHaveBeenCalledWith("systemPrompt", "default", null);
      });

      // Click on systemReminder
      fireEvent.click(screen.getByTestId("prompt-item-systemReminder"));

      await waitFor(() => {
        expect(screen.getByTestId("mcp-prompt-systemReminder")).toBeInTheDocument();
      });

      expect(mockFetchValue).toHaveBeenCalledWith("systemReminder", "default", null);
    });

    it("switches to tool description when clicked", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        expect(mockFetchValue).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByTestId("prompt-item-toolDescription-list"));

      await waitFor(() => {
        expect(screen.getByTestId("mcp-prompt-toolDescription-list")).toBeInTheDocument();
      });

      expect(mockFetchValue).toHaveBeenCalledWith("toolDescription.list", "default", null);
    });
  });

  describe("Editor rendering", () => {
    it("renders textarea with fetched value after loading", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        const textarea = screen.getByTestId("mcp-prompt-systemPrompt-input") as HTMLTextAreaElement;
        expect(textarea.value).toBe("test prompt content");
      });
    });

    it("renders save button disabled when no changes", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        const saveBtn = screen.getByTestId("mcp-prompt-systemPrompt-save");
        expect(saveBtn).toBeDisabled();
      });
    });

    it("enables save button after editing textarea", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("mcp-prompt-systemPrompt-input")).toBeInTheDocument();
      });

      const textarea = screen.getByTestId("mcp-prompt-systemPrompt-input");
      fireEvent.change(textarea, { target: { value: "modified content" } });

      const saveBtn = screen.getByTestId("mcp-prompt-systemPrompt-save");
      expect(saveBtn).not.toBeDisabled();
    });

    it("calls onSave with correct params when save is clicked", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("mcp-prompt-systemPrompt-input")).toBeInTheDocument();
      });

      const textarea = screen.getByTestId("mcp-prompt-systemPrompt-input");
      fireEvent.change(textarea, { target: { value: "new value" } });

      const saveBtn = screen.getByTestId("mcp-prompt-systemPrompt-save");
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(mockSave).toHaveBeenCalledWith("systemPrompt", "default", null, "new value");
      });
    });

    it("renders character count", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/19.*admin\.globalSettings\.characters/)).toBeInTheDocument();
      });
    });

    it("does not render fullscreen modal or maximize button", async () => {
      render(<McpPromptsEditor {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId("mcp-prompt-systemPrompt-input")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("fullscreen-modal")).not.toBeInTheDocument();
      expect(screen.queryByTestId("mcp-prompt-systemPrompt-fullscreen")).not.toBeInTheDocument();
    });
  });

  describe("Error handling", () => {
    it("handles fetch error gracefully", async () => {
      const errorFetch = jest.fn().mockRejectedValue(new Error("API error"));
      render(<McpPromptsEditor {...defaultProps} onFetchValue={errorFetch} />);

      await waitFor(() => {
        const textarea = screen.getByTestId("mcp-prompt-systemPrompt-input") as HTMLTextAreaElement;
        expect(textarea.value).toBe("");
      });
    });
  });
});

describe("parseHistoryChanges", () => {
  it("returns empty object for undefined input", () => {
    expect(parseHistoryChanges(undefined)).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseHistoryChanges("")).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    expect(parseHistoryChanges("not json")).toEqual({});
  });

  it("extracts oldValue and newValue from array with value field", () => {
    const json = JSON.stringify([{ field: "value", oldValue: "old", newValue: "new" }]);
    expect(parseHistoryChanges(json)).toEqual({ oldValue: "old", newValue: "new" });
  });

  it("handles null values in changes", () => {
    const json = JSON.stringify([{ field: "value", oldValue: null, newValue: "new" }]);
    expect(parseHistoryChanges(json)).toEqual({ oldValue: null, newValue: "new" });
  });

  it("returns empty object for array without value field", () => {
    const json = JSON.stringify([{ field: "other", oldValue: "a", newValue: "b" }]);
    expect(parseHistoryChanges(json)).toEqual({});
  });

  it("returns parsed object for non-array JSON", () => {
    const json = JSON.stringify({ oldValue: "old", newValue: "new" });
    expect(parseHistoryChanges(json)).toEqual({ oldValue: "old", newValue: "new" });
  });

  it("handles array with multiple fields and picks value", () => {
    const json = JSON.stringify([
      { field: "metadata", oldValue: "x", newValue: "y" },
      { field: "value", oldValue: "before", newValue: "after" },
    ]);
    expect(parseHistoryChanges(json)).toEqual({ oldValue: "before", newValue: "after" });
  });
});
