/**
 * One control for "who can see this", whatever the resource is.
 *
 * Access is decided centrally on the server for workflows, executions, notes, artifacts and
 * playbooks alike, so the control that shows and changes it reads the same everywhere instead of
 * each page inventing its own switch and its own wording. Only the owner may publish: making text
 * visible to everyone is sharing it, not handing over control of it.
 *
 * With `onChange` it is a button that flips the state; without it, a badge that only states it.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Globe, Lock } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";

export type ResourceVisibility = "private" | "public";

interface VisibilityToggleProps {
  visibility: ResourceVisibility;
  /** Absent for a reader: they see the state and cannot change it. */
  onChange?: (next: ResourceVisibility) => void;
  disabled?: boolean;
  size?: "sm" | "default";
  testId?: string;
}

export const VisibilityToggle: React.FC<VisibilityToggleProps> = ({
  visibility,
  onChange,
  disabled,
  size = "sm",
  testId = "visibility-toggle",
}) => {
  const { t } = useTranslation();
  const isPublic = visibility === "public";
  const label = isPublic ? t("access.public") : t("access.private");
  const Icon = isPublic ? Globe : Lock;

  if (!onChange) {
    return (
      <Badge
        variant={isPublic ? "default" : "secondary"}
        className="gap-1"
        data-testid={testId}
        data-visibility={visibility}
      >
        <Icon className="w-3 h-3" />
        {label}
      </Badge>
    );
  }

  return (
    <Button
      variant="outline"
      size={size}
      className="gap-1.5"
      disabled={disabled}
      onClick={() => onChange(isPublic ? "private" : "public")}
      data-hint={t("access.toggleHint")}
      data-testid={testId}
      data-visibility={visibility}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </Button>
  );
};
