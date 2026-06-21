/**
 * List Query Builder — shared utility for paginated list endpoints.
 *
 * Extracts the repeating pattern across repositories:
 *   build WHERE → COUNT(*) → SELECT ... ORDER BY ... LIMIT ... OFFSET
 *
 * Each repository defines a ListQueryConfig with:
 *   - table reference
 *   - sortable column mapping
 *   - default sort and pagination
 *
 * Then calls `executeListQuery(db, config, filter, conditions)` which returns `{ rows, total }`.
 */

import { and, asc, desc, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQLiteColumn, SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";

/**
 * Configuration for a list query on a specific table.
 * Each repository creates one of these as a constant.
 */
export interface ListQueryConfig<TSortField extends string = string> {
  /** Drizzle table reference */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: SQLiteTableWithColumns<any>;
  /** Map of sort field names to Drizzle column references */
  sortableColumns: Record<TSortField, SQLiteColumn>;
  /** Default sort when not specified in filter */
  defaultSort: { field: TSortField; order: "asc" | "desc" };
  /** Default page size */
  defaultLimit: number;
  /** Maximum allowed page size */
  maxLimit: number;
}

/**
 * Standard pagination and sort params extracted from query strings.
 * Repositories extend this with their own filter fields.
 */
export interface ListQueryParams {
  sort?: string;
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Standard paginated result shape.
 */
export interface ListQueryResult<T> {
  items: T[];
  total: number;
}

/**
 * Execute a paginated list query with COUNT + SELECT.
 *
 * @param db - Drizzle database instance
 * @param config - Table and sort configuration
 * @param params - Pagination/sort params from the request
 * @param conditions - WHERE conditions built by the repository
 * @param selectColumns - Optional column selection (defaults to all columns)
 * @returns { rows, total } where rows are raw Drizzle result objects
 */
export async function executeListQuery<TSortField extends string>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BetterSQLite3Database<any>,
  config: ListQueryConfig<TSortField>,
  params: ListQueryParams,
  conditions: (SQL | undefined)[] = [],
  selectColumns?: Record<string, SQLiteColumn>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ rows: any[]; total: number }> {
  const validConditions = conditions.filter((c): c is SQL => c !== undefined);
  const whereClause = validConditions.length > 0 ? and(...validConditions) : undefined;

  // COUNT
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(config.table)
    .where(whereClause);
  const total = countResult[0]?.count ?? 0;

  // SORT
  const sortField = (params.sort as TSortField) ?? config.defaultSort.field;
  const sortColumn =
    config.sortableColumns[sortField] ?? config.sortableColumns[config.defaultSort.field];
  const orderFn = (params.sortOrder ?? config.defaultSort.order) === "asc" ? asc : desc;

  // PAGINATION
  const limit = Math.min(Math.max(1, params.limit ?? config.defaultLimit), config.maxLimit);
  const offset = Math.max(0, params.offset ?? 0);

  // SELECT
  const selectClause = selectColumns ?? config.table;
  const rows = await db
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select(selectClause as any)
    .from(config.table)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  return { rows, total };
}

/**
 * Execute a paginated list query with a custom count query (e.g. for JOIN-based filtering).
 * Same as executeListQuery but accepts a pre-built count value.
 */
export async function executeListQueryWithCount<TSortField extends string>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BetterSQLite3Database<any>,
  config: ListQueryConfig<TSortField>,
  params: ListQueryParams,
  conditions: (SQL | undefined)[],
  total: number,
  selectColumns?: Record<string, SQLiteColumn>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ rows: any[]; total: number }> {
  const validConditions = conditions.filter((c): c is SQL => c !== undefined);
  const whereClause = validConditions.length > 0 ? and(...validConditions) : undefined;

  const sortField = (params.sort as TSortField) ?? config.defaultSort.field;
  const sortColumn =
    config.sortableColumns[sortField] ?? config.sortableColumns[config.defaultSort.field];
  const orderFn = (params.sortOrder ?? config.defaultSort.order) === "asc" ? asc : desc;

  const limit = Math.min(Math.max(1, params.limit ?? config.defaultLimit), config.maxLimit);
  const offset = Math.max(0, params.offset ?? 0);

  const selectClause = selectColumns ?? config.table;
  const rows = await db
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select(selectClause as any)
    .from(config.table)
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(limit)
    .offset(offset);

  return { rows, total };
}

/**
 * Clamp pagination params to safe values.
 * Use when you need the clamped values without running the full query.
 */
export function clampPagination(
  config: Pick<ListQueryConfig, "defaultLimit" | "maxLimit">,
  params: Pick<ListQueryParams, "limit" | "offset">,
): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(1, params.limit ?? config.defaultLimit), config.maxLimit),
    offset: Math.max(0, params.offset ?? 0),
  };
}
