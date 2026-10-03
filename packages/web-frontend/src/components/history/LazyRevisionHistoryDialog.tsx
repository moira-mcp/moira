/** Shared history presentation loads only while a consumer actually opens history. */
import React, { lazy, Suspense } from "react";
import type { RevisionHistoryDialog as HistoryContent } from "./RevisionHistoryDialog";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";

const History = lazy(() =>
  import("./RevisionHistoryDialog").then((module) => ({ default: module.RevisionHistoryDialog })),
);

export function RevisionHistoryDialog(props: React.ComponentProps<typeof HistoryContent>) {
  const { t } = useTranslation();
  if (!props.open) return null;
  return (
    <Suspense
      fallback={
        <Dialog open onOpenChange={(open) => !open && props.onClose(false)}>
          <DialogContent className="sm:max-w-5xl">
            <DialogHeader>
              <DialogTitle>{t("history.title")}</DialogTitle>
              <DialogDescription>
                {props.source && t("history.description", { subject: props.source.label })}
              </DialogDescription>
            </DialogHeader>
            <Skeleton className="h-64 w-full" role="status" aria-label={t("common.loading")} />
          </DialogContent>
        </Dialog>
      }
    >
      <History {...props} />
    </Suspense>
  );
}
