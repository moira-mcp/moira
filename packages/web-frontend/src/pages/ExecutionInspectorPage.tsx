/**
 * Execution Inspector Page (User View)
 * Thin wrapper that injects user-specific services into ExecutionInspector
 */

import React from "react";
import { useParams } from "react-router-dom";
import { ExecutionInspector } from "../components/execution/ExecutionInspector";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";

export const ExecutionInspectorPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  if (!id) {
    return <div>Execution ID required</div>;
  }

  return (
    <ExecutionInspector
      executionId={id}
      fetchExecution={apiClient.getExecution.bind(apiClient)}
      editable
      backRoute={ROUTES.EXECUTIONS}
    />
  );
};
