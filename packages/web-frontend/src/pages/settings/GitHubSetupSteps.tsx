/**
 * Where the reader is in setting GitHub up: connect the account, install the Moira GitHub App,
 * grant it repositories. Each step says whether it is done, current or still ahead, so the card's
 * single next action (Connect, Install, Check installation) always has context.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { CodespaceConnectionView } from "@mcp-moira/shared";
import { cn } from "@/lib/utils";

type StepState = "done" | "current" | "upcoming" | "blocked";

const STEP_IDS = ["account", "install", "repositories"] as const;

/** The progress of each step for a connection state; `blocked` when the instance cannot connect. */
export function setupStepStates(
  connection: Pick<CodespaceConnectionView, "state" | "repositories">,
): Record<(typeof STEP_IDS)[number], StepState> {
  switch (connection.state) {
    case "disabled":
    case "configuration_error":
      return { account: "blocked", install: "blocked", repositories: "blocked" };
    case "connected":
      return connection.repositories.length > 0
        ? { account: "done", install: "done", repositories: "done" }
        : { account: "done", install: "done", repositories: "current" };
    case "installation_required":
      return { account: "done", install: "current", repositories: "upcoming" };
    default:
      // Not connected yet, connecting, or a connection that must be repaired.
      return { account: "current", install: "upcoming", repositories: "upcoming" };
  }
}

export function GitHubSetupSteps({
  connection,
}: {
  connection: Pick<CodespaceConnectionView, "state" | "repositories">;
}): React.JSX.Element {
  const { t } = useTranslation();
  const states = setupStepStates(connection);
  return (
    <ol
      className="grid gap-2 sm:grid-cols-3"
      aria-label={t("pages.settings.github.steps.label")}
      data-testid="github-setup-steps"
    >
      {STEP_IDS.map((id, index) => {
        const state = states[id];
        return (
          <li
            key={id}
            data-testid={`github-setup-step-${id}`}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3",
              state === "current" && "border-primary/50 bg-primary/5",
              state === "done" && "bg-muted/40",
              state === "blocked" && "opacity-60",
            )}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                state === "done" && "border-transparent bg-primary text-primary-foreground",
                state === "current" && "border-primary text-primary",
                (state === "upcoming" || state === "blocked") && "text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {state === "done" ? <Check className="size-3.5" /> : index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium leading-6">
                {t(`pages.settings.github.steps.${id}.title`)}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t(`pages.settings.github.steps.${id}.description`)}
              </p>
              <span className="sr-only">{t(`pages.settings.github.steps.states.${state}`)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
