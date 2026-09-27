/**
 * The editor tour's one-time offer: the first time the owner switches a flow into edit mode, a
 * small card above the edit bar offers the tour. It is recorded as offered as soon as it shows, so
 * the next switch — this session or any other — offers nothing, whatever the answer; the tour
 * itself stays available to open again from its guide.
 */

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EDITOR_GUIDE_ID, flowEditorGuide } from "../pages/flowEditor.guide";
import { useGuides } from "./GuideContext";
import { changeProgress, guideStarted, markOffered, useGuideProgress } from "./progress";

export function EditorTourOffer({ editing }: { editing: boolean }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { start, guide } = useGuides();
  const { loaded, progress } = useGuideProgress();
  const [state, setState] = useState<"waiting" | "shown" | "closed">("waiting");
  // Not while another guide or a tutorial is open: one teacher at a time, and the offer stays due.
  const due =
    editing &&
    !guide &&
    loaded &&
    progress !== null &&
    !progress.offered?.[EDITOR_GUIDE_ID] &&
    !guideStarted(flowEditorGuide, progress);

  useEffect(() => {
    if (state === "waiting" && due) {
      setState("shown");
      changeProgress(markOffered(EDITOR_GUIDE_ID)).catch(() =>
        toast.error(t("guides.ui.saveFailed")),
      );
    }
    // Leaving edit mode ends the offer: it is not shown again on the next switch.
    if (state === "shown" && !editing) setState("closed");
  }, [due, editing, state, t]);

  if (state !== "shown") return null;
  return (
    <section
      className="flex flex-wrap items-center gap-3 border-b border-primary/30 bg-primary/5 px-3 py-2"
      aria-labelledby="editor-tour-offer-title"
      data-testid="editor-tour-offer"
    >
      <Compass className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 id="editor-tour-offer-title" className="text-sm font-medium">
          {t("guides.editorOffer.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("guides.editorOffer.body")}</p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            setState("closed");
            start(EDITOR_GUIDE_ID);
          }}
          data-testid="editor-tour-accept"
        >
          {t("guides.editorOffer.accept")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setState("closed")}
          data-testid="editor-tour-decline"
        >
          {t("guides.editorOffer.decline")}
        </Button>
      </div>
    </section>
  );
}
