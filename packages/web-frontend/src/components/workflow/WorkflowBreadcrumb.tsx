/**
 * Workflow Breadcrumb Component
 * Displays navigation history for workflow traversal
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Home, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface WorkflowBreadcrumb {
  workflowId: string;
  workflowName: string;
}

interface WorkflowBreadcrumbProps {
  breadcrumbs: WorkflowBreadcrumb[];
  onNavigate: (workflowId: string) => void;
  onClear: () => void;
}

const WorkflowBreadcrumbComponent: React.FC<WorkflowBreadcrumbProps> = ({
  breadcrumbs,
  onNavigate,
  onClear,
}) => {
  const { t } = useTranslation();

  if (breadcrumbs.length === 0) {
    return null;
  }

  return (
    <div className="px-2 py-2 border-b border-border bg-card">
      <div className="flex items-center gap-1 text-sm">
        <Button variant="ghost" size="sm" onClick={onClear} className="gap-1 h-7 px-2">
          <Home className="w-4 h-4" />
          <span>{t("layout.nav.workflows")}</span>
        </Button>

        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={crumb.workflowId}>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
            {index === breadcrumbs.length - 1 ? (
              <span className="px-2 py-1 font-semibold text-foreground text-sm">
                {crumb.workflowName}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate(crumb.workflowId)}
                className="h-7 px-2"
              >
                {crumb.workflowName}
              </Button>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

export default WorkflowBreadcrumbComponent;
