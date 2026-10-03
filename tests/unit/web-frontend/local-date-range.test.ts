import { expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Run the actual pure helper in an isolated calendar, rather than changing Jest's cached zone. */
function range(zone: string, from: string, to: string): { fromDate?: number; toDate?: number } {
  const source = pathToFileURL(resolve("packages/web-frontend/src/lib/local-date-range.ts")).href;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { localDayRange } from ${JSON.stringify(source)}; process.stdout.write(JSON.stringify(localDayRange(${JSON.stringify(from)},${JSON.stringify(to)})));`,
      ],
      { encoding: "utf8", env: { ...process.env, TZ: zone } },
    ),
  );
}

test.each([
  ["2026-03-29", 23, "2026-03-28T23:00:00.000Z", "2026-03-29T21:59:59.999Z"],
  ["2026-10-25", 25, "2026-10-24T22:00:00.000Z", "2026-10-25T22:59:59.999Z"],
] as const)(
  "Berlin local day %s includes its full %i-hour calendar day",
  (day, hours, from, to) => {
    const value = range("Europe/Berlin", day, day);
    expect(value).toEqual({ fromDate: Date.parse(from), toDate: Date.parse(to) });
    expect(value.toDate! - value.fromDate! + 1).toBe(hours * 60 * 60 * 1000);
  },
);

test("UTC epoch zero is a valid lower bound, while invalid and missing calendar dates remain absent", () => {
  expect(range("UTC", "1970-01-01", "1970-01-01")).toEqual({ fromDate: 0, toDate: 86399999 });
  expect(range("UTC", "2026-02-30", "not-a-date")).toEqual({});
  expect(range("UTC", "", "2026-02-28")).toEqual({
    toDate: Date.parse("2026-02-28T23:59:59.999Z"),
  });
});
