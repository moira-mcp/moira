/**
 * "What is this?" — opens the screen tour of the page it sits on. Pages built on `PageHeader` get
 * it from the header; the flow and run pages, which draw their own headers, render it themselves.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGuides } from "./GuideContext";

export function GuideButton({ guideId }: { guideId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { start } = useGuides();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="gap-1.5 text-primary"
      onClick={() => start(guideId)}
      data-testid="guide-open"
      data-guide-id={guideId}
    >
      <CircleHelp className="size-4" aria-hidden="true" />
      {t("guides.ui.whatIsThis")}
    </Button>
  );
}
