import fs from "node:fs";
import path from "node:path";

/** Copy the real migrations with a journal ending immediately before the requested migration. */
export function migrationsBefore(directory: string, tag: string): string {
  const target = path.join(directory, `before-${tag}`);
  fs.cpSync(path.resolve("packages/web-backend/drizzle"), target, { recursive: true });
  const journalPath = path.join(target, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 1) throw new Error(`Cannot prepare a migration history before ${tag}`);
  journal.entries = journal.entries.slice(0, index);
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return target;
}
