/**
 * The server's dry run of the draft: once the draft has stopped changing for a moment, it is sent
 * for validation; an answer is kept only while the draft it judged is still the current one, so a
 * slow answer for an earlier draft never lands on a newer one. A refused save's answer is the
 * server's judgement of the draft it carried and is accepted the same way. While the next answer is
 * pending, `latest` still holds the last one of this editing session — what the page shows until
 * then; the session ends when there is no draft.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowValidationStatus } from "../../types/react-flow-types";
import type { WorkflowGraph } from "../../types/workflow-types";
import type { DryRun } from "./issues";

/** How long the draft must stay unchanged before it is sent: typing sends nothing per keystroke. */
export const DRY_RUN_DELAY_MS = 400;

export function useDraftValidation(
  validate: (draft: WorkflowGraph) => Promise<WorkflowValidationStatus>,
  /** The draft to judge; undefined while there is nothing to judge (no edits). */
  draft: WorkflowGraph | undefined,
  delayMs: number = DRY_RUN_DELAY_MS,
): {
  dryRun: DryRun;
  /** The last answer of this editing session, for the page to show while the next one is pending. */
  latest: WorkflowValidationStatus | null;
  /** Record the server's judgement of a draft that came back another way (a refused save). */
  accept: (draft: WorkflowGraph, validation: WorkflowValidationStatus) => void;
  /** Ask again for the current draft (after a failed dry run). */
  retry: () => void;
} {
  const [dryRun, setDryRun] = useState<DryRun>({ status: "idle" });
  const [latest, setLatest] = useState<WorkflowValidationStatus | null>(null);
  /** An answer for `judged`: the dry run's state, and the session's latest answer. */
  const answer = useCallback((judged: WorkflowGraph, validation: WorkflowValidationStatus) => {
    setDryRun({ status: "done", draft: judged, validation });
    setLatest(validation);
  }, []);
  const [attempt, setAttempt] = useState(0);
  const current = useRef(draft);
  current.current = draft;

  useEffect(() => {
    if (!draft) {
      setDryRun({ status: "idle" });
      setLatest(null);
      return;
    }
    setDryRun((previous) =>
      previous.status === "done" && previous.draft === draft ? previous : { status: "pending" },
    );
    const timer = setTimeout(() => {
      validate(draft).then(
        (validation) => {
          if (current.current === draft) answer(draft, validation);
        },
        (error: unknown) => {
          if (current.current !== draft) return;
          setDryRun({
            status: "failed",
            draft,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }, delayMs);
    return () => clearTimeout(timer);
  }, [draft, validate, delayMs, attempt, answer]);

  const accept = useCallback(
    (judged: WorkflowGraph, validation: WorkflowValidationStatus) => {
      if (current.current === judged) answer(judged, validation);
    },
    [answer],
  );
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { dryRun, latest, accept, retry };
}
