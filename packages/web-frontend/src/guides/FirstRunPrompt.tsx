/**
 * The one-time question on the home page: would the reader like to be shown around? It is asked of
 * a reader with no guide progress at all, once the layout has nothing more urgent to ask (the beta
 * agreement, where it applies). It sits in the page rather than over it and asks once: "No thanks"
 * is kept on the server, "Later" for this browser session (a session cookie, shared by every tab).
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { useGuides } from "./GuideContext";
import { changeProgress, decideFirstRun, hasAnyProgress, useGuideProgress } from "./progress";

/**
 * "Later" holds for this browser session: a cookie without an expiry, which every tab shares and the
 * browser drops when it closes. The next session asks again.
 */
const LATER_COOKIE = "moira-guides-later";

function laterThisSession(): boolean {
  return document.cookie.split(";").some((part) => part.trim() === `${LATER_COOKIE}=1`);
}

/** Clear this session's "Later", so a reader who asked to forget is asked again at once. */
export function forgetFirstRunLater(): void {
  document.cookie = `${LATER_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function FirstRunPrompt(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { promptReady, setMenuOpen } = useGuides();
  const { loaded, progress } = useGuideProgress();
  const sidebar = useOptionalSidebar();
  const [later, setLater] = useState(laterThisSession);

  if (!promptReady || !loaded || hasAnyProgress(progress) || later) return null;

  const decide = (decision: "accepted" | "declined") =>
    changeProgress(decideFirstRun(decision)).catch(() => toast.error(t("guides.ui.saveFailed")));

  const showMeAround = () => {
    void decide("accepted");
    // The menu lives in the sidebar; on a phone that is a sheet to open first.
    if (sidebar?.isMobile) sidebar.setOpenMobile(true);
    setMenuOpen(true);
  };

  const askLater = () => {
    document.cookie = `${LATER_COOKIE}=1; path=/; samesite=lax`;
    setLater(true);
  };

  return (
    <section
      className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
      aria-labelledby="first-run-title"
      data-testid="first-run-prompt"
    >
      <Compass className="size-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 id="first-run-title" className="text-sm font-semibold">
          {t("guides.firstRun.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("guides.firstRun.body")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={showMeAround} data-testid="first-run-accept">
          {t("guides.firstRun.accept")}
        </Button>
        <Button size="sm" variant="outline" onClick={askLater} data-testid="first-run-later">
          {t("guides.firstRun.later")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void decide("declined")}
          data-testid="first-run-decline"
        >
          {t("guides.firstRun.decline")}
        </Button>
      </div>
    </section>
  );
}
