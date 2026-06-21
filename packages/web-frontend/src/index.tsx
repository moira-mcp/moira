/* eslint-disable no-console */
/**
 * MCP Moira Frontend Entry Point
 * React application initialization and rendering
 *
 * Note: console.error used for application error boundary logging in browser
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { setupGlobalErrorHandlers, clientLogger } from "./services/client-logger";
import "@fontsource-variable/inter";
import "./styles/globals.css";

// Initialize global error handlers for centralized logging
setupGlobalErrorHandlers();

// Initialize React application
const container = document.getElementById("root");
if (!container) {
  throw new Error('Root container not found. Please ensure index.html has a div with id="root"');
}

const root = createRoot(container);

// Professional error handling callback
const handleApplicationError = (error: Error, errorInfo: React.ErrorInfo) => {
  console.error("🚨 Application Error Caught:", {
    message: error.message,
    stack: error.stack,
    componentStack: errorInfo.componentStack,
    timestamp: new Date().toISOString(),
  });

  // Send to backend for centralized logging
  clientLogger.error("React ErrorBoundary caught error", error, {
    type: "ErrorBoundary",
    componentStack: errorInfo.componentStack,
  });
};

// Render application with professional error boundary
root.render(
  <React.StrictMode>
    <ErrorBoundary
      showDetails={process.env.NODE_ENV === "development"}
      onError={handleApplicationError}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
