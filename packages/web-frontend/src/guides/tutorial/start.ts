/**
 * Where the tutorial "Build your first flow" opens: the example for its first lessons, the reader's
 * copy after. Kept apart from the runner so the guide menu can start the tutorial without loading
 * it.
 */

import { ROUTES } from "../../constants/routes";
import { recommendedFlows } from "../../components/onboarding/recommended";
import { apiClient } from "../../services/api-client";
import { GUIDE_PARAM, STEP_PARAM } from "../GuideContext";
import { changeProgress, dropTutorialCopy, type TutorialProgress } from "../progress";
import { BUILD_FLOW_ID } from "./buildFlow.guide";

/** The example this tutorial's lessons copy and compare against, in the reader's language. */
export function exampleSlug(language: string | undefined): string {
  return recommendedFlows(language).find((flow) => flow.key === "simpleSteps")!.slug;
}

/** The address a lesson opens at: the example for lessons 0–1, the reader's copy after. */
export function lessonAddress(
  lesson: string,
  copyId: string | undefined,
  language: string,
): string {
  const onCopy = copyId && lesson !== "lesson-0";
  const path = onCopy
    ? `${ROUTES.WORKFLOWS}/${copyId}`
    : `${ROUTES.WORKFLOWS}/moira/${exampleSlug(language)}`;
  const query = new URLSearchParams({ [GUIDE_PARAM]: BUILD_FLOW_ID, [STEP_PARAM]: lesson });
  if (onCopy && lesson !== "lesson-1") query.set("edit", "1");
  return `${path}?${query}`;
}

/**
 * The reader's recorded copy while it exists. A copy that is gone (deleted, or no longer readable)
 * is forgotten with the lessons passed on it, so the tutorial makes a new one.
 */
export async function liveCopy(own: TutorialProgress | undefined): Promise<string | null> {
  if (!own?.copyId) return null;
  const exists = await apiClient.getWorkflow(own.copyId).then(
    () => true,
    () => false,
  );
  if (exists) return own.copyId;
  await changeProgress(dropTutorialCopy(BUILD_FLOW_ID)).catch(() => undefined);
  return null;
}

/**
 * Where "Build your first flow" starts or resumes: the reader's copy at its first lesson not passed
 * when the copy still exists, otherwise the example at the first lesson.
 */
export async function tutorialStart(
  own: TutorialProgress | undefined,
  language: string,
): Promise<string> {
  const copyId = await liveCopy(own);
  if (copyId) {
    const next = ["lesson-2", "lesson-3"].find((lesson) => !own?.lessons?.[lesson]) ?? "lesson-3";
    return lessonAddress(next, copyId, language);
  }
  return lessonAddress("lesson-0", undefined, language);
}
