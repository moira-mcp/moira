/**
 * The one control every beginner panel carries: hide this panel for good. The panel disappears at
 * once, a notice offers to bring it back, and Settings can show it again later.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { setPanelHidden, type BeginnerPanel } from "./beginnerPanels";

/** Hide a panel for the account and offer to undo it; a failed save is reported. */
export function hidePanelWithUndo(panel: BeginnerPanel, t: TFunction): void {
  const name = t(`onboarding.panels.names.${panel}`);
  setPanelHidden(panel, true).then(
    () =>
      toast(t("onboarding.panels.hidden", { name }), {
        description: t("onboarding.panels.hiddenHint"),
        action: {
          label: t("onboarding.panels.undo"),
          onClick: () => {
            setPanelHidden(panel, false).catch(() => toast.error(t("onboarding.panels.failed")));
          },
        },
      }),
    () => toast.error(t("onboarding.panels.failed")),
  );
}

export function HidePanelButton({
  panel,
  className,
}: {
  panel: BeginnerPanel;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const name = t(`onboarding.panels.names.${panel}`);
  const hide = () => hidePanelWithUndo(panel, t);
  return (
    <button
      type="button"
      onClick={hide}
      aria-label={t("onboarding.panels.hideLabel", { name })}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      data-testid="hide-panel"
      data-panel={panel}
    >
      <EyeOff className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">{t("onboarding.panels.hide")}</span>
    </button>
  );
}
