import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildExecutionProgressVisualModel,
  type ExecutionProgress,
} from "@mcp-moira/workflow-engine/progress-visual";

interface Props {
  progress: ExecutionProgress;
  onFocusNode: (nodeId: string) => void;
}

export const ExecutionProgressStrip: React.FC<Props> = ({ progress, onFocusNode }) => {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(960);
  const model = useMemo(
    () => buildExecutionProgressVisualModel(progress, { viewportWidth, minWidth: 320 }),
    [progress, viewportWidth],
  );

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => {
      if (element.clientWidth > 0) setViewportWidth(Math.round(element.clientWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const current = scroller?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!scroller || !current) return;
    scroller.scrollTop = Math.max(0, current.offsetTop - 16);
    scroller.scrollLeft = Math.max(
      0,
      current.offsetLeft - (scroller.clientWidth - current.offsetWidth) / 2,
    );
  }, [progress.activeNodeId, progress.executionRevision, viewportWidth]);

  return (
    <section
      className="border-b bg-background/95 px-4 py-3"
      data-testid="execution-progress"
      aria-labelledby="execution-progress-task"
    >
      <div className="mb-3 px-1">
        <h2
          id="execution-progress-task"
          className="text-xl font-bold leading-[26px]"
          data-testid="execution-progress-task-title"
        >
          {model.taskTitleLines.map((line, index) => (
            <span key={index} className="block">
              {line}
              {index < model.taskTitleLines.length - 1 ? " " : ""}
            </span>
          ))}
        </h2>
        {model.title && model.title !== model.taskTitle && (
          <p className="mt-1 text-xs font-semibold text-muted-foreground">{model.title}</p>
        )}
        {model.goal && (
          <p className="mt-2 text-sm leading-5" data-testid="execution-progress-goal">
            {model.goal}
          </p>
        )}
        {model.facts.length > 0 && (
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            {model.facts.map((fact) => (
              <div
                key={`${fact.label}-${fact.value}`}
                className={`rounded-xl border-2 bg-card px-3 py-2 ${fact.tone === "critical" ? "border-destructive" : fact.tone === "warning" ? "border-amber-500" : fact.tone === "positive" ? "border-emerald-500" : "border-border"}`}
              >
                <dt className="text-[11px] font-semibold text-muted-foreground">{fact.label}</dt>
                <dd className="text-sm font-semibold">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div
        ref={scrollerRef}
        className="max-h-[70vh] overflow-auto overscroll-contain rounded-xl border bg-muted/20 shadow-inner"
        data-testid="execution-progress-scroller"
      >
        <div
          className="relative"
          style={{ width: model.width, height: model.stagesHeight }}
          data-testid="execution-progress-model"
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={model.width}
            height={model.stagesHeight}
            aria-hidden="true"
          >
            <g transform={`translate(0 ${-model.stagesTop})`}>
              {model.edges.map((edge) => (
                <path
                  key={`${edge.source}-${edge.target}`}
                  d={edge.path}
                  fill="none"
                  className={edge.direction === "backward" ? "stroke-primary" : "stroke-border"}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={edge.direction === "backward" ? "7 6" : undefined}
                  data-direction={edge.direction}
                />
              ))}
            </g>
          </svg>
          <ol
            className="m-0 list-none p-0"
            aria-label={t("pages.executionInspector.progress.title")}
          >
            {model.nodes.map((node) => {
              const stateClass =
                node.state === "current"
                  ? "border-primary bg-primary/10 text-primary shadow-md ring-2 ring-primary/25"
                  : node.state === "completed"
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-border bg-card text-muted-foreground";
              const content = (
                <>
                  <div className="flex items-start gap-2">
                    <span className="text-lg font-bold" aria-hidden="true">
                      {node.state === "completed" ? "✓" : node.state === "current" ? "●" : "○"}
                    </span>
                    <span className="whitespace-normal text-sm font-bold leading-5">
                      {node.labelLines.map((line, index) => (
                        <span key={index} className="block">
                          {line}
                        </span>
                      ))}
                    </span>
                  </div>
                  <span className="sr-only">
                    {t(`pages.executionInspector.progress.${node.state}`)}
                  </span>
                  {node.lines.length > 0 && (
                    <div className="mt-3 space-y-1 text-xs leading-4 text-foreground">
                      {node.lines.map((line, index) => (
                        <p
                          key={`${line.kind}-${index}`}
                          className={
                            line.kind === "summary"
                              ? "font-semibold"
                              : line.kind === "detail"
                                ? "text-muted-foreground"
                                : line.kind === "outcome"
                                  ? "text-emerald-700 dark:text-emerald-300"
                                  : "font-medium text-primary"
                          }
                        >
                          {!line.marker
                            ? ""
                            : line.kind === "detail"
                              ? "• "
                              : line.kind === "outcome"
                                ? "✓ "
                                : line.kind === "next"
                                  ? "→ "
                                  : ""}
                          {line.text}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              );
              const common = `absolute rounded-2xl border-2 px-4 py-4 text-left ${stateClass}`;
              return (
                <li key={node.id}>
                  {node.focusNodeId ? (
                    <button
                      type="button"
                      className={`${common} transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
                      style={{
                        left: node.x,
                        top: node.y - model.stagesTop,
                        width: node.width,
                        height: node.height,
                      }}
                      aria-current={node.state === "current" ? "step" : undefined}
                      onClick={() => onFocusNode(node.focusNodeId!)}
                      data-testid={`progress-node-${node.id}`}
                      data-state={node.state}
                    >
                      {content}
                    </button>
                  ) : (
                    <article
                      className={common}
                      style={{
                        left: node.x,
                        top: node.y - model.stagesTop,
                        width: node.width,
                        height: node.height,
                      }}
                      aria-current={node.state === "current" ? "step" : undefined}
                      data-testid={`progress-node-${node.id}`}
                      data-state={node.state}
                    >
                      {content}
                    </article>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
};
