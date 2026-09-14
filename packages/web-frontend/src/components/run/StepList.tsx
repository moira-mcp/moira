/**
 * The steps of a block as a list of step cards (one geometry shared with the split view and the
 * graph): type badge, id or display name, the first sentence of the directive, the evidence the
 * step demands back, and a marker on the step the run is on. Shared by the outline mode and the
 * block-detail panel.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { StepCard, StepCardList } from "./StepCard";
import type { StepInfo } from "./model";

export function StepList({
  steps,
  currentNodeId,
  onFocusNode,
  className,
}: {
  steps: StepInfo[];
  currentNodeId: string | null;
  /** Focus the step on the technical node graph. */
  onFocusNode?: (nodeId: string) => void;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <StepCardList className={className} testId="step-list">
      {steps.map((step) => (
        <StepCard
          key={step.id}
          step={step}
          current={currentNodeId === step.id}
          onSelect={onFocusNode ? () => onFocusNode(step.id) : undefined}
          selectTitle={onFocusNode ? t("pages.runPage.blockDetail.focusStep") : undefined}
        />
      ))}
    </StepCardList>
  );
}
