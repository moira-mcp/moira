/**
 * What a reader has done with the guides, kept on the server so it follows them to every device:
 * whether they answered the first-run prompt, where they stopped, and which revision of each step
 * they have seen. It is one user setting; this module keeps the in-page copy every entry point
 * reads, on the same store as the beginner panels (`lib/userSettingStore`): a change is seen at once
 * and saved against the stored progress, so tabs and devices never undo each other and fields this
 * build does not know (a later build's) are kept; a refused change is undone and rejected.
 */

import { createUserSettingStore, type SettingChange } from "../lib/userSettingStore";
import type { GuideDefinition, GuideStep } from "./types";

/** The user setting holding the progress (seeded in category `ui`). */
export const GUIDE_PROGRESS_KEY = "ui.guide_progress";

/** Where a reader stopped: the guide, its step, and the page it was open on. */
export interface ResumePoint {
  guide: string;
  step: string;
  /** Path and query of the page, without the guide's own parameters. */
  path: string;
  /**
   * Whether the reader owned what the screen showed, on a screen whose steps differ by it: the
   * resume line counts the steps of that role, wherever the reader is when they read it.
   */
  owner?: boolean;
  /** The reader stopped in the full tour: "Continue" resumes the tour, not only this screen. */
  tour?: boolean;
}

/** A tutorial's place: the reader's copy it works on, and the lessons passed, each at the saved
 * revision its check passed on (and whether "Do it for me" made the change). */
export interface TutorialProgress {
  copyId?: string;
  lessons?: Record<string, { revision: number; forMe?: true }>;
  /** Lessons whose "Do it for me" was used, passed or not: it is offered once per lesson. */
  forMe?: Record<string, true>;
}

export interface GuideProgress {
  /** The one-time prompt's answer; absent until the reader decides. */
  firstRun?: "accepted" | "declined";
  resume?: ResumePoint;
  /** `<guide>.<step>` → the step's revision when the reader last saw it. */
  seen?: Record<string, number>;
  /** Guides the reader walked to their end: a step added to one later is new to them. */
  finished?: Record<string, true>;
  /** Tours offered once (the editor tour, on the first switch into edit mode): offered, whatever the answer. */
  offered?: Record<string, true>;
  /** Tutorials by id: the copy each works on and the lessons passed. */
  tutorials?: Record<string, TutorialProgress>;
  /** Anything a later build stores; kept as it is. */
  [field: string]: unknown;
}

export type ProgressChange = SettingChange<GuideProgress>;

/** The stored value as an object; anything else reads as no progress. */
export function parseProgress(value: unknown): GuideProgress {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const progress = { ...(parsed as GuideProgress) };
  if (progress.firstRun !== "accepted" && progress.firstRun !== "declined") {
    delete progress.firstRun;
  }
  const seen = progress.seen;
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) delete progress.seen;
  const finished = progress.finished;
  if (!finished || typeof finished !== "object" || Array.isArray(finished))
    delete progress.finished;
  const tutorials = progress.tutorials;
  if (!tutorials || typeof tutorials !== "object" || Array.isArray(tutorials)) {
    delete progress.tutorials;
  }
  const offered = progress.offered;
  if (!offered || typeof offered !== "object" || Array.isArray(offered)) delete progress.offered;
  const resume = progress.resume;
  if (
    !resume ||
    typeof resume.guide !== "string" ||
    typeof resume.step !== "string" ||
    typeof resume.path !== "string"
  ) {
    delete progress.resume;
  } else {
    // A field of the wrong type is dropped; the place itself is kept.
    const { owner, tour, ...place } = resume;
    progress.resume = {
      ...place,
      ...(typeof owner === "boolean" ? { owner } : {}),
      ...(typeof tour === "boolean" ? { tour } : {}),
    };
  }
  return progress;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Unreadable progress stays unknown: nothing is marked new, and the prompt waits for a readable
// answer rather than asking someone who may already have answered.
const store = createUserSettingStore<GuideProgress>(GUIDE_PROGRESS_KEY, { parse: parseProgress });

/**
 * Apply a change to the reader's progress. It is seen at once and saved; a refused or failed save
 * is undone and rejects the returned promise.
 */
export function changeProgress(change: ProgressChange): Promise<void> {
  return store.change(change);
}

// ---- The changes ----

const seenKey = (guide: string, step: string) => `${guide}.${step}`;

/**
 * A step was shown: its revision is seen, and — in a walk through the tour, not a run of just its
 * changed steps — it is where the reader is, in the role the page gave them (`owner`, when the
 * page reports one).
 */
export const recordStep =
  (
    guide: string,
    step: GuideStep,
    path: string,
    moveResume = true,
    where: { owner?: boolean; tour?: boolean } = {},
  ): ProgressChange =>
  (progress) => ({
    ...progress,
    seen: {
      ...progress.seen,
      [seenKey(guide, step.id)]: Math.max(
        progress.seen?.[seenKey(guide, step.id)] ?? 0,
        step.revision,
      ),
    },
    ...(moveResume
      ? {
          resume: {
            guide,
            step: step.id,
            path,
            ...(where.owner === undefined ? {} : { owner: where.owner }),
            ...(where.tour ? { tour: true } : {}),
          },
        }
      : {}),
  });

/**
 * The guide was walked to its end: it is finished, and every step it shows this reader counts as
 * seen at its current revision — the ones skipped on the way too (an absent optional step, a
 * wide-only step on a phone) — so only a step added or changed later is new to them. Another role's
 * steps stay unseen. Nothing is left to resume.
 */
export const finishGuide =
  (guide: GuideDefinition, readerSteps: readonly GuideStep[]): ProgressChange =>
  (progress) => {
    const seen = { ...progress.seen };
    // The reader's own steps: another role's are not theirs to have seen.
    for (const step of readerSteps) {
      const key = seenKey(guide.id, step.id);
      seen[key] = Math.max(seen[key] ?? 0, step.revision);
    }
    const { resume, ...rest } = progress;
    const next: GuideProgress = {
      ...rest,
      seen,
      finished: { ...progress.finished, [guide.id]: true },
    };
    return resume && resume.guide !== guide.id ? { ...next, resume } : next;
  };

/** The copy a tutorial works on, once the reader has it. */
export const recordTutorialCopy =
  (tutorial: string, copyId: string): ProgressChange =>
  (progress) => {
    const own = progress.tutorials?.[tutorial] ?? {};
    // A different copy starts the lessons after it over: they were passed on the old one.
    const other = !!own.copyId && own.copyId !== copyId;
    // "Do it for me" starts over with them: its once-per-lesson belongs to the old copy too.
    const kept = other ? { copyId } : { ...own, copyId };
    return {
      ...progress,
      tutorials: {
        ...(progress.tutorials ?? {}),
        [tutorial]: other ? { ...kept, lessons: {} } : kept,
      },
    };
  };

/** The recorded copy is gone: the tutorial starts over from a new copy, its lessons with it. */
export const dropTutorialCopy =
  (tutorial: string): ProgressChange =>
  (progress) => {
    const tutorials = { ...(progress.tutorials ?? {}) };
    delete tutorials[tutorial];
    return { ...progress, tutorials };
  };

/** "Do it for me" was used in a lesson. */
export const markLessonForMe =
  (tutorial: string, lesson: string): ProgressChange =>
  (progress) => {
    const own = progress.tutorials?.[tutorial] ?? {};
    return {
      ...progress,
      tutorials: {
        ...(progress.tutorials ?? {}),
        [tutorial]: { ...own, forMe: { ...(own.forMe ?? {}), [lesson]: true } },
      },
    };
  };

/** A lesson passed on the saved definition at `revision`; `forMe` when "Do it for me" did it. */
export const passLesson =
  (tutorial: string, lesson: string, revision: number, forMe: boolean): ProgressChange =>
  (progress) => {
    const own = progress.tutorials?.[tutorial] ?? {};
    return {
      ...progress,
      tutorials: {
        ...(progress.tutorials ?? {}),
        [tutorial]: {
          ...own,
          lessons: {
            ...(own.lessons ?? {}),
            [lesson]: { revision, ...(forMe ? { forMe: true } : {}) },
          },
        },
      },
    };
  };

/** The tour has been offered: it is not offered again, whether it was taken or not. */
export const markOffered =
  (guide: string): ProgressChange =>
  (progress) => ({ ...progress, offered: { ...(progress.offered ?? {}), [guide]: true } });

export const decideFirstRun =
  (decision: "accepted" | "declined"): ProgressChange =>
  (progress) => ({ ...progress, firstRun: decision });

/** Start guides over: forget what the reader saw of them, and where they stopped in one. */
export const restartGuides =
  (guides: readonly string[]): ProgressChange =>
  (progress) => {
    const restarted = new Set(guides);
    const seen = Object.fromEntries(
      Object.entries(progress.seen ?? {}).filter(([key]) => !restarted.has(key.split(".")[0])),
    );
    const finished = Object.fromEntries(
      Object.entries(progress.finished ?? {}).filter(([guide]) => !restarted.has(guide)),
    );
    const { resume, finished: _all, ...rest } = progress;
    const next: GuideProgress =
      Object.keys(finished).length > 0 ? { ...rest, seen, finished } : { ...rest, seen };
    return resume && !restarted.has(resume.guide) ? { ...next, resume } : next;
  };

/** Forget everything the guides know about the reader, so the first-run prompt comes back. */
export const forgetProgress: ProgressChange = (progress) => {
  const {
    firstRun: _firstRun,
    resume: _resume,
    seen: _seen,
    finished: _finished,
    offered: _offered,
    tutorials: _tutorials,
    ...kept
  } = progress;
  return kept;
};

// ---- Reading ----

/**
 * The steps of a guide that are new to the reader: a step they saw at a revision below its current
 * one, and — in a guide they walked to its end — a step they never saw, which was added since. In a
 * guide not finished, a step not reached yet is simply unseen, as all of a guide is for someone who
 * never opened it.
 */
export function newSteps(
  guide: GuideDefinition,
  steps: readonly GuideStep[],
  progress: GuideProgress | null,
): GuideStep[] {
  const seen = progress?.seen ?? {};
  const finished = progress?.finished?.[guide.id] === true;
  return steps.filter((step) => {
    const at = seen[seenKey(guide.id, step.id)];
    return at === undefined ? finished : at < step.revision;
  });
}

/** Whether the reader has seen any step of the guide. */
export function guideStarted(guide: GuideDefinition, progress: GuideProgress | null): boolean {
  const seen = progress?.seen ?? {};
  return guide.steps.some((step) => seenKey(guide.id, step.id) in seen);
}

/** Whether the reader walked the guide to its end. */
export function guideFinished(guide: GuideDefinition, progress: GuideProgress | null): boolean {
  return progress?.finished?.[guide.id] === true;
}

/** Whether the reader has any guide progress at all: an answer, a place to resume, a step seen. */
export function hasAnyProgress(progress: GuideProgress | null): boolean {
  return (
    !!progress &&
    (progress.firstRun !== undefined ||
      progress.resume !== undefined ||
      Object.keys(progress.seen ?? {}).length > 0 ||
      Object.keys(progress.finished ?? {}).length > 0)
  );
}

/**
 * The steps of a guide the reader is counted against, away from the page that knows who they are:
 * every step for everyone, and of the role-only steps the ones of the role they were shown — known
 * once they saw one. Before that they are counted as the page counts someone it does not know to
 * own what it shows: as a reader.
 */
export function stepsForReader(
  guide: GuideDefinition,
  progress: GuideProgress | null,
): GuideStep[] {
  const seen = progress?.seen ?? {};
  const roleKnown = guide.steps.some(
    (step) => step.roles && step.roles !== "any" && seenKey(guide.id, step.id) in seen,
  );
  return guide.steps.filter((step) => {
    if (!step.roles || step.roles === "any") return true;
    return roleKnown ? seenKey(guide.id, step.id) in seen : step.roles === "reader";
  });
}

/** The reader's progress as this page knows it; `loaded` is false until it is read. */
export function useGuideProgress(): { loaded: boolean; progress: GuideProgress | null } {
  const { loaded, value } = store.useValue();
  return { loaded, progress: value };
}

/** Forget the in-page copy; for tests that sign in as another user. */
export function resetGuideProgress(): void {
  store.reset();
}
