import type { PublicationReportRow } from "../database/repositories/publication-repository.js";

export function filterPublicationRows(
  rows: PublicationReportRow[],
  search: string,
  unknownLabel: string,
) {
  const query = search.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((row) => {
    const labels = row.id ? [row.campaign, row.source, row.publication] : [unknownLabel];
    return labels.some((label) => label.toLowerCase().includes(query));
  });
}
