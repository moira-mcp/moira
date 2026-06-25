/**
 * Origin library list — renders the non-managed origins of the Workflows home
 * (added / shared / core). Each row shows the flow name, a HUMAN run hint (ask your
 * agent in natural language — Moira is an MCP utility, the end user does not execute MCP
 * tools, so no `start(...)` code is shown), the owner (added/shared), and — for
 * added-by-reference flows — a link to the source listing on the PUBLIC catalog
 * (root-mounted `/w/:handle/:slug`).
 *
 * The "Mine" origin is NOT rendered here; it uses the full WorkflowExplorer.
 */

import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Card, CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { EmptyState } from "../empty-state";
import { InlineError } from "../inline-error";
import { PageLoader } from "../page-loader";
import { publicFlowPath } from "../../pages/marketplace/components";
import type { MarketplaceLibraryItem } from "../../types/api-types";

type LibraryOrigin = "added" | "shared" | "core";

interface OriginLibraryListProps {
  origin: LibraryOrigin;
  items: MarketplaceLibraryItem[];
  loading: boolean;
  error: string | null;
}

export function OriginLibraryList({ origin, items, loading, error }: OriginLibraryListProps) {
  const { t } = useTranslation();

  if (loading) return <PageLoader />;
  if (error) return <InlineError message={error} />;
  if (items.length === 0) {
    return (
      <EmptyState
        title={t(`pages.workflows.home.empty.${origin}.title`)}
        description={t(`pages.workflows.home.empty.${origin}.desc`)}
      />
    );
  }

  return (
    <div className="space-y-2" data-testid={`origin-list-${origin}`}>
      {items.map((item) => (
        <Card key={`${item.origin}:${item.workflowId ?? item.slug}`}>
          <CardContent className="pt-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium truncate" data-testid="library-item-name">
                {item.name}
              </div>
              <div className="text-xs text-muted-foreground truncate" data-testid="run-hint">
                {t("pages.workflows.home.runHint")}{" "}
                <span className="text-foreground">
                  {`${t("pages.workflows.home.runVerb")} “${item.name}”`}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {item.ownerHandle && origin !== "core" && (
                <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
                  {t("pages.marketplace.by", { handle: item.ownerHandle })}
                </span>
              )}
              {origin === "added" && item.ownerHandle && (
                <a
                  href={publicFlowPath(item.ownerHandle, item.slug)}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  data-testid="added-source-link"
                >
                  {t("pages.workflows.home.viewSource")}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {item.kind && (
                <Badge variant="outline">
                  {t(`pages.marketplace.kind.${item.kind}`, { defaultValue: item.kind })}
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
