/**
 * Search over every step of the process: picking a match selects the block that owns it and,
 * where the surface can, brings the step itself into view. Mounted in the map's contents sidebar
 * and on the technical graph.
 */

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NodeTypeTag } from "./nodeTypeStyle";
import { blockById, nodeOwners, type RunBlock, type StepInfo } from "./model";

export function NodeFinder({
  blocks,
  steps,
  onPick,
  onPickStep,
  testId = "map-node-finder",
  autoFocus = false,
  onClose,
}: {
  blocks: RunBlock[];
  steps: StepInfo[];
  onPick: (blockId: string) => void;
  /** Also called with the step itself: the graph brings that step into view. */
  onPickStep?: (stepId: string, blockId: string | null) => void;
  testId?: string;
  autoFocus?: boolean;
  /** Escape, or a pick: the toolbar folds the finder away. */
  onClose?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const owners = useMemo(() => nodeOwners(blocks), [blocks]);
  const byId = blockById(blocks);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return steps
      .filter((n) => n.id.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ step: n, owner: byId.get(owners.get(n.id) ?? "") }));
  }, [steps, query, owners, byId]);

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("pages.runPage.map.findNode")}
        aria-label={t("pages.runPage.map.findNode")}
        className="h-8 pl-8 text-sm"
        data-testid={testId}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            onClose?.();
          }
        }}
      />
      {query.trim() && (
        <ul
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md"
          role="listbox"
        >
          {matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {t("pages.runPage.map.noMatch")}
            </li>
          )}
          {matches.map(({ step, owner }) => (
            <li key={step.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => {
                  if (owner) onPick(owner.id);
                  onPickStep?.(step.id, owner?.id ?? null);
                  setQuery("");
                  onClose?.();
                }}
                data-node-match={step.id}
              >
                <NodeTypeTag type={step.type} />
                <span className="truncate font-mono">{step.id}</span>
                {owner && (
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    <CornerDownLeft className="mr-1 inline size-3" aria-hidden="true" />
                    {owner.name}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
