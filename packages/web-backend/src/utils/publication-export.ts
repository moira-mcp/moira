import type { PublicationReportRow } from "@mcp-moira/shared";
import { filterPublicationRows } from "@mcp-moira/shared/publication-report";

const headings = {
  en: [
    "Link ID",
    "Campaign",
    "Source",
    "Publication",
    "Link language",
    "Accepted visits",
    "New accounts",
    "People with 1+ runs",
    "People with 2+ runs",
  ],
  ru: [
    "ID ссылки",
    "Кампания",
    "Площадка",
    "Публикация",
    "Язык ссылки",
    "Переходы с согласием",
    "Новые аккаунты",
    "Люди с 1+ запуском",
    "Люди с 2+ запусками",
  ],
};

function csvCell(value: number | string): string {
  if (typeof value === "number") return String(value);
  // Spreadsheet applications can evaluate formulas even inside quoted CSV cells.
  const safe = /^[\s\uFEFF]*[=+@\-＝＋＠－]|^[\t\r\n]/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function publicationCsv(
  rows: PublicationReportRow[],
  search: string,
  language: "en" | "ru",
): string {
  const unknown = language === "en" ? "Unknown source" : "Источник неизвестен";
  const filtered = filterPublicationRows(rows, search, unknown);
  const cells = filtered.map((row) => [
    row.id ?? "",
    row.campaign,
    row.id ? row.source : unknown,
    row.publication,
    row.language?.toUpperCase() ?? "",
    row.id ? row.visits : "",
    row.registered,
    row.firstRun,
    row.repeatRun,
  ]);
  const totals = (["visits", "registered", "firstRun", "repeatRun"] as const).map((key) =>
    filtered.reduce((sum, row) => sum + row[key], 0),
  );
  return (
    "\uFEFF" +
    [
      headings[language],
      ...cells,
      ["", language === "en" ? "Total shown" : "Итого по выборке", "", "", "", ...totals],
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")
  );
}
