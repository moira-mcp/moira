import { sql, type SQL } from "drizzle-orm";

/** A malformed or non-array journal has no usable entries, like defensive repository reads. */
function safeJournal(errors: SQL): SQL {
  return sql`CASE WHEN json_valid(${errors})
    THEN CASE WHEN json_type(${errors}) = 'array' THEN ${errors} ELSE '[]' END
    ELSE '[]' END`;
}

/** SQL counterpart of isRefusal: only explicitly marked degradation entries are excluded. */
const isRefusal = sql`CASE WHEN journal.type = 'object'
  THEN coalesce(json_extract(journal.value, '$.errorType'), '') != 'degradation'
  ELSE 1 END`;

/** Count refusals without loading raw error inputs into a summary response. */
export function refusalCount(errors: SQL): SQL<number> {
  return sql<number>`(
    SELECT count(*) FROM json_each(${safeJournal(errors)}) AS journal
    WHERE ${isRefusal}
  )`;
}

/** SQL counterparts of the shared outcome classifier, preserving raw historical states. */
export function genuinelyCompletedExecution(state: SQL, stopReason: SQL): SQL {
  return sql`${state} = 'completed' AND ${stopReason} IS NULL`;
}

export function stoppedExecution(stopReason: SQL): SQL {
  return sql`${stopReason} IS NOT NULL`;
}

/** These operational inventories have always counted running-only active work. */
export function activeExecution(state: SQL, stopReason: SQL): SQL {
  return sql`${state} = 'running' AND ${stopReason} IS NULL`;
}

/** Genuine completion without a refused-step journal entry. */
export function successfulExecution(state: SQL, stopReason: SQL, errors: SQL): SQL {
  return sql`${genuinelyCompletedExecution(state, stopReason)} AND ${refusalCount(errors)} = 0`;
}

/** Latest recorded refusal timestamp; malformed/non-object entries cannot invent a time. */
export function latestRefusalAt(errors: SQL): SQL<number | null> {
  return sql<number | null>`(
    SELECT max(CASE WHEN journal.type = 'object'
      THEN CASE WHEN json_type(journal.value, '$.timestamp') IN ('integer', 'real')
        THEN json_extract(journal.value, '$.timestamp') END
      END)
    FROM json_each(${safeJournal(errors)}) AS journal
    WHERE ${isRefusal}
  )`;
}
