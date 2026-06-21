/**
 * Admin Execution Inspector Page
 * Thin wrapper that injects admin-specific services into ExecutionInspector
 */

import React from "react";
import { useParams } from "react-router-dom";
import { ExecutionInspector } from "../components/execution/ExecutionInspector";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";

export const AdminExecutionInspectorPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  if (!id) {
    return <div>Execution ID required</div>;
  }

  return (
    <ExecutionInspector
      executionId={id}
      fetchExecution={apiClient.getAdminExecution.bind(apiClient)}
      backRoute={ROUTES.ADMIN_EXECUTIONS}
      showOwnerInfo
    />
  );
};
