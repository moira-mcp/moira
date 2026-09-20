/**
 * The outgoing connections of a node, named by the output they leave through.
 *
 * A routing node has one output per case (`blocker`, `minor`, `clean`, plus its default), and
 * several of them often lead to the same target. Listing the targets alone therefore prints the
 * same name three or four times and answers nothing: the reader's question is which output leads
 * where. Each chip is `output → target`, with the case that selects the output when the node
 * declares one, so the routing reads without opening the graph.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

export interface OutgoingConnection {
  id: string;
  label: string;
  /** The connection key the edge leaves through: a case's output, or `default`/`success`. */
  connectionType: string;
}

/** One authored routing case: the output it selects and the summary of its condition. */
export interface RoutingCase {
  summary?: string;
  output: string;
  target?: string;
}

export function OutgoingConnectionChips({
  connections,
  cases,
}: {
  connections: readonly OutgoingConnection[];
  /** The node's routing cases, when it has any; the summary of the matching one labels the chip. */
  cases?: readonly RoutingCase[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const summaries = new Map(
    (cases ?? [])
      .filter((routingCase) => routingCase.summary)
      .map((routingCase) => [routingCase.output, routingCase.summary as string]),
  );
  return (
    <div className="flex flex-wrap gap-1.5">
      {connections.map((connection) => {
        const target = connection.label || connection.id;
        const summary = summaries.get(connection.connectionType);
        return (
          <Badge
            key={`${connection.id}-${connection.connectionType}`}
            variant="secondary"
            className="text-xs font-normal"
            data-testid="outgoing-connection"
            data-output={connection.connectionType}
            data-hint={
              summary
                ? `${connection.connectionType} → ${target} · ${summary}`
                : `${connection.connectionType} → ${target}`
            }
          >
            <span className="font-mono">{connection.connectionType}</span>
            <span className="mx-1 text-muted-foreground" aria-hidden="true">
              →
            </span>
            {target}
            {summary && (
              <span className="ml-1 text-muted-foreground">
                {t("components.workflowGraph.nodeDetails.whenCase", "when")} {summary}
              </span>
            )}
          </Badge>
        );
      })}
    </div>
  );
}
