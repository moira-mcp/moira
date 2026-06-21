/* eslint-disable no-console */
/**
 * Error Handler Utilities
 * Centralized error handling and user feedback
 *
 * Note: console.error used for browser debugging of handled errors
 */

import React from "react";
import { ApiClientError, ApiErrorUtils } from "../services/api-client";

/**
 * Error severity levels
 */
export type ErrorSeverity = "low" | "medium" | "high" | "critical";

/**
 * Error category types
 */
export type ErrorCategory =
  | "network"
  | "validation"
  | "permission"
  | "not-found"
  | "server"
  | "client"
  | "unknown";

/**
 * Enhanced error information
 */
export interface EnhancedError {
  id: string;
  message: string;
  userMessage: string;
  severity: ErrorSeverity;
  category: ErrorCategory;
  code?: string;
  details?: Record<string, unknown>;
  timestamp: number;
  recoverable: boolean;
  suggestions: string[];
}

/**
 * Error handler utility class
 */
export class ErrorHandler {
  /**
   * Process error into enhanced error information
   */
  static processError(error: unknown, context?: string): EnhancedError {
    const errorId = this.generateErrorId();
    const timestamp = Date.now();

    if (error instanceof ApiClientError) {
      return this.processApiError(error, errorId, timestamp, context);
    }

    if (error instanceof Error) {
      return this.processGenericError(error, errorId, timestamp, context);
    }

    return this.processUnknownError(error, errorId, timestamp, context);
  }

  /**
   * Process API client errors
   */
  private static processApiError(
    error: ApiClientError,
    errorId: string,
    timestamp: number,
    context?: string,
  ): EnhancedError {
    const userMessage = ApiErrorUtils.getUserFriendlyMessage(error);
    const severity = this.mapApiErrorSeverity(error);
    const category = this.mapApiErrorCategory(error);
    const suggestions = this.getApiErrorSuggestions(error);

    return {
      id: errorId,
      message: error.message,
      userMessage,
      severity,
      category,
      code: error.code,
      details: {
        status: error.status,
        context,
        ...error.details,
      },
      timestamp,
      recoverable: this.isRecoverable(error),
      suggestions,
    };
  }

  /**
   * Process generic JavaScript errors
   */
  private static processGenericError(
    error: Error,
    errorId: string,
    timestamp: number,
    context?: string,
  ): EnhancedError {
    let category: ErrorCategory = "unknown";
    let severity: ErrorSeverity = "medium";
    let suggestions: string[] = [];

    // Categorize common error types
    if (error.name === "TypeError") {
      category = "client";
      suggestions = ["Check component props and data types", "Verify API response structure"];
    } else if (error.name === "ReferenceError") {
      category = "client";
      severity = "high";
      suggestions = ["Check variable definitions", "Verify import statements"];
    } else if (error.message.includes("fetch")) {
      category = "network";
      suggestions = ["Check network connection", "Verify backend server is running"];
    }

    return {
      id: errorId,
      message: error.message,
      userMessage: this.getGenericUserMessage(error),
      severity,
      category,
      details: {
        name: error.name,
        stack: error.stack,
        context,
      },
      timestamp,
      recoverable: category !== "client",
      suggestions,
    };
  }

  /**
   * Process unknown error types
   */
  private static processUnknownError(
    error: unknown,
    errorId: string,
    timestamp: number,
    context?: string,
  ): EnhancedError {
    return {
      id: errorId,
      message: String(error),
      userMessage: "An unexpected error occurred",
      severity: "medium",
      category: "unknown",
      details: {
        originalError: error,
        context,
      },
      timestamp,
      recoverable: true,
      suggestions: [
        "Try refreshing the page",
        "Check browser console for details",
        "Contact support if the issue persists",
      ],
    };
  }

  /**
   * Map API error to severity level
   */
  private static mapApiErrorSeverity(error: ApiClientError): ErrorSeverity {
    switch (error.code) {
      case "WORKFLOW_NOT_FOUND":
      case "FOLDER_NOT_FOUND":
        return "low";
      case "VALIDATION_FAILED":
      case "INVALID_FORMAT":
        return "medium";
      case "FILE_READ_ERROR":
      case "INTERNAL_ERROR":
        return "high";
      default:
        return "medium";
    }
  }

  /**
   * Map API error to category
   */
  private static mapApiErrorCategory(error: ApiClientError): ErrorCategory {
    switch (error.code) {
      case "WORKFLOW_NOT_FOUND":
      case "FOLDER_NOT_FOUND":
        return "not-found";
      case "VALIDATION_FAILED":
      case "INVALID_FORMAT":
        return "validation";
      case "FILE_READ_ERROR":
        return "permission";
      case "INTERNAL_ERROR":
        return "server";
      default:
        return "unknown";
    }
  }

  /**
   * Get suggestions for API errors
   */
  private static getApiErrorSuggestions(error: ApiClientError): string[] {
    switch (error.code) {
      case "WORKFLOW_NOT_FOUND":
        return [
          "Check the workflow name and folder",
          "Verify the workflow file exists",
          "Try refreshing the workflow list",
        ];
      case "FOLDER_NOT_FOUND":
        return [
          "Check the folder name",
          "Verify the folder exists in workflow directories",
          "Contact administrator if folders are missing",
        ];
      case "VALIDATION_FAILED":
        return [
          "Check workflow JSON structure",
          "Verify all required fields are present",
          "Use a JSON validator to check syntax",
        ];
      case "FILE_READ_ERROR":
        return [
          "Check file permissions",
          "Verify the backend has access to workflow files",
          "Contact administrator for file system issues",
        ];
      case "INTERNAL_ERROR":
        return [
          "Try the operation again",
          "Check backend server logs",
          "Contact support if the issue persists",
        ];
      default:
        return ["Try the operation again", "Check network connection", "Contact support if needed"];
    }
  }

  /**
   * Check if error is recoverable
   */
  private static isRecoverable(error: ApiClientError): boolean {
    switch (error.code) {
      case "WORKFLOW_NOT_FOUND":
      case "FOLDER_NOT_FOUND":
      case "VALIDATION_FAILED":
        return true; // User can select different workflow
      case "FILE_READ_ERROR":
      case "INTERNAL_ERROR":
        return false; // Requires system-level resolution
      default:
        return true;
    }
  }

  /**
   * Get user-friendly message for generic errors
   */
  private static getGenericUserMessage(error: Error): string {
    if (error.name === "TypeError") {
      return "A data processing error occurred. Please try again.";
    }
    if (error.name === "ReferenceError") {
      return "An application error occurred. Please refresh the page.";
    }
    if (error.message.includes("fetch")) {
      return "Unable to connect to the server. Please check your connection.";
    }

    return "An unexpected error occurred. Please try again.";
  }

  /**
   * Generate unique error ID
   */
  private static generateErrorId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return `err_${timestamp}_${random}`;
  }

  /**
   * Format error for logging
   */
  static formatErrorForLogging(enhancedError: EnhancedError): string {
    return JSON.stringify(
      {
        id: enhancedError.id,
        message: enhancedError.message,
        severity: enhancedError.severity,
        category: enhancedError.category,
        code: enhancedError.code,
        timestamp: new Date(enhancedError.timestamp).toISOString(),
        recoverable: enhancedError.recoverable,
        details: enhancedError.details,
      },
      null,
      2,
    );
  }

  /**
   * Create user notification from error
   */
  static createNotification(enhancedError: EnhancedError): {
    type: "success" | "warning" | "error" | "info";
    title: string;
    message: string;
    actions?: Array<{ label: string; action: () => void }>;
  } {
    const type = enhancedError.severity === "low" ? "warning" : "error";

    return {
      type,
      title: this.getNotificationTitle(enhancedError),
      message: enhancedError.userMessage,
      actions: enhancedError.recoverable
        ? [
            {
              label: "Try Again",
              action: () => window.location.reload(),
            },
          ]
        : undefined,
    };
  }

  /**
   * Get notification title based on error
   */
  private static getNotificationTitle(error: EnhancedError): string {
    switch (error.category) {
      case "network":
        return "Connection Error";
      case "validation":
        return "Validation Error";
      case "permission":
        return "Permission Error";
      case "not-found":
        return "Not Found";
      case "server":
        return "Server Error";
      case "client":
        return "Application Error";
      default:
        return "Error";
    }
  }
}

/**
 * Error context provider for global error handling
 */
export interface ErrorContextValue {
  errors: EnhancedError[];
  addError: (error: unknown, context?: string) => void;
  removeError: (errorId: string) => void;
  clearErrors: () => void;
}

export const ErrorContext = React.createContext<ErrorContextValue | null>(null);

/**
 * Error context hook
 */
export function useErrorHandler() {
  const context = React.useContext(ErrorContext);

  if (!context) {
    throw new Error("useErrorHandler must be used within ErrorProvider");
  }

  return context;
}

/**
 * Error provider component
 */
interface ErrorProviderProps {
  children: React.ReactNode;
  maxErrors?: number;
}

export const ErrorProvider: React.FC<ErrorProviderProps> = ({ children, maxErrors = 10 }) => {
  const [errors, setErrors] = React.useState<EnhancedError[]>([]);

  const addError = React.useCallback(
    (error: unknown, context?: string) => {
      const enhancedError = ErrorHandler.processError(error, context);

      setErrors((prev) => {
        const newErrors = [enhancedError, ...prev];
        return newErrors.slice(0, maxErrors);
      });

      // Log error
      console.error("Error handled:", ErrorHandler.formatErrorForLogging(enhancedError));
    },
    [maxErrors],
  );

  const removeError = React.useCallback((errorId: string) => {
    setErrors((prev) => prev.filter((error) => error.id !== errorId));
  }, []);

  const clearErrors = React.useCallback(() => {
    setErrors([]);
  }, []);

  const contextValue: ErrorContextValue = {
    errors,
    addError,
    removeError,
    clearErrors,
  };

  return <ErrorContext.Provider value={contextValue}>{children}</ErrorContext.Provider>;
};

export default ErrorHandler;
