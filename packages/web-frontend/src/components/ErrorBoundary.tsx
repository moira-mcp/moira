/* eslint-disable no-console */
/**
 * Error Boundary Component
 * Graceful error handling for React application
 *
 * Note: console.* used for browser debugging of React error boundaries
 * Uses withTranslation HOC for i18n support in class component
 */

import React, { Component, ErrorInfo, ReactNode } from "react";
import { withTranslation, WithTranslation } from "react-i18next";
import { AlertTriangle, RotateCcw, RefreshCw, Home, Copy } from "lucide-react";
import { clientLogger } from "../services/client-logger";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./ui/card";
import { Button } from "./ui/button";
import { ROUTES } from "../constants/routes";

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
  errorId: string;
  copyStatus?: "copied" | "fallback";
}

interface ErrorBoundaryOwnProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  showDetails?: boolean;
}

type ErrorBoundaryProps = ErrorBoundaryOwnProps & WithTranslation;

/**
 * Production-ready error boundary with user-friendly error display
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorId: this.generateErrorId(),
    };
  }

  /**
   * Generate unique error ID for tracking
   */
  private generateErrorId(): string {
    return `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Catch React errors and update state
   */
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
      errorId: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    };
  }

  /**
   * Log error and notify parent component
   */
  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Application Error Boundary:", error, errorInfo);

    this.setState({
      error,
      errorInfo,
    });

    // Notify parent component
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Log to external service (if configured)
    this.logError(error, errorInfo);
  }

  /**
   * Log error to backend via /api/logs/client
   */
  private logError(error: Error, errorInfo: ErrorInfo) {
    try {
      // Send to backend logging endpoint
      clientLogger.error(`React ErrorBoundary caught: ${error.message}`, error, {
        errorId: this.state.errorId,
        componentStack: errorInfo.componentStack?.slice(0, 5000),
        type: "react-error-boundary",
      });
    } catch (loggingError) {
      console.error("Failed to log error:", loggingError);
    }
  }

  /**
   * Reset error boundary state
   */
  private resetError = () => {
    this.setState({
      hasError: false,
      errorId: this.generateErrorId(),
    });
  };

  /**
   * Copy error details to clipboard
   */
  private copyErrorDetails = async () => {
    const errorDetails = {
      errorId: this.state.errorId,
      message: this.state.error?.message,
      stack: this.state.error?.stack,
      componentStack: this.state.errorInfo?.componentStack,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      url: window.location.href,
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(errorDetails, null, 2));
      this.setState({ copyStatus: "copied" });
      setTimeout(() => this.setState({ copyStatus: undefined }), 3000);
    } catch (copyError) {
      console.error("Failed to copy error details:", copyError);
      this.setState({ copyStatus: "fallback" });
      setTimeout(() => this.setState({ copyStatus: undefined }), 5000);
    }
  };

  /**
   * Reload application
   */
  private reloadApplication = () => {
    window.location.reload();
  };

  /**
   * Navigate to app home page
   */
  private goHome = () => {
    window.location.href = ROUTES.DASHBOARD;
  };

  /**
   * Render error UI or children
   */
  override render() {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI using shadcn/ui components
      const { t, showDetails } = this.props;
      return (
        <div
          className="flex min-h-screen items-center justify-center bg-background p-4"
          role="alert"
          aria-live="assertive"
        >
          <Card className="w-full max-w-lg" data-testid="error-boundary-card">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-8 w-8 text-destructive" />
              </div>
              <CardTitle className="text-2xl">{t("components.errorBoundary.title")}</CardTitle>
              <CardDescription>{t("components.errorBoundary.subtitle")}</CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Technical details - only in development mode */}
              {showDetails && (
                <div className="space-y-3 rounded-lg border bg-muted/50 p-4 text-sm">
                  <div>
                    <span className="font-medium text-muted-foreground">
                      {t("components.errorBoundary.errorId")}:
                    </span>{" "}
                    <code className="text-xs">{this.state.errorId}</code>
                  </div>

                  {this.state.error && (
                    <div>
                      <span className="font-medium text-muted-foreground">
                        {t("components.errorBoundary.error")}:
                      </span>{" "}
                      <span className="text-destructive">{this.state.error.message}</span>
                    </div>
                  )}

                  {this.state.error?.stack && (
                    <details className="cursor-pointer">
                      <summary className="font-medium text-muted-foreground hover:text-foreground">
                        {t("components.errorBoundary.technicalDetails")}
                      </summary>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {this.state.error.stack}
                      </pre>
                      {this.state.errorInfo?.componentStack && (
                        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {this.state.errorInfo.componentStack}
                        </pre>
                      )}
                    </details>
                  )}
                </div>
              )}

              {/* Help text */}
              <div className="text-sm text-muted-foreground">
                <p className="font-medium">{t("components.errorBoundary.helpTitle")}</p>
                <ul className="mt-2 list-inside list-disc space-y-1">
                  <li>{t("components.errorBoundary.helpRefresh")}</li>
                  <li>{t("components.errorBoundary.helpBackend")}</li>
                  <li>{t("components.errorBoundary.helpReport")}</li>
                </ul>
              </div>
            </CardContent>

            <CardFooter className="flex flex-col gap-3">
              {/* Primary actions row */}
              <div className="flex w-full gap-2">
                <Button className="flex-1" onClick={this.resetError} data-testid="error-try-again">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t("components.errorBoundary.tryAgain")}
                </Button>

                <Button
                  className="flex-1"
                  variant="outline"
                  onClick={this.reloadApplication}
                  data-testid="error-reload"
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("components.errorBoundary.reloadPage")}
                </Button>
              </div>

              {/* Secondary actions row */}
              <div className="flex w-full gap-2">
                <Button
                  className="flex-1"
                  variant="outline"
                  onClick={this.goHome}
                  data-testid="error-go-home"
                >
                  <Home className="mr-2 h-4 w-4" />
                  {t("components.errorBoundary.goHome")}
                </Button>

                {showDetails && (
                  <Button
                    className="flex-1"
                    variant="ghost"
                    onClick={this.copyErrorDetails}
                    data-testid="error-copy"
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    {this.state.copyStatus === "copied"
                      ? t("components.errorBoundary.errorCopied")
                      : this.state.copyStatus === "fallback"
                        ? `Error ID: ${this.state.errorId}`
                        : t("components.errorBoundary.copyErrorDetails")}
                  </Button>
                )}
              </div>
            </CardFooter>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

// Wrap with translation HOC for i18n support
const TranslatedErrorBoundary = withTranslation()(ErrorBoundary);

/**
 * Higher-order component for wrapping components with error boundary
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorFallback?: ReactNode,
) {
  const WrappedComponent = (props: P) => (
    <TranslatedErrorBoundary fallback={errorFallback}>
      <Component {...props} />
    </TranslatedErrorBoundary>
  );

  WrappedComponent.displayName = `withErrorBoundary(${Component.displayName || Component.name})`;

  return WrappedComponent;
}

/**
 * Async error boundary hook for handling Promise rejections
 */
export function useAsyncErrorBoundary() {
  const [, setState] = React.useState();

  return React.useCallback((error: Error) => {
    setState(() => {
      throw error;
    });
  }, []);
}

// Export both the base class (for type checking) and the translated version (for usage)
export { ErrorBoundary as ErrorBoundaryClass };
export default TranslatedErrorBoundary;
