import type { Database } from "better-sqlite3";
import { withSqliteWrite } from "./sqlite-write.js";

// Drizzle exposes $client on the root database. A transaction supplied by its caller
// already owns the connection and has no separate $client.
function rootClient(db: object): Database | undefined {
  if (!("$client" in db)) return undefined;
  return db.$client as Database;
}

export async function withDrizzleWrite<T>(
  db: object,
  work: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): Promise<T> {
  const client = rootClient(db);
  return client ? withSqliteWrite(work, client) : work();
}

interface WriteQuery<T> extends PromiseLike<T> {
  prepare(): { execute(): { sync(): T & (T extends PromiseLike<unknown> ? never : unknown) } };
}

export async function executeDrizzleWrite<T>(db: object, query: WriteQuery<T>): Promise<T> {
  const client = rootClient(db);
  if (!client) return query;
  // Use Drizzle's selected result mode, including rows from RETURNING, in the
  // synchronous write callback. No other request runs between the statement and COMMIT.
  return withSqliteWrite(() => query.prepare().execute().sync(), client);
}
