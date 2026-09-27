/**
 * Beta Warning Banner
 * Persistent banner shown after accepting beta agreement
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "./ui/button";

interface BetaWarningBannerProps {
  onDismiss: () => void;
}

export const BetaWarningBanner: React.FC<BetaWarningBannerProps> = ({ onDismiss }) => {
  const { t } = useTranslation();

  return (
    // On a phone the banner is one short line, so it never takes a fifth of the screen from the
    // page; the full notice is shown from the `sm` breakpoint up.
    <div className="bg-warning/10 border-b border-warning/30" data-testid="beta-warning-banner">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 sm:py-3">
        <div className="flex items-center sm:items-start gap-2 sm:gap-3">
          <AlertTriangle className="w-4 h-4 sm:w-5 sm:h-5 text-warning flex-shrink-0 sm:mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs sm:text-sm text-warning-foreground">
              <strong className="font-semibold">{t("components.betaWarningBanner.title")}</strong>{" "}
              <span className="sm:hidden">{t("components.betaWarningBanner.short")}</span>
              <span className="hidden sm:inline">{t("components.betaWarningBanner.message")}</span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            data-testid="beta-warning-dismiss"
            className="flex-shrink-0 h-11 w-11 sm:h-6 sm:w-6 -my-2 sm:my-0 p-0 text-warning hover:bg-warning/20"
            aria-label={t("components.betaWarningBanner.dismiss")}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
