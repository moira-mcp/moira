/**
 * The playbooks a node names, and whether this account can read them.
 *
 * A node that references behaviour text is incomplete on its own: whoever reads the node has to be
 * able to reach the text. The reference form is the engine's, taken from the shared module rather
 * than re-implemented here, so an escaped reference in a directive that explains the syntax is not
 * mistaken for a real one.
 *
 * Availability is asked, not assumed: a reference whose playbook cannot be read would run with a
 * placeholder, and saying so at the node is cheaper than finding out mid-run.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { BookOpen, AlertTriangle } from "lucide-react";
import { collectPlaybookReferences } from "@mcp-moira/shared/services/playbook-references";
import { apiClient } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { Badge } from "@/components/ui/badge";

interface NodePlaybookReferencesProps {
  /** Every string this node carries that a template may live in. */
  texts: (string | undefined)[];
}

type Availability = "unknown" | "available" | "unavailable";

/**
 * Distinct references across every string a node carries, in reading order.
 *
 * Exported because the panel has to know whether to draw a heading at all, and asking the same
 * collector is the only way that answer cannot disagree with what the list shows — an escaped
 * reference is text, not a name.
 */
export function collectNodeReferences(texts: (string | undefined)[]) {
  const seen = new Map<string, { name: string; owner?: string; text: string }>();
  for (const text of texts) {
    if (!text) continue;
    for (const reference of collectPlaybookReferences(text)) {
      if (!seen.has(reference.text)) seen.set(reference.text, reference);
    }
  }
  return [...seen.values()];
}

export const NodePlaybookReferences: React.FC<NodePlaybookReferencesProps> = ({ texts }) => {
  const { t } = useTranslation();

  const references = useMemo(() => collectNodeReferences(texts), [texts]);

  const [availability, setAvailability] = useState<Record<string, Availability>>({});

  useEffect(() => {
    let cancelled = false;
    for (const reference of references) {
      apiClient
        .getPlaybook(reference.name, reference.owner ? { owner: reference.owner } : {})
        .then(() => {
          if (!cancelled) {
            setAvailability((prev) => ({ ...prev, [reference.text]: "available" }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAvailability((prev) => ({ ...prev, [reference.text]: "unavailable" }));
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [references]);

  if (references.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="node-playbook-references">
      {references.map((reference) => {
        const state = availability[reference.text] ?? "unknown";
        const unavailable = state === "unavailable";
        return (
          <div key={reference.text} className="flex items-center gap-2 flex-wrap">
            {unavailable ? (
              <span
                className="flex items-center gap-1.5 text-sm text-muted-foreground"
                data-testid={`playbook-reference-unavailable-${reference.name}`}
              >
                <AlertTriangle className="h-3.5 w-3.5 text-chart-4" />
                <code>{reference.text}</code>
              </span>
            ) : (
              <Link
                to={`${ROUTES.PLAYBOOKS}?name=${encodeURIComponent(reference.name)}${
                  reference.owner ? `&owner=${encodeURIComponent(reference.owner)}` : ""
                }`}
                className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                data-testid={`playbook-reference-${reference.name}`}
              >
                <BookOpen className="h-3.5 w-3.5" />
                <code>{reference.text}</code>
              </Link>
            )}
            {unavailable && (
              <Badge variant="outline" className="text-[10px]">
                {t("components.workflowGraph.nodeDetails.playbookUnavailable", "not available")}
              </Badge>
            )}
          </div>
        );
      })}
    </div>
  );
};
