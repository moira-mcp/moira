import Database from "better-sqlite3";

// A private :memory: database has no second native connection. For a suspendable
// auth transaction only, ordinary callers keep reading its last committed image.
// File-backed databases never enter this module's allocation path.
type View = { db: Database.Database; readers: number; released: boolean };
const physical = new WeakMap<Database.Database, Database.Database>();
const startSnapshot = new WeakMap<Database.Database, () => () => void>();

export function physicalSqlite(handle: Database.Database): Database.Database {
  return physical.get(handle) ?? handle;
}
export function snapshotMemoryReaders(live: Database.Database) {
  return startSnapshot.get(live)?.();
}

export function exposePrivateMemory(
  live: Database.Database,
  owns: () => boolean,
  configure: (db: Database.Database) => void,
): Database.Database {
  let snapshot: View | undefined;
  const selected = () => (!owns() && snapshot ? snapshot.db : live);
  const release = (view: View) => {
    if (view.released && view.readers === 0 && view.db.open) view.db.close();
  };
  startSnapshot.set(live, () => {
    const db = new Database(live.serialize(), { readonly: true });
    try {
      configure(db);
    } catch (error) {
      db.close();
      throw error;
    }
    const view: View = { db, readers: 0, released: false };
    snapshot = view;
    return () => {
      snapshot = undefined;
      view.released = true;
      release(view);
    };
  });
  function prepare(source: string) {
    const initial = selected();
    let copies = new WeakMap<Database.Database, Database.Statement>();
    copies.set(initial, initial.prepare(source));
    const settings: Array<{ name: PropertyKey; args: unknown[] }> = [];
    const statementFor = (db: Database.Database) => {
      let stmt = copies.get(db);
      if (!stmt) {
        stmt = db.prepare(source);
        for (const { name, args } of settings) Reflect.apply(Reflect.get(stmt, name), stmt, args);
        copies.set(db, stmt);
      }
      return stmt;
    };
    const statement = new Proxy(Object.create(Object.getPrototypeOf(copies.get(initial))), {
      get(_target, key) {
        if (key === "database") return handle;
        const stmt = statementFor(selected());
        if (typeof Reflect.get(stmt, key) !== "function") return Reflect.get(stmt, key);
        return (...args: unknown[]) => {
          const db = selected();
          const active = statementFor(db);
          const result = Reflect.apply(Reflect.get(active, key), active, args);
          if (result === active) {
            // bind(), pluck(), raw(), expand() and safeIntegers() are fluent.
            // Reproduce their validated order on another physical statement.
            settings.push({ name: key, args });
            copies = new WeakMap([[db, active]]);
            return statement;
          }
          const view = snapshot;
          if (key === "iterate" && view && db === view.db) {
            view.readers++;
            const cursor = result as IterableIterator<unknown>;
            let ended = false;
            const end = () => {
              if (!ended) {
                ended = true;
                view.readers--;
                release(view);
              }
            };
            return {
              [Symbol.iterator]() {
                return this;
              },
              next() {
                try {
                  const item = cursor.next();
                  if (item.done) end();
                  return item;
                } catch (error) {
                  end();
                  throw error;
                }
              },
              return() {
                try {
                  return cursor.return!();
                } finally {
                  end();
                }
              },
            };
          }
          return result;
        };
      },
    }) as Database.Statement;
    return statement;
  }
  function transaction(fn: (...args: unknown[]) => unknown) {
    const modes = ["default", "deferred", "immediate", "exclusive"] as const;
    const entry = (mode: (typeof modes)[number]) =>
      function (this: unknown, ...args: unknown[]) {
        return selected().transaction(fn)[mode].apply(this, args);
      };
    const functions = Object.fromEntries(modes.map((mode) => [mode, entry(mode)]));
    for (const mode of modes) Object.assign(functions[mode], functions, { database: handle });
    return functions.default;
  }
  const handle = new Proxy(Object.create(Object.getPrototypeOf(live)), {
    get(_target, key) {
      if (key === "prepare") return prepare;
      if (key === "transaction") return transaction;
      const db = selected();
      const value = Reflect.get(db, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const target = selected();
        const result = Reflect.apply(Reflect.get(target, key), target, args);
        const view = snapshot;
        if (key === "backup" && view && target === view.db) {
          view.readers++;
          return Promise.resolve(result).finally(() => {
            view.readers--;
            release(view);
          });
        }
        return result === target ? handle : result;
      };
    },
  }) as Database.Database;
  physical.set(handle, live);
  return handle;
}
