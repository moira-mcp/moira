/**
 * The full tour's closing card: once the last screen's tour is walked, it offers the tutorial that
 * builds a small flow by hand. Non-modal; it goes away on either answer.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGuideProgress } from "./progress";
import { BUILD_FLOW_ID } from "./tutorial/buildFlow.guide";
import { tutorialStart } from "./tutorial/start";

export function TourClosingOffer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { progress } = useGuideProgress();
  const start = async () => {
    onClose();
    navigate(await tutorialStart(progress?.tutorials?.[BUILD_FLOW_ID], i18n.language));
  };
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="tour-closing-title"
      className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-popover p-4 shadow-lg"
      data-testid="tour-closing-offer"
    >
      <div className="flex items-start gap-2">
        <GraduationCap className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <h2 id="tour-closing-title" className="text-sm font-semibold">
            {t("guides.tourEnd.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("guides.tourEnd.body")}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onClose}>
          {t("guides.tourEnd.later")}
        </Button>
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={() => void start()}
          data-testid="tour-closing-start"
        >
          {t("guides.tourEnd.start")}
        </Button>
      </div>
    </section>
  );
}
