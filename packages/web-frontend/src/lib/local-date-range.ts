function localDay(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : undefined;
}

/** Inclusive epoch-millisecond bounds for date inputs in the browser's local calendar. */
export function localDayRange(
  fromDay: string,
  toDay: string,
): { fromDate?: number; toDate?: number } {
  const from = localDay(fromDay);
  const through = localDay(toDay);
  if (through) through.setDate(through.getDate() + 1);
  return { fromDate: from?.getTime(), toDate: through ? through.getTime() - 1 : undefined };
}
