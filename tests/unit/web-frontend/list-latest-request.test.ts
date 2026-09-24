/**
 * Every list drops a stale answer.
 *
 * A list page sizes its page to the drawn items, so while the size settles it can have two requests
 * in flight, and the older one may answer last. The audit log's end-to-end test shows the race and
 * the guard on one page; behaviour cannot show that every other list — or the next one added — has
 * the same guard. This checks what behaviour cannot: every list page and the flow list take the one
 * latest-request hook and drop an answer from an older request both on success and on error, and
 * keep no counter of their own.
 */

import fs from "fs";
import path from "path";

const SRC = path.join(process.cwd(), "packages/web-frontend/src");

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

function read(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), "utf-8");
}

// A list page is a page that sizes a DataListView with useListPageSize; the flow list fetches
// through useWorkflowList instead of a loader of its own.
const LIST_PAGES = sources("pages").filter((file) => read(file).includes("useListPageSize("));
const LOADERS = [...LIST_PAGES, "hooks/useWorkflowData.ts"];

describe("list loaders drop stale answers", () => {
  test("the list pages are found", () => {
    // Every list page of the interface, so a broken discovery cannot pass vacuously
    expect(LIST_PAGES.length).toBeGreaterThanOrEqual(11);
  });

  test.each(LOADERS)("%s takes the shared latest-request hook", (file) => {
    const source = read(file);
    expect(source).toMatch(/import \{ useLatestRequest \} from "[^"]*useLatestRequest"/);
    expect(source).toContain("= useLatestRequest();");
    expect(source).toMatch(/const isCurrent = beginRequest\(\);/);
  });

  test.each(LOADERS)(
    "%s drops an older answer on success and on error, and only the latest clears loading",
    (file) => {
      const source = read(file);
      expect(source.match(/if \(!isCurrent\(\)\) return;/g)?.length).toBeGreaterThanOrEqual(2);
      expect(source).toMatch(/} catch(?: \([^)]*\))? \{\s*if \(!isCurrent\(\)\) return;/);
      expect(source).toContain("if (isCurrent()) setLoading(false);");
    },
  );

  test("no list keeps a request counter of its own", () => {
    for (const file of [...LOADERS, "hooks/useResource.ts"]) {
      expect(read(file)).not.toMatch(/\+\+\w+Ref\.current|\w+Ref\.current \+= 1/);
    }
  });
});
