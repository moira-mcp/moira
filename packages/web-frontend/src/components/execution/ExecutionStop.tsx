import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { OctagonPause } from "lucide-react";
import type { ExecutionStopCapability } from "@mcp-moira/shared/execution-management";
import { apiClient, ApiClientError } from "../../services/api-client";
import { ConfirmDialog } from "../confirm-dialog";
import type { CardAction } from "../cards/CardShell";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";

export interface ExecutionStopTarget {
  executionId: string;
  title: string;
  stopCapability?: ExecutionStopCapability;
}

interface Decision {
  target: ExecutionStopTarget;
  capability: Extract<ExecutionStopCapability, { available: true }>;
  opener: HTMLElement | null;
}
const StopContext = createContext<{
  open: (target: ExecutionStopTarget) => void;
  updateTitle: (executionId: string, title: string) => void;
} | null>(null);

/** One confirmation outside every clickable card, using the page's existing refresh owner. */
export function ExecutionStopProvider({
  children,
  onStopped,
  scopeKey,
  fallbackFocusRef,
}: {
  children: React.ReactNode;
  onStopped: () => void | Promise<void>;
  scopeKey?: string;
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [displayTitle, setDisplayTitle] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [reviewing, setReviewing] = useState<Decision | null>(null);
  const reviewRequest = useRef<Decision | null>(null);
  const active = useRef<Decision | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const refresh = useRef(onStopped);
  refresh.current = onStopped;
  const lifetime = useMemo(() => ({ scopeKey }), [scopeKey]);
  const mounted = useRef<object | null>(null);
  useLayoutEffect(() => {
    mounted.current = lifetime;
    active.current = null;
    returnFocus.current = null;
    setDecision(null);
    return () => {
      mounted.current = null;
      active.current = null;
    };
  }, [lifetime]);
  const open = useCallback((target: ExecutionStopTarget) => {
    if (!target.stopCapability?.available) return;
    const next: Decision = {
      target,
      capability: target.stopCapability,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    active.current = next;
    returnFocus.current = next.opener;
    setDecision(next);
    setDisplayTitle(target.title);
    setReason("");
    setError(null);
    setNeedsReview(false);
    setReviewing(null);
  }, []);
  const updateTitle = useCallback((executionId: string, title: string) => {
    if (active.current?.target.executionId === executionId) setDisplayTitle(title);
  }, []);
  const controls = useMemo(() => ({ open, updateTitle }), [open, updateTitle]);
  const reviewCurrent = async () => {
    const asked = decision;
    if (!asked || active.current !== asked || reviewRequest.current === asked) return;
    reviewRequest.current = asked;
    setReviewing(asked);
    try {
      const [execution] = await apiClient.getOverviewRows([asked.target.executionId]);
      if (mounted.current !== lifetime || active.current !== asked) return;
      if (!execution) {
        setError(t("components.executionStop.errors.review"));
        return;
      }
      const capability = execution.stopCapability;
      if (!capability.available) {
        const refusal = capability.available === false ? capability.reason : "unavailable";
        setError(
          t(
            refusal === "in-flight" || refusal === "terminal"
              ? `components.executionStop.errors.${refusal}`
              : "components.executionStop.errors.review",
          ),
        );
        return;
      }
      const next: Decision = {
        ...asked,
        target: {
          executionId: execution.executionId,
          title: execution.title,
          stopCapability: capability,
        },
        capability,
      };
      active.current = next;
      setDecision(next);
      setDisplayTitle(execution.title);
      setNeedsReview(false);
      setError(null);
    } catch {
      if (mounted.current === lifetime && active.current === asked)
        setError(t("components.executionStop.errors.review"));
    } finally {
      if (reviewRequest.current === asked) reviewRequest.current = null;
      if (mounted.current === lifetime && active.current === asked) setReviewing(null);
    }
  };
  const confirm = async () => {
    const asked = decision;
    const text = reason.trim();
    if (!asked || active.current !== asked || needsReview || text.length < 1 || text.length > 500)
      return;
    try {
      await apiClient.stopExecution(asked.target.executionId, {
        expectedRevision: asked.capability.revision,
        reason: text,
      });
    } catch (caught) {
      if (mounted.current === lifetime && active.current === asked) {
        const refusal = caught instanceof ApiClientError ? caught.details?.stopRefusal : undefined;
        setError(
          t(
            refusal === "stale" || refusal === "in-flight" || refusal === "terminal"
              ? `components.executionStop.errors.${refusal}`
              : "components.executionStop.errors.failed",
          ),
        );
        if (caught instanceof ApiClientError && caught.status === 409) {
          setNeedsReview(true);
        }
      }
      throw caught;
    }
    // A successful mutation remains successful even if refreshing the page subsequently fails.
    if (mounted.current === lifetime && active.current === asked) {
      try {
        await refresh.current();
      } catch {
        /* The page's resource owns its refresh error; the stop is already committed. */
      }
    }
  };
  const trimmed = reason.trim();
  return (
    <StopContext.Provider value={controls}>
      {children}
      <ConfirmDialog
        open={decision !== null}
        confirmationKey={decision}
        onOpenChange={(next) => {
          if (!next) {
            active.current = null;
            setDecision(null);
          }
        }}
        title={t("components.executionStop.title")}
        description={t("components.executionStop.description", { title: displayTitle })}
        content={(loading) => (
          <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
            <Label htmlFor="execution-stop-reason">{t("components.executionStop.reason")}</Label>
            <Textarea
              id="execution-stop-reason"
              value={reason}
              disabled={loading || reviewing === decision}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby="execution-stop-hint"
              data-testid="execution-stop-reason"
              className="min-h-24"
            />
            <p id="execution-stop-hint" className="text-xs text-muted-foreground">
              {t("components.executionStop.hint", { count: trimmed.length })}
            </p>
            {trimmed.length > 500 ? (
              <p role="alert" className="text-sm text-destructive">
                {t("components.executionStop.errors.length")}
              </p>
            ) : null}
            {error ? (
              <p
                role="alert"
                className="text-sm text-destructive"
                data-testid="execution-stop-error"
              >
                {error}
              </p>
            ) : null}
            {needsReview ? (
              <Button
                type="button"
                variant="outline"
                disabled={loading || reviewing === decision}
                onClick={() => void reviewCurrent()}
              >
                {t("components.executionStop.review")}
              </Button>
            ) : null}
          </div>
        )}
        confirmDisabled={trimmed.length < 1 || trimmed.length > 500 || needsReview}
        confirmLabel={t("components.executionStop.confirm")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={confirm}
        onReturnFocus={() => {
          const opener = returnFocus.current;
          returnFocus.current = null;
          if (opener?.isConnected) opener.focus();
          else if (fallbackFocusRef?.current?.isConnected) fallbackFocusRef.current.focus();
          else {
            const target = document.querySelector<HTMLElement>(
              '[data-testid="overview-panel"] [data-testid="overview-panel-open-run"], main h1, [data-testid="run-header"]',
            );
            if (target) {
              if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
              target.focus();
            }
          }
        }}
      />
    </StopContext.Provider>
  );
}

export function useExecutionStopAction(target: ExecutionStopTarget | null): CardAction | null {
  const controls = useContext(StopContext);
  const { t } = useTranslation();
  const executionId = target?.executionId;
  const title = target?.title;
  useLayoutEffect(() => {
    if (executionId !== undefined && title !== undefined) controls?.updateTitle(executionId, title);
  }, [controls, executionId, title]);
  const capability = target?.stopCapability;
  if (
    !controls ||
    !target ||
    !capability ||
    (capability.available === false && capability.reason !== "in-flight")
  )
    return null;
  return {
    icon: <OctagonPause className="size-4" aria-hidden="true" />,
    label: t(
      capability.available ? "components.executionStop.confirm" : "components.executionStop.busy",
    ),
    variant: "destructive",
    disabled: !capability.available,
    onClick: () => controls.open(target),
    testId: `execution-stop-${target.executionId}`,
  };
}

export function ExecutionStopButton({ target }: { target: ExecutionStopTarget }) {
  const action = useExecutionStopAction(target);
  const { t } = useTranslation();
  return action ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={action.disabled}
      aria-label={action.label}
      data-hint={action.label}
      onClick={(event) => {
        event.stopPropagation();
        action.onClick();
      }}
      className="shrink-0 text-destructive"
      data-testid={action.testId}
    >
      {action.icon}
      {t("components.executionStop.confirm")}
    </Button>
  ) : null;
}
