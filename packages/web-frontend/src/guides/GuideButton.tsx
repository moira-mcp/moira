/**
 * "What is this?" — opens the screen tour of the page it sits on. Pages built on `PageHeader` get
 * it from the header; the flow and run pages, which draw their own headers, render it themselves.
 *
 * When steps of a tour the reader has already walked changed since, the button carries a dot and
 * runs only those steps; the last of them offers the whole tour. Nothing opens by itself.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGuides, visibleSteps } from "./GuideContext";
import { newSteps, useGuideProgress } from "./progress";
import { guideById } from "./registry";

export function GuideButton({ guideId }: { guideId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { start, ownerOf } = useGuides();
  const { progress } = useGuideProgress();
  const guide = guideById(guideId);
  const fresh = guide
    ? newSteps(guide, visibleSteps(guide, ownerOf(guide.screen) ?? false), progress).map(
        (step) => step.id,
      )
    : [];
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="relative gap-1.5 text-primary"
      onClick={() => start(guideId, undefined, fresh)}
      data-testid="guide-open"
      data-guide-id={guideId}
      data-new-steps={fresh.length || undefined}
      aria-label={
        fresh.length > 0 ? t("guides.ui.whatIsThisNew", { count: fresh.length }) : undefined
      }
    >
      <CircleHelp className="size-4" aria-hidden="true" />
      {t("guides.ui.whatIsThis")}
      {fresh.length > 0 && (
        <span
          className="absolute right-1 top-1 size-2 rounded-full bg-primary"
          aria-hidden="true"
          data-testid="guide-new-dot"
        />
      )}
    </Button>
  );
}
