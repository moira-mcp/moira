import React, { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AnalyticsQuery, PublicationInput, PublicationReportRow } from "@mcp-moira/shared";
import { filterPublicationRows } from "@mcp-moira/shared/publication-report";
import { apiClient, ApiErrorUtils } from "@/services/api-client";
import {
  getReadOwner,
  getReadCredentialVersion,
  isPrivateReadSuspended,
} from "@/services/read-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FilterBar } from "@/components/FilterBar";

const labels = ["campaign", "source", "publication"] as const;
const metrics = ["visits", "registered", "firstRun", "repeatRun"] as const;
const columns = [...labels, "language", ...metrics] as const;
const prefix = "adminOverview.publications.";

function linkFor(id: string, language: string) {
  const url = new URL(`/api/public/publications/${encodeURIComponent(id)}`, window.location.origin);
  url.searchParams.set("lang", language);
  return url.href;
}

function downloadCsv(file: Blob) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "publication-analytics.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function CreatePublication({ onCreated }: { onCreated: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState<PublicationInput["language"]>(
    i18n.language.startsWith("ru") ? "ru" : "en",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  const [draft, setDraft] = useState({ campaign: "", source: "", publication: "" });
  const refresh = useRef<typeof onCreated | null>(null);
  useLayoutEffect(() => {
    refresh.current = onCreated;
    return () => {
      refresh.current = null;
    };
  }, [onCreated]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    const owner = getReadOwner();
    try {
      const publication = await apiClient.createAdminPublication({ ...draft, language });
      if (owner !== getReadOwner() || !refresh.current) return;
      setCreated(linkFor(publication.id, publication.language));
      setDraft({ campaign: "", source: "", publication: "" });
      void refresh.current();
    } catch (cause) {
      setError(ApiErrorUtils.getUserFriendlyMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) {
          setCreated("");
          setError("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">{t(prefix + "create")}</Button>
      </DialogTrigger>
      <DialogContent closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle>{t(prefix + (created ? "created" : "create"))}</DialogTitle>
          <DialogDescription>
            {t(prefix + (created ? "useLink" : "privateLabels"))}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <PublicationLink url={created} />
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {labels.map((field) => (
              <label key={field} className="block space-y-1 text-sm">
                <span>{t(prefix + field)}</span>
                <Input
                  required
                  maxLength={120}
                  value={draft[field]}
                  disabled={pending}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                />
              </label>
            ))}
            <div className="space-y-1 text-sm">
              <label htmlFor="publication-language">{t(prefix + "language")}</label>
              <Select
                value={language}
                disabled={pending}
                onValueChange={(value) => {
                  if (value === "en" || value === "ru") setLanguage(value);
                }}
              >
                <SelectTrigger id="publication-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="ru">Русский</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={pending || labels.some((field) => !draft[field].trim())}
            >
              {t(prefix + "create")}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PublicationLink({ url }: { url: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"copied" | "manual" | null>(null);
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setStatus("copied");
          } catch {
            setStatus("manual");
          }
        }}
      >
        {t(prefix + "copy")}
      </Button>
      {status && (
        <p className="text-xs text-muted-foreground" role="status">
          {t(prefix + status)}
        </p>
      )}
      {status === "manual" && (
        <Input
          aria-label={t(prefix + "link")}
          value={url}
          readOnly
          onFocus={(e) => e.target.select()}
        />
      )}
    </div>
  );
}

export function PublicationAnalytics({
  rows,
  exportQuery,
  onCreated,
}: {
  rows: PublicationReportRow[];
  exportQuery: AnalyticsQuery | null;
  onCreated: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState("");
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState(false);
  const language = i18n.language.startsWith("ru") ? "ru" : "en";
  const exportKey = JSON.stringify([exportQuery, search, language]);
  const currentKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    currentKey.current = exportKey;
    return () => {
      currentKey.current = null;
    };
  }, [exportKey]);
  async function exportCsv() {
    if (!exportQuery || exportPending) return;
    const credential = getReadCredentialVersion();
    setExportPending(true);
    setExportError(false);
    try {
      const file = await apiClient.exportAdminPublications(exportQuery, search, language);
      if (
        currentKey.current === exportKey &&
        credential === getReadCredentialVersion() &&
        !isPrivateReadSuspended()
      )
        downloadCsv(file);
    } catch {
      if (currentKey.current === exportKey) setExportError(true);
    } finally {
      setExportPending(false);
    }
  }
  const unknown = t(prefix + "unknown");
  const headers = columns.map((column) => t(prefix + column));
  const filtered = filterPublicationRows(rows, search, unknown);
  const cells = filtered.map((row) => [
    row.campaign,
    row.id ? row.source : unknown,
    row.publication,
    row.language?.toUpperCase() ?? "",
    row.id ? row.visits : "",
    row.registered,
    row.firstRun,
    row.repeatRun,
  ]);
  const total = [
    t(prefix + "total"),
    "",
    "",
    "",
    ...metrics.map((metric) => filtered.reduce((sum, row) => sum + row[metric], 0)),
  ];
  return (
    <>
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t(prefix + "search")}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!filtered.length || !exportQuery || exportPending}
              onClick={exportCsv}
            >
              {t(prefix + "export")}
            </Button>
            <CreatePublication onCreated={onCreated} />
          </>
        }
      />
      {exportError && (
        <p role="alert" className="text-sm text-destructive">
          {t(prefix + "exportError")}
        </p>
      )}
      {!rows.some((row) => row.id) && (
        <p className="text-sm text-muted-foreground">{t(prefix + "empty")}</p>
      )}
      {filtered.length ? (
        <Table aria-label={t(prefix + "title")}>
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header}>{header}</TableHead>
              ))}
              <TableHead>{t(prefix + "link")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row, index) => (
              <TableRow key={row.id ?? "unknown"}>
                {cells[index].map((cell, col) => (
                  <TableCell key={columns[col]} className="max-w-56 whitespace-normal break-words">
                    {cell === "" ? "—" : cell}
                  </TableCell>
                ))}
                <TableCell>
                  {row.id && row.language ? (
                    <PublicationLink url={linkFor(row.id, row.language)} />
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              {total.map((value, index) => (
                <TableCell key={columns[index]}>{value}</TableCell>
              ))}
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t("common.noResults")}</p>
      )}
    </>
  );
}
