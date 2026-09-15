/**
 * One history interface, three consumers.
 *
 * Notes, playbooks and global settings keep their content in one revision store on the server. The
 * requirement is that they share the interface too, and the state that looks the same from outside
 * is three separate screens that happen to resemble each other. Behaviour alone cannot tell those
 * apart — both show a version list and a restore button — so this checks what behaviour cannot: that
 * every consumer mounts the same component, and that no consumer keeps a second implementation.
 */

import fs from "fs";
import path from "path";

const SRC = path.join(process.cwd(), "packages/web-frontend/src");
const SHARED = "history/RevisionHistoryDialog";

const CONSUMERS = {
  notes: "components/notes/NoteHistoryDialog.tsx",
  playbooks: "pages/Playbooks.tsx",
  globalSettings: "pages/AdminSettings.tsx",
};

function read(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), "utf-8");
}

describe("shared revision history", () => {
  test.each(Object.entries(CONSUMERS))(
    "%s reads its history through the shared dialog",
    (_consumer, file) => {
      const source = read(file);
      expect(source).toContain("RevisionHistoryDialog");
      expect(source).toMatch(new RegExp(`from "[^"]*${SHARED}"`));
    },
  );

  test("no consumer keeps its own version list, diff or restore dialog", () => {
    for (const file of Object.values(CONSUMERS)) {
      const source = read(file);
      // These belong to the shared dialog. A consumer that rendered them itself would be a second
      // implementation wearing the same clothes.
      expect(source).not.toContain("data-testid={`version-");
      expect(source).not.toContain('data-testid="diff-view"');
      expect(source).not.toContain('data-testid="restore-version-button"');
      expect(source).not.toContain("diffLines");
    }
  });

  test("the history view itself is implemented in exactly one place", () => {
    // What must not be duplicated is the history view: a list of revisions with a difference
    // between two of them. Switching an open editor to an older version is a different affordance
    // and is not what this guards.
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const relative = path.relative(SRC, full).replace(/\\/g, "/");
        if (relative.startsWith("components/history/")) continue;
        const source = fs.readFileSync(full, "utf-8");
        if (source.includes("diffLines") || source.includes('data-testid="version-content"')) {
          offenders.push(relative);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
