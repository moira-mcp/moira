/**
 * "Show me around", in the sidebar's footer — so also in the sidebar sheet on a phone. It opens a
 * menu of the guides: this page's tour, the place the reader stopped, and how far they are in each
 * screen's tour. The one-time first-run prompt opens the same menu.
 */

import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { Compass, Play, RotateCcw } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useOptionalSidebar,
} from "@/components/ui/sidebar";
import { GUIDE_PARAM, STEP_PARAM, useGuides, visibleSteps } from "./GuideContext";
import {
  guideFinished,
  guideStarted,
  newSteps,
  stepsForReader,
  useGuideProgress,
} from "./progress";
import { GUIDES, guideById, screenTourForPath } from "./registry";
import type { GuideDefinition } from "./types";

/** How far the reader is in a screen tour, as the menu words it. */
type ScreenStatus =
  { kind: "unseen" } | { kind: "started" } | { kind: "seen" } | { kind: "new"; count: number };

export function ShowMeAround(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { start, ownerOf, menuOpen, setMenuOpen } = useGuides();
  const { loaded, progress } = useGuideProgress();
  const sidebar = useOptionalSidebar();
  const anchorRef = useRef<HTMLDivElement>(null);

  /**
   * The steps the reader is counted against: the ones their page shows them when it is open, else
   * every step for everyone plus the role-only steps they saw.
   */
  const readerSteps = (guide: GuideDefinition) => {
    const owner = ownerOf(guide.screen);
    return owner === undefined ? stepsForReader(guide, progress) : visibleSteps(guide, owner);
  };

  const thisPage = screenTourForPath(pathname);
  const resume = progress?.resume;
  const resumeGuide = resume ? guideById(resume.guide) : undefined;
  const resumeSteps = resumeGuide ? readerSteps(resumeGuide) : [];
  const resumeIndex = resumeSteps.findIndex((step) => step.id === resume?.step);

  const statusOf = (guide: GuideDefinition): ScreenStatus => {
    const fresh = newSteps(guide, readerSteps(guide), progress);
    if (fresh.length > 0) return { kind: "new", count: fresh.length };
    if (guideFinished(guide, progress)) return { kind: "seen" };
    return guideStarted(guide, progress) ? { kind: "started" } : { kind: "unseen" };
  };

  /** Leave the menu, and on a phone the sidebar sheet, so the page and its guide are in view. */
  const leave = () => {
    setMenuOpen(false);
    if (sidebar?.isMobile) sidebar.setOpenMobile(false);
  };

  const openThisPage = (guide: GuideDefinition) => {
    const fresh = newSteps(guide, readerSteps(guide), progress);
    leave();
    start(
      guide.id,
      undefined,
      fresh.map((step) => step.id),
    );
  };

  const openResume = () => {
    if (!resume) return;
    leave();
    const [path, query = ""] = resume.path.split("?");
    const params = new URLSearchParams(query);
    params.set(GUIDE_PARAM, resume.guide);
    params.set(STEP_PARAM, resume.step);
    navigate(`${path}?${params.toString()}`);
  };

  const screens = GUIDES.filter((guide) => guide.kind === "screen");
  const label = t("guides.menu.open");

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          {/* The menu is placed against this element: the sidebar button does not pass a ref on. */}
          <PopoverAnchor asChild>
            <div ref={anchorRef}>
              <SidebarMenuButton
                tooltip={label}
                onClick={() => setMenuOpen(!menuOpen)}
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                data-testid="show-me-around"
                // For tests and tools: the reader's guide progress has been read.
                data-progress={loaded ? "loaded" : "loading"}
              >
                <Compass className="h-4 w-4" aria-hidden="true" />
                <span>{label}</span>
              </SidebarMenuButton>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align="start"
            className="w-72 p-3"
            data-testid="show-me-around-menu"
            // Focus leaving is not a reason to close: on a phone the sidebar sheet takes focus as it
            // opens around the menu. Escape and a press outside still close it.
            onFocusOutside={(event) => event.preventDefault()}
            // The button toggles the menu itself; a press on it is not a press "outside".
            onInteractOutside={(event) => {
              if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
            }}
          >
            <p className="text-sm font-semibold">{t("guides.menu.title")}</p>
            <div className="mt-2 space-y-1">
              {thisPage ? (
                <button
                  type="button"
                  onClick={() => openThisPage(thisPage)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  data-testid="show-me-around-this-page"
                >
                  <Play className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>
                    {t("guides.menu.thisPage", { guide: t(`guides.${thisPage.id}.title`) })}
                  </span>
                </button>
              ) : (
                <p
                  className="px-2 py-1.5 text-sm text-muted-foreground"
                  data-testid="show-me-around-no-tour"
                >
                  {t("guides.menu.noTour")}
                </p>
              )}
              {loaded && resume && resumeGuide && (
                <button
                  type="button"
                  onClick={openResume}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  data-testid="show-me-around-resume"
                >
                  <RotateCcw className="size-4 shrink-0 text-primary" aria-hidden="true" />
                  <span>
                    {t("guides.menu.resume", {
                      guide: t(`guides.${resumeGuide.id}.title`),
                      step: t(`guides.${resumeGuide.id}.steps.${resume.step}.title`),
                      index: resumeIndex >= 0 ? resumeIndex + 1 : 1,
                      total: resumeIndex >= 0 ? resumeSteps.length : resumeGuide.steps.length,
                    })}
                  </span>
                </button>
              )}
            </div>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("guides.menu.screens")}
            </p>
            <ul className="mt-1 space-y-1" data-testid="show-me-around-screens">
              {screens.map((guide) => {
                const status = statusOf(guide);
                return (
                  <li
                    key={guide.id}
                    className="flex items-center justify-between gap-2 px-2 text-sm"
                    data-guide-id={guide.id}
                    data-status={status.kind}
                  >
                    <span>{t(`guides.${guide.id}.title`)}</span>
                    <span
                      className={
                        status.kind === "new"
                          ? "text-xs text-primary"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {status.kind === "new"
                        ? t("guides.menu.status.new", { count: status.count })
                        : t(`guides.menu.status.${status.kind}`)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
