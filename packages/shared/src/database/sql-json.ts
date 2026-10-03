import { sql, type SQL } from "drizzle-orm";

/** SQLite exposes JSON booleans as integers; reconstruction must retain their JSON type. */
export function storedJsonValue(type: SQL, value: SQL): SQL {
  return sql`CASE ${type}
    WHEN 'true' THEN json('true')
    WHEN 'false' THEN json('false')
    WHEN 'array' THEN json(${value})
    WHEN 'object' THEN json(${value})
    ELSE ${value} END`;
}
