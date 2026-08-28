import React, { useEffect, useMemo, useRef } from "react";
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
  const model = useMemo(
    () => buildExecutionProgressVisualModel(progress, { viewportWidth: 960 }),
    [progress],
  );

  useEffect(() => {
    const current = scrollerRef.current?.querySelector<HTMLElement>('[aria-current="step"]');
    current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [progress.activeNodeId, progress.executionRevision]);

  return (
    <section className="border-b bg-background/95 px-4 py-3" data-testid="execution-progress">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="truncate text-sm font-semibold">
          {progress.title || t("pages.executionInspector.progress.title")}
        </h2>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t("pages.executionInspector.progress.hint")}
        </span>
      </div>
      <div
        ref={scrollerRef}
        className="overflow-x-auto overscroll-x-contain rounded-xl border bg-muted/20 shadow-inner"
        data-testid="execution-progress-scroller"
      >
        <div
          className="relative"
          style={{ width: model.width, height: model.height }}
          data-testid="execution-progress-model"
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={model.width}
            height={model.height}
            aria-hidden="true"
          >
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
          </svg>
          {model.nodes.map((node) => {
            const stateClass =
              node.state === "current"
                ? "border-primary bg-primary/10 text-primary shadow-md ring-2 ring-primary/25 motion-safe:animate-[pulse_3s_ease-in-out_infinite]"
                : node.state === "completed"
                  ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-border bg-card text-muted-foreground";
            return (
              <button
                key={node.id}
                type="button"
                className={`absolute flex items-center gap-2 rounded-2xl border-2 px-3 text-left transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${stateClass}`}
                style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                aria-current={node.state === "current" ? "step" : undefined}
                aria-label={`${node.label}, ${t(`pages.executionInspector.progress.${node.state}`)}`}
                onClick={() => node.focusNodeId && onFocusNode(node.focusNodeId)}
                disabled={!node.focusNodeId}
                data-testid={`progress-node-${node.id}`}
                data-state={node.state}
              >
                <span className="text-lg font-bold" aria-hidden="true">
                  {node.state === "completed" ? "✓" : node.state === "current" ? "●" : "○"}
                </span>
                <span className="line-clamp-2 text-xs font-semibold leading-4">{node.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
