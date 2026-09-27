/**
 * The runner of a tutorial: a lesson card docked beside the flow page's diagram, working on the
 * page's editor through its tutorial surface. Each building lesson is checked on the draft after
 * every change — the findings show in the card and on the definition — and completes only when its
 * check passes on the saved definition, whose revision is recorded. A save refused because the flow
 * changed elsewhere is explained with a reload; an earlier lesson that no longer holds is named with
 * a way back. On a narrow screen, where editing is not available, the card says so and keeps the
 * reader's progress.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { GraduationCap, X } from "lucide-react";
import {
  checkChoice,
  checkConnected,
  checkNewStep,
  checkOwnCopy,
  checkReference,
  lessonStepId,
  type LessonResult,
} from "@mcp-moira/workflow-engine/authoring";
import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ROUTES } from "../../constants/routes";
import { apiClient } from "../../services/api-client";
import type { WorkflowGraph, WorkflowNode } from "../../types/workflow-types";
import { useGuides, type TutorialSurface } from "../GuideContext";
import {
  changeProgress,
  dropTutorialCopy,
  markLessonForMe,
  passLesson,
  recordTutorialCopy,
  useGuideProgress,
} from "../progress";
import { BUILD_FLOW_ID } from "./buildFlow.guide";
import { exampleSlug, lessonAddress, liveCopy } from "./start";
import { useResultAnnouncement } from "./announce";

/** The width below which the flow page does not offer editing (Tailwind's `md`). */
const WIDE_QUERY = "(min-width: 768px)";
const DO_BLOCK = "work";
/** The reference lesson 5 teaches; passed into the copy as a value so i18next leaves it as written. */
const LESSON_REFERENCE = "{{understand-task.task}}";
/** The block each building lesson works in; the editor opens on it. */
const LESSON_BLOCK: Record<string, string> = {
  "lesson-2": DO_BLOCK,
  "lesson-3": DO_BLOCK,
  "lesson-4": "check",
  "lesson-5": "report",
};

type Engine = Parameters<typeof checkNewStep>[0];
const engine = (graph: WorkflowGraph) => graph as unknown as Engine;

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

function freeId(draft: WorkflowGraph, base: string): string {
  let id = base;
  for (let n = 2; draft.nodes.some((node) => node.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

/** A lesson's check on a definition; null for a lesson without one. */
function check(
  lesson: string,
  graph: WorkflowGraph,
  example: WorkflowGraph,
  surface: TutorialSurface,
  issues: readonly { code: string; nodeId?: string; edge?: string }[],
  validationErrors = 0,
): LessonResult | null {
  switch (lesson) {
    case "lesson-1":
      return checkOwnCopy(engine(graph), engine(example), {
        visibility: surface.visibility,
        ownedByReader: surface.owner,
      });
    case "lesson-2":
      return checkNewStep(engine(graph), engine(example));
    case "lesson-3":
      return checkConnected(engine(graph), engine(example), issues);
    case "lesson-4":
      return checkChoice(engine(graph), issues);
    case "lesson-5":
      return checkReference(engine(graph), validationErrors);
    default:
      return null;
  }
}

const savedIssues = (graph: WorkflowGraph) =>
  deriveProcess(graph as unknown as Parameters<typeof deriveProcess>[0])?.diagnostics ?? [];

export default function TutorialRunner(): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { guide, steps, stepId, controller, go, close, announce } = useGuides();
  const { progress } = useGuideProgress();
  const wide = useWide();
  const surface = controller?.tutorial;
  const own = progress?.tutorials?.[BUILD_FLOW_ID];
  const lesson = stepId ?? "lesson-0";
  const index = Math.max(
    0,
    steps.findIndex((step) => step.id === lesson),
  );
  const [example, setExample] = useState<WorkflowGraph | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = exampleSlug(i18n.language);

  useEffect(() => {
    let live = true;
    apiClient.getWorkflow(`moira/${slug}`).then(
      (detail) => live && setExample(detail.workflow as unknown as WorkflowGraph),
      () => live && setExample(null),
    );
    return () => {
      live = false;
    };
  }, [slug]);

  // The reader's copy is shown: they own it, and it is the recorded copy or the one lesson 1 made.
  const onCopy =
    !!surface && surface.owner && (own?.copyId === surface.flowId || lesson === "lesson-1");
  const onExample = !!surface && !surface.owner;

  const live = useMemo(
    () =>
      surface && example && onCopy
        ? check(
            lesson,
            surface.draft,
            example,
            surface,
            surface.diagnostics,
            surface.validationErrors,
          )
        : null,
    [surface, example, onCopy, lesson],
  );
  const saved = useMemo(
    () =>
      surface && example && onCopy
        ? check(lesson, surface.saved, example, surface, savedIssues(surface.saved))
        : null,
    [surface, example, onCopy, lesson],
  );
  const record = own?.lessons?.[lesson];
  // Lesson 6 is passed by a run of the copy, found through the API; lessons 0 and 7 only explain.
  const [runFound, setRunFound] = useState(false);
  const completed =
    lesson === "lesson-0" ||
    lesson === "lesson-7" ||
    (lesson === "lesson-6" && (runFound || !!record)) ||
    (!!saved?.passed && !surface?.dirty && !!record && record.revision === surface?.revision);

  // An earlier building lesson that no longer holds on the draft. Lesson 1 is not among them: its
  // check compares the untouched copy with the example, which every later lesson changes.
  const broken = useMemo(() => {
    if (!surface || !example || !onCopy) return null;
    for (const earlier of steps.slice(2, index)) {
      const result = check(earlier.id, surface.draft, example, surface, surface.diagnostics);
      if (result && !result.passed) return earlier.id;
    }
    return null;
  }, [surface, example, onCopy, steps, index]);

  // A passing check on the saved definition completes the lesson at that revision.
  useEffect(() => {
    if (!surface || !saved?.passed || surface.dirty || surface.conflict || broken) return;
    if (record?.revision === surface.revision) return;
    const change =
      lesson === "lesson-1"
        ? (p: Parameters<ReturnType<typeof passLesson>>[0]) =>
            passLesson(
              BUILD_FLOW_ID,
              lesson,
              surface.revision,
              !!own?.forMe?.[lesson],
            )(recordTutorialCopy(BUILD_FLOW_ID, surface.flowId)(p))
        : passLesson(BUILD_FLOW_ID, lesson, surface.revision, !!own?.forMe?.[lesson]);
    changeProgress(change).catch(() => toast.error(t("guides.ui.saveFailed")));
  }, [surface, saved, record, lesson, own, broken, t]);

  // The lesson's findings on the draft show on the definition too.
  const findings = useMemo(
    () =>
      (live?.findings ?? []).map((finding) => ({
        ...finding,
        message: t(`guides.build-flow.findings.${finding.code}`, {
          ref: LESSON_REFERENCE,
          ...(finding.data ?? {}),
          node: finding.nodeId ?? "",
        }),
      })),
    [live, t],
  );
  const showFindings = surface?.showFindings;
  // Handed to the page only when they change: the page re-renders on every hand-over, and the
  // surface it gives back is a new object each time.
  const findingsKey = JSON.stringify(findings);
  useEffect(() => {
    showFindings?.(JSON.parse(findingsKey));
  }, [showFindings, findingsKey]);
  useEffect(() => () => showFindings?.([]), [showFindings]);

  // One announcement per distinct result: what changed, not every render.
  const status = !wide
    ? "narrow"
    : surface?.conflict
      ? "conflict"
      : broken
        ? "broken"
        : completed
          ? "complete"
          : live?.passed
            ? "save"
            : live
              ? "findings"
              : "instruction";
  useResultAnnouncement(
    `${lesson}:${status}:${findings.map((f) => f.code).join(",")}`,
    status === "instruction"
      ? null
      : status === "findings"
        ? t("guides.tutorial.announce.findings", { count: findings.length })
        : status === "save" && lesson === "lesson-1"
          ? t("guides.tutorial.checking")
          : t(`guides.tutorial.announce.${status}`),
    announce,
  );

  // Lesson 6: a completed run of the copy that answered the new step. Never assumed: looked up.
  const lookForRun = useCallback(async () => {
    if (!surface || !example) return;
    const stepId = lessonStepId(engine(surface.saved), engine(example));
    if (!stepId) return;
    const { executions } = await apiClient
      .getExecutions({ workflowId: surface.flowId, status: ["completed"], mine: true, limit: 20 })
      .catch(() => ({ executions: [] as { executionId: string }[] }));
    for (const run of executions) {
      const detail = await apiClient.getExecution(run.executionId).catch(() => null);
      if (detail && detail.context.variables[stepId] !== undefined) {
        setRunFound(true);
        await changeProgress(passLesson(BUILD_FLOW_ID, "lesson-6", surface.revision, false)).catch(
          () => undefined,
        );
        return;
      }
    }
  }, [surface, example]);
  useEffect(() => {
    if (lesson === "lesson-6" && onCopy && !record) void lookForRun();
    // Looked up when the lesson opens; "Check again" looks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson, onCopy]);

  // A building lesson on the copy opens the editor on the Do block once, after the lesson's address
  // is committed: a change made in the same moment as the move could be lost to it.
  const opened = useRef<string | null>(null);
  const openForEditing = surface?.openForEditing;
  useEffect(() => {
    const block = LESSON_BLOCK[lesson];
    if (!openForEditing || !onCopy || !block) return;
    if (opened.current === lesson) return;
    opened.current = lesson;
    openForEditing(block);
  }, [openForEditing, onCopy, lesson]);

  // The control the lesson starts from, outlined without covering the page.
  const [ring, setRing] = useState<DOMRect | null>(null);
  const anchor = steps[index]?.anchor;
  useEffect(() => {
    if (typeof anchor !== "string") return;
    const timer = window.setInterval(() => {
      const element = document.querySelector(`[data-guide~="${anchor}"]`);
      setRing(element ? element.getBoundingClientRect() : null);
    }, 300);
    return () => window.clearInterval(timer);
  }, [anchor]);

  if (!guide) return null;

  const doItForMe = async () => {
    if (!surface || !example) return;
    // Once per lesson, remembered across reloads — once the change was actually made.
    const spent = () =>
      changeProgress(markLessonForMe(BUILD_FLOW_ID, lesson)).catch(() => undefined);
    if (lesson === "lesson-1") {
      setBusy(true);
      const copyId = (await liveCopy(own)) ?? (await surface.copy());
      setBusy(false);
      if (!copyId) return;
      await changeProgress(recordTutorialCopy(BUILD_FLOW_ID, copyId)).catch(() => undefined);
      await spent();
      navigate(lessonAddress("lesson-1", copyId, i18n.language));
      return;
    }
    if (lesson === "lesson-2") {
      // The step goes into the Do block with its way on, which a save requires; nothing leads to
      // it yet — that is lesson 3.
      const id = freeId(surface.draft, "save-draft");
      surface.apply({
        kind: "add-node",
        node: {
          id,
          type: "agent-directive",
          directive: t("guides.tutorial.forMe.directive"),
          completionCondition: t("guides.tutorial.forMe.condition"),
        } as WorkflowNode,
        blockId: DO_BLOCK,
      });
      surface.apply({ kind: "set-connection", source: id, key: "success", target: "check-result" });
      surface.apply({
        kind: "connection-label",
        edges: [`${id}.success`],
        value: t("guides.tutorial.forMe.label"),
      });
    }
    if (lesson === "lesson-3") {
      const id = lessonStepId(engine(surface.draft), engine(example));
      if (!id) return;
      surface.apply({ kind: "set-connection", source: "do-task", key: "success", target: id });
    }
    if (lesson === "lesson-4") {
      const gap = freeId(surface.draft, "explain-gap");
      const current = surface.draft.nodes.find((n) => n.id === "check-result")?.connectionLabels
        ?.success;
      surface.apply({
        kind: "set-choice",
        nodeId: "check-result",
        choice: {
          field: "matches",
          question: t("guides.tutorial.forMe.question"),
          options: ["yes", "no"],
          defaultOption: "yes",
          targets: { no: gap },
          labels: {
            ...(current ? { yes: current } : {}),
            no: t("guides.tutorial.forMe.noLabel"),
          },
        },
        newNodes: [
          {
            node: {
              id: gap,
              type: "agent-directive",
              directive: t("guides.tutorial.forMe.gapDirective"),
              completionCondition: t("guides.tutorial.forMe.gapCondition"),
              connections: { success: "end" },
              connectionLabels: { success: t("guides.tutorial.forMe.gapLabel") },
            } as unknown as WorkflowNode,
            blockId: "check",
          },
        ],
      });
    }
    if (lesson === "lesson-5") {
      const report = surface.draft.nodes.find((n) => n.id === "report") as
        (WorkflowNode & { directive?: string }) | undefined;
      surface.apply({
        kind: "node-text",
        nodeId: "report",
        field: "directive",
        value:
          `${report?.directive ?? ""} ${t("guides.tutorial.forMe.reference", { ref: LESSON_REFERENCE })}`.trim(),
      });
    }
    if (lesson !== "lesson-1") await spent();
  };

  const deleteCopy = async () => {
    if (!surface) return;
    setBusy(true);
    const deleted = await apiClient.deleteWorkflow(surface.flowId).then(
      () => true,
      () => false,
    );
    setBusy(false);
    if (!deleted) {
      toast.error(t("guides.tutorial.deleteFailed"));
      return;
    }
    await changeProgress(dropTutorialCopy(BUILD_FLOW_ID)).catch(() => undefined);
    close();
    navigate(ROUTES.WORKFLOWS);
  };

  const next = () => {
    const following = steps[index + 1]?.id;
    if (!following) {
      close();
      return;
    }
    if (following === "lesson-1" && own?.copyId) {
      void liveCopy(own).then((copyId) =>
        copyId ? navigate(lessonAddress("lesson-1", copyId, i18n.language)) : go(following),
      );
      return;
    }
    go(following);
  };

  const forMeUsed = !!own?.forMe?.[lesson] || !!record?.forMe;
  const canDo =
    wide &&
    !!surface &&
    !!example &&
    lesson !== "lesson-0" &&
    lesson !== "lesson-6" &&
    lesson !== "lesson-7" &&
    !completed &&
    !forMeUsed &&
    (lesson === "lesson-1" ? true : onCopy);
  const title = t(`guides.build-flow.steps.${lesson}.title`);

  return (
    <>
      {ring && wide && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-40 rounded-lg ring-2 ring-primary ring-offset-2"
          style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
          data-testid="tutorial-spotlight"
          data-guide-anchor={anchor as string}
        />
      )}
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby="tutorial-card-title"
        className="fixed bottom-4 left-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
        data-testid="tutorial-card"
        data-lesson={lesson}
        data-status={status}
      >
        <div className="flex items-start gap-2">
          <GraduationCap className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("guides.tutorial.header", {
                title: t("guides.build-flow.title"),
                current: index,
                total: steps.length - 1,
              })}
            </p>
            <h2 id="tutorial-card-title" className="text-base font-semibold">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => close()}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            aria-label={t("guides.ui.close")}
            data-testid="tutorial-close"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <p
          className="mt-2 text-sm leading-relaxed text-muted-foreground"
          data-testid="tutorial-body"
        >
          {!wide
            ? t("guides.tutorial.narrow")
            : t(`guides.build-flow.steps.${lesson}.body`, { ref: LESSON_REFERENCE })}
        </p>
        {wide && lesson === "lesson-1" && onExample && own?.copyId && (
          <p className="mt-2 text-sm">{t("guides.tutorial.haveCopy")}</p>
        )}
        {wide && surface && !onCopy && !onExample && lesson !== "lesson-0" && (
          <p className="mt-2 text-sm text-warning-foreground" data-testid="tutorial-not-copy">
            {t("guides.tutorial.notYourCopy")}
          </p>
        )}
        {wide && status === "conflict" && (
          <div className="mt-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-sm">
            <p>{t("guides.tutorial.conflict")}</p>
            <Button size="sm" className="mt-2 h-7 text-xs" onClick={() => surface?.reload()}>
              {t("guides.tutorial.reload")}
            </Button>
          </div>
        )}
        {wide && status === "broken" && broken && (
          <div className="mt-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-sm">
            <p>
              {t("guides.tutorial.broken", {
                lesson: t(`guides.build-flow.steps.${broken}.title`),
              })}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 text-xs"
              onClick={() => go(broken)}
              data-testid="tutorial-go-back"
            >
              {t("guides.tutorial.goBack")}
            </Button>
          </div>
        )}
        {wide && findings.length > 0 && !completed && (
          <ul className="mt-2 space-y-1 text-sm" data-testid="tutorial-findings">
            {findings.map((finding, i) => (
              <li
                key={`${finding.code}-${finding.nodeId ?? ""}-${i}`}
                className="flex gap-1.5"
                data-code={finding.code}
              >
                <span aria-hidden="true" className="text-warning">
                  •
                </span>
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        )}
        {wide && lesson === "lesson-6" && surface && onCopy && (
          <div className="mt-2 space-y-2 text-sm" data-testid="tutorial-try-it">
            <p
              className="rounded-md bg-muted p-2 font-mono text-xs"
              data-testid="tutorial-sentence"
            >
              {t("guides.tutorial.tryIt.sentence", { name: surface.flowName })}
            </p>
            {!completed && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void lookForRun()}
                  data-testid="tutorial-check-run"
                >
                  {t("guides.tutorial.tryIt.checkAgain")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    // Skipped is recorded as done, so a later start resumes after it.
                    if (surface)
                      void changeProgress(
                        passLesson(BUILD_FLOW_ID, "lesson-6", surface.revision, false),
                      ).catch(() => undefined);
                    go("lesson-7");
                  }}
                  data-testid="tutorial-skip"
                >
                  {t("guides.tutorial.tryIt.skip")}
                </Button>
              </div>
            )}
          </div>
        )}
        {wide && lesson === "lesson-7" && surface && onCopy && (
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-7 text-xs text-destructive"
            onClick={() => void deleteCopy()}
            disabled={busy}
            data-testid="tutorial-delete-copy"
          >
            {t("guides.tutorial.deleteCopy")}
          </Button>
        )}
        {wide &&
          (status === "save" || status === "complete") &&
          lesson !== "lesson-0" &&
          lesson !== "lesson-7" && (
            <p
              className={cn(
                "mt-2 text-sm font-medium",
                status === "complete" ? "text-success" : "text-foreground",
              )}
              data-testid="tutorial-result"
            >
              {status === "complete"
                ? t("guides.tutorial.complete")
                : lesson === "lesson-1"
                  ? t("guides.tutorial.checking")
                  : t("guides.tutorial.looksRight")}
            </p>
          )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => void doItForMe()}
            disabled={!canDo || busy}
            data-testid="tutorial-for-me"
          >
            {t("guides.tutorial.forMe.action")}
          </Button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => go(steps[index - 1].id)}
                data-testid="tutorial-back"
              >
                {t("guides.ui.back")}
              </Button>
            )}
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={next}
              disabled={!completed}
              data-testid="tutorial-next"
            >
              {index === steps.length - 1 ? t("guides.tutorial.finish") : t("guides.ui.next")}
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
