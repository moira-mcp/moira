/**
 * ErrorBoundary Component Tests
 * Tests for error boundary with shadcn/ui components
 * @jest-environment jsdom
 */

import React from "react";
import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";

// Import ErrorBoundary
import ErrorBoundaryDefault, {
  ErrorBoundary,
  ErrorBoundaryClass,
} from "../../../packages/web-frontend/src/components/ErrorBoundary";

// Mock clientLogger to avoid actual API calls
jest.mock("../../../packages/web-frontend/src/services/client-logger", () => ({
  clientLogger: {
    error: jest.fn(),
  },
}));

// Component that throws an error
function ThrowError({ message = "Test error" }: { message?: string }) {
  throw new Error(message);
}

// Component that doesn't throw
function SafeComponent() {
  return <div data-testid="safe-content">Safe content</div>;
}

describe("ErrorBoundary", () => {
  // Suppress console.error during tests since we're testing error handling
  const originalConsoleError = console.error;
  beforeEach(() => {
    console.error = jest.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  describe("when no error occurs", () => {
    test("should render children normally", () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault>
            <SafeComponent />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      expect(screen.getByTestId("safe-content")).toBeInTheDocument();
      expect(screen.getByText("Safe content")).toBeInTheDocument();
    });
  });

  describe("when error occurs", () => {
    test("should display error card", () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault>
            <ThrowError />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      // Check that error boundary card is rendered
      expect(screen.getByTestId("error-boundary-card")).toBeInTheDocument();
      // Check title is shown
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });

    test("should display action buttons", () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault>
            <ThrowError />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      // Check all buttons are present
      expect(screen.getByTestId("error-try-again")).toBeInTheDocument();
      expect(screen.getByTestId("error-reload")).toBeInTheDocument();
      expect(screen.getByTestId("error-go-home")).toBeInTheDocument();
    });

    test("should display help text", () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault>
            <ThrowError />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      // Check help text is shown
      expect(screen.getByText("If this error persists:")).toBeInTheDocument();
      expect(screen.getByText("Try refreshing the page")).toBeInTheDocument();
    });
  });

  describe("showDetails prop", () => {
    test("should hide technical details when showDetails=false (production mode)", () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault showDetails={false}>
            <ThrowError message="Production error" />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      // Error card should be visible
      expect(screen.getByTestId("error-boundary-card")).toBeInTheDocument();
      // Technical details should NOT be visible
      expect(screen.queryByText("Error ID:")).not.toBeInTheDocument();
      expect(screen.queryByText("Production error")).not.toBeInTheDocument();
      expect(screen.queryByText("Technical Details")).not.toBeInTheDocument();
      // Copy button should NOT be visible
      expect(screen.queryByTestId("error-copy")).not.toBeInTheDocument();
    });

    test("should show technical details when showDetails=true (development mode)", () => {
      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault showDetails={true}>
            <ThrowError message="Development error" />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      // Error card should be visible
      expect(screen.getByTestId("error-boundary-card")).toBeInTheDocument();
      // Technical details should be visible
      expect(screen.getByText("Error ID:")).toBeInTheDocument();
      expect(screen.getByText("Development error")).toBeInTheDocument();
      expect(screen.getByText("Technical Details")).toBeInTheDocument();
      // Copy button should be visible
      expect(screen.getByTestId("error-copy")).toBeInTheDocument();
    });
  });

  describe("button actions", () => {
    test("Try Again button should reset error state", () => {
      // Create a controlled error component
      let shouldThrow = true;
      function ConditionalError() {
        if (shouldThrow) {
          throw new Error("Conditional error");
        }
        return <div data-testid="recovered">Recovered!</div>;
      }

      const { rerender } = render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault>
            <ConditionalError />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      // Initial state: error boundary should show
      expect(screen.getByTestId("error-boundary-card")).toBeInTheDocument();

      // Fix the error condition
      shouldThrow = false;

      // Click Try Again
      fireEvent.click(screen.getByTestId("error-try-again"));

      // Re-render should show recovered content
      rerender(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault>
            <ConditionalError />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      expect(screen.getByTestId("recovered")).toBeInTheDocument();
    });
  });

  describe("custom fallback", () => {
    test("should render custom fallback when provided", () => {
      const customFallback = <div data-testid="custom-fallback">Custom Error UI</div>;

      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundaryDefault fallback={customFallback}>
            <ThrowError />
          </ErrorBoundaryDefault>
        </I18nextProvider>,
      );

      // Custom fallback should be rendered
      expect(screen.getByTestId("custom-fallback")).toBeInTheDocument();
      expect(screen.getByText("Custom Error UI")).toBeInTheDocument();
      // Default error card should NOT be rendered
      expect(screen.queryByTestId("error-boundary-card")).not.toBeInTheDocument();
    });
  });

  describe("exports", () => {
    test("should export default TranslatedErrorBoundary", () => {
      expect(ErrorBoundaryDefault).toBeDefined();
    });

    test("should export ErrorBoundary class for type checking", () => {
      expect(ErrorBoundary).toBeDefined();
      expect(ErrorBoundaryClass).toBeDefined();
    });
  });
});
