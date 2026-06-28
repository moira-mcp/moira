/**
 * Shared, presentational flow card.
 *
 * One row in the unified "Your library" surface (and the SPA marketplace views). It is
 * presentational — only `useTranslation` + props, no app-only data hooks. The server-
 * rendered public storefront is a separate isolated package
 * (`@mcp-moira/marketplace-render`, no react-i18next/shadcn) that mirrors this same visual
 * language with its own prop-based card rather than importing this one.
 *
 * It shows the flow name, an optional {@link OfficialBadge}, and the MCP-FIRST run hint:
 * a natural-language instruction for the user to give their agent ("Ask your agent: run
 * \"<name>\""). It NEVER renders `start(...)` code — the end user does not execute MCP
 * tools. The caller fills two slots: `badges` (e.g. a Listed badge) and `actions`
 * (right-aligned, origin-specific buttons).
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "../ui/card";
import { OfficialBadge } from "./FlowBadges";
import { formatRelativeTime } from "../cards/format-utils";

interface FlowCardProps {
  /** Flow display name (also the run-hint subject). */
  name: string;
  /** When true, render the Official badge. */
  official?: boolean;
  /** Owner handle, shown as muted meta (omitted when absent). */
  ownerHandle?: string | null;
  /** Flow version, shown in the identity meta line (omitted when absent). */
  version?: string | null;
  /** Last-modified time (ms epoch), shown as a relative "updated" in the meta line. */
  updatedAt?: number | null;
  /** Extra badges rendered next to the name (e.g. a Listed badge). */
  badges?: ReactNode;
  /** Right-aligned, origin-specific action controls. */
  actions?: ReactNode;
  /** Optional row click (e.g. open the flow). */
  onClick?: () => void;
}

export function FlowCard({
  name,
  official,
  ownerHandle,
  version,
  updatedAt,
  badges,
  actions,
  onClick,
}: FlowCardProps) {
  const { t } = useTranslation();
  // Identity meta — version + last-updated — so otherwise-identical rows (same name,
  // duplicate copies) are distinguishable (defects D-N7/D-N1).
  const metaParts: string[] = [];
  if (version) metaParts.push(`v${version}`);
  if (updatedAt)
    metaParts.push(t("pages.workflows.home.updated", { time: formatRelativeTime(updatedAt) }));
  return (
    <Card
      className={onClick ? "cursor-pointer transition-colors hover:border-primary/50" : undefined}
      onClick={onClick}
      data-testid="flow-card"
    >
      <CardContent className="pt-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium truncate" data-testid="flow-card-name">
              {name}
            </span>
            {official && <OfficialBadge />}
            {badges}
          </div>
          <div className="text-xs text-muted-foreground truncate" data-testid="run-hint">
            {t("pages.workflows.home.runHint")}{" "}
            <span className="text-foreground">
              {`${t("pages.workflows.home.runVerb")} “${name}”`}
            </span>
          </div>
          {ownerHandle && (
            <div className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate">
              {t("pages.marketplace.by", { handle: ownerHandle })}
            </div>
          )}
          {metaParts.length > 0 && (
            <div
              className="text-[11px] text-muted-foreground mt-0.5 truncate"
              data-testid="flow-card-meta"
            >
              {metaParts.join(" · ")}
            </div>
          )}
        </div>
        {actions && <div className="flex items-center gap-1 shrink-0">{actions}</div>}
      </CardContent>
    </Card>
  );
}
