/**
 * LabeledFilter — wrapper that adds a label above any filter control.
 * Use this to ensure all filter elements have visible descriptions.
 */

import React from "react";

interface LabeledFilterProps {
  /** Label text displayed above the filter */
  label: string;
  /** The filter control (Select, Input, etc.) */
  children: React.ReactNode;
}

export const LabeledFilter: React.FC<LabeledFilterProps> = ({ label, children }) => {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-medium">{label}</span>
      {children}
    </div>
  );
};
