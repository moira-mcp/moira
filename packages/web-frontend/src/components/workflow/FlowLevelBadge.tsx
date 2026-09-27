/**
 * The level a flow was authored at, as a badge of its own — never as one of its tags.
 *
 * The level comes from `splitFlowTags`; a flow without a valid level tag shows no badge.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FlowLevel } from "@/utils/workflow-level";

interface FlowLevelBadgeProps {
  level: FlowLevel | null;
  className?: string;
  testId?: string;
  /** The guide anchor of the badge, for a screen tour that explains it. */
  guide?: { "data-guide": string };
}

export const FlowLevelBadge: React.FC<FlowLevelBadgeProps> = ({
  level,
  className,
  testId = "flow-level-badge",
  guide,
}) => {
  const { t } = useTranslation();
  if (!level) return null;
  const name = t(`components.flowLevel.${level}`);
  const label = t("components.flowLevel.label", { level: name });
  return (
    <TooltipProvider>
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              "h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground",
              className,
            )}
            aria-label={label}
            data-testid={testId}
            data-level={level}
            {...guide}
          >
            <Gauge className="size-3" aria-hidden="true" />
            {name}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default FlowLevelBadge;
