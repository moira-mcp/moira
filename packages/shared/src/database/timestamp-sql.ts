import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Normalize stored absolute SQLite/ISO timestamps, preserving milliseconds.
 * Relative date keywords such as `now` are not observations. Guard them before
 * SQLite evaluates unixepoch, so this expression also remains safe in indexes.
 */
export function storedTimestampMs(value: SQLWrapper): SQL<number | null> {
  return sql<
    number | null
  >`CASE WHEN ${value} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'
    THEN cast(unixepoch(${value}, 'subsec')*1000 AS integer) END`;
}
