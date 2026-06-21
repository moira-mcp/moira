/**
 * SortSelect — unified sort control combining field and direction.
 * Each menu item represents a field+direction pair (e.g., "Date ↓", "Date ↑").
 * This is the mandatory sort pattern per design system.
 */

import React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface SortOption {
  /** Combined value like "createdAt-desc" */
  value: string;
  /** Display label like "Date ↓" */
  label: string;
}

interface SortSelectProps {
  /** Current combined sort value (e.g., "createdAt-desc") */
  value: string;
  /** Callback when sort changes */
  onChange: (value: string) => void;
  /** Available sort options */
  options: SortOption[];
  /** Optional label displayed above the select */
  label?: string;
  /** Width class (default: w-[200px]) */
  className?: string;
  /** data-testid */
  testId?: string;
}

export const SortSelect: React.FC<SortSelectProps> = ({
  value,
  onChange,
  options,
  label,
  className = "w-[200px]",
  testId,
}) => {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-xs text-muted-foreground font-medium">{label}</span>}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className={className} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

/** Helper to parse combined sort value into field and direction */
export function parseSortValue<F extends string>(
  value: string,
): { field: F; direction: "asc" | "desc" } {
  const lastDash = value.lastIndexOf("-");
  return {
    field: value.substring(0, lastDash) as F,
    direction: value.substring(lastDash + 1) as "asc" | "desc",
  };
}

/** Helper to create combined sort value */
export function makeSortValue(field: string, direction: "asc" | "desc"): string {
  return `${field}-${direction}`;
}
