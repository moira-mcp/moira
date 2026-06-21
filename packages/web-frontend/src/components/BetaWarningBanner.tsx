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
    <div className="bg-warning/10 border-b border-warning/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-warning-foreground">
              <strong className="font-semibold">{t("components.betaWarningBanner.title")}</strong>{" "}
              {t("components.betaWarningBanner.message")}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className="flex-shrink-0 h-6 w-6 p-0 text-warning hover:bg-warning/20"
            aria-label={t("components.betaWarningBanner.dismiss")}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};
