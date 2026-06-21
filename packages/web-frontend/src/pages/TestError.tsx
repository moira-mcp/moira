/**
 * Test Error Page
 * This component intentionally throws an error to test ErrorBoundary
 * Only available in development mode
 */

import React from "react";

function ThrowError(): React.ReactElement {
  throw new Error("Test error for ErrorBoundary testing");
}

export const TestError: React.FC = () => {
  return <ThrowError />;
};
