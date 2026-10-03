import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnalyticsExclusions } from "@mcp-moira/shared";
import { apiClient } from "@/services/api-client";
import { useResource } from "@/hooks/useResource";
import { useDebounce } from "@/hooks/useDebounce";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FilterBar } from "@/components/FilterBar";
import { InlineError } from "@/components/inline-error";
import { PageLoader } from "@/components/page-loader";

export function AnalyticsExclusionsControl({
  accountId,
  value,
  onChange,
  storageError,
}: {
  accountId: string | null;
  value: AnalyticsExclusions;
  onChange: (value: AnalyticsExclusions) => void;
  storageError: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debounced = useDebounce(search, 300);
  const [page, setPage] = useState({ search: "", offset: 0 });
  const offset = page.search === debounced ? page.offset : 0;
  const key = open && accountId ? JSON.stringify({ accountId, search: debounced, offset }) : null;
  const users = useResource(key, (request) => {
    const query = JSON.parse(request) as { search: string; offset: number };
    return apiClient.getAdminUserChoices({
      search: query.search || undefined,
      offset: query.offset,
      limit: 20,
    });
  });
  const selected = value.mode === "custom" ? value.userIds : [];
  const selectedKey =
    open && accountId && selected.length > 0 ? JSON.stringify({ accountId, ids: selected }) : null;
  const selectedUsers = useResource(selectedKey, (request) => {
    const query = JSON.parse(request) as { ids: string[] };
    return apiClient.getAdminUserChoices({ ids: query.ids, limit: 100 });
  });
  const selectedLabel = (id: string) => {
    const user =
      selectedUsers.data?.users.find((candidate) => candidate.id === id) ??
      users.data?.users.find((candidate) => candidate.id === id);
    return user ? `${user.name ? `${user.name} · ` : ""}${user.email}` : id;
  };
  const selectUser = (id: string, exclude: boolean) =>
    onChange({
      mode: "custom",
      userIds: exclude ? [...selected, id] : selected.filter((item) => item !== id),
    });
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!accountId}
        onClick={() => setOpen(true)}
        data-testid="admin-exclusions-open"
      >
        {t("adminOverview.exclusions")} ·{" "}
        {value.mode === "default-admins" ? t("common.admin") : selected.length}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85vh] grid-cols-1 overflow-y-auto sm:max-w-xl [&>*]:min-w-0"
          data-testid="admin-exclusions-dialog"
        >
          <DialogHeader className="min-w-0 text-left">
            <DialogTitle className="break-words pr-6 leading-6">
              {t("adminOverview.exclusions")}
            </DialogTitle>
            <DialogDescription className="break-words">
              {t("adminOverview.exclusionDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button
              variant={value.mode === "default-admins" ? "secondary" : "outline"}
              aria-pressed={value.mode === "default-admins"}
              data-testid="admin-exclusions-default"
              className="h-auto max-w-full whitespace-normal text-left"
              onClick={() => onChange({ mode: "default-admins" })}
            >
              {t("adminOverview.defaultMode")}
            </Button>
            <Button
              variant={value.mode === "custom" ? "secondary" : "outline"}
              aria-pressed={value.mode === "custom"}
              data-testid="admin-exclusions-custom"
              className="h-auto max-w-full whitespace-normal text-left"
              onClick={() => onChange({ mode: "custom", userIds: selected })}
            >
              {t("adminOverview.customMode")}
            </Button>
            <Button
              variant="ghost"
              data-testid="admin-exclusions-all"
              className="h-auto max-w-full whitespace-normal text-left"
              onClick={() => onChange({ mode: "custom", userIds: [] })}
            >
              {t("adminOverview.includeAll")}
            </Button>
          </div>
          <p className="break-words text-sm text-muted-foreground">
            {value.mode === "default-admins"
              ? t("adminOverview.defaultExclusions")
              : t("adminOverview.customExclusions", { count: selected.length })}
          </p>
          {storageError && (
            <p role="alert" className="text-sm text-warning">
              {t("adminOverview.storageError")}
            </p>
          )}
          {selected.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("adminOverview.selected")}</p>
              <div className="flex flex-wrap gap-1">
                {selected.map((id) => (
                  <Button
                    key={id}
                    variant="outline"
                    size="sm"
                    className="h-auto min-w-0 max-w-full whitespace-normal break-all text-left"
                    aria-label={t("adminOverview.remove", { name: selectedLabel(id) })}
                    onClick={() => selectUser(id, false)}
                  >
                    {selectedLabel(id)} ×
                  </Button>
                ))}
              </div>
              {selectedUsers.error && (
                <InlineError
                  title={t("common.errors.failedToLoad")}
                  message={selectedUsers.error}
                  onRetry={() => void selectedUsers.refresh()}
                  retryLabel={t("pages.dashboard.retry")}
                />
              )}
            </div>
          )}
          <FilterBar
            className="mb-0 min-w-0 [&>div]:min-w-0 [&>div]:max-w-full"
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder={t("adminOverview.search")}
            searchTestId="admin-exclusions-search"
          />
          {users.error && (
            <InlineError
              title={t("common.errors.failedToLoad")}
              message={users.error}
              onRetry={() => void users.refresh()}
              retryLabel={t("pages.dashboard.retry")}
            />
          )}
          {users.pending ? (
            <PageLoader />
          ) : (
            users.data && (
              <div className="min-w-0 space-y-2">
                {users.data.users.map((user) => (
                  <label
                    key={user.id}
                    className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md border border-border p-2 text-sm"
                  >
                    <Checkbox
                      className="shrink-0"
                      checked={
                        value.mode === "default-admins" ? user.isAdmin : selected.includes(user.id)
                      }
                      disabled={
                        value.mode === "default-admins" ||
                        (!selected.includes(user.id) && selected.length >= 100)
                      }
                      aria-label={`${t("adminOverview.exclusions")}: ${user.email}`}
                      data-testid={`admin-exclude-user-${user.id}`}
                      onCheckedChange={(checked) => selectUser(user.id, checked === true)}
                    />
                    <span className="min-w-0 flex-1 break-all">
                      {user.name || user.email}
                      {user.name && (
                        <span className="block text-xs text-muted-foreground">{user.email}</span>
                      )}
                    </span>
                    {user.isAdmin && (
                      <span className="ml-auto shrink-0 text-xs text-warning">
                        {t("common.admin")}
                      </span>
                    )}
                  </label>
                ))}
                <p className="break-words text-xs text-muted-foreground">
                  {t("adminOverview.searchMore", {
                    shown: users.data.users.length,
                    total: users.data.total,
                  })}
                </p>
                {selected.length >= 100 && (
                  <p className="text-xs text-warning">{t("adminOverview.limit")}</p>
                )}
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setPage({ search: debounced, offset: Math.max(0, offset - 20) })}
                  >
                    {t("adminOverview.previous")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + 20 >= users.data.total}
                    onClick={() => setPage({ search: debounced, offset: offset + 20 })}
                  >
                    {t("adminOverview.next")}
                  </Button>
                </div>
              </div>
            )
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
