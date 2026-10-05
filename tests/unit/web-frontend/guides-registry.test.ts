/**
 * The guide registry stays true to the interface it explains, and fails the pull request when it
 * goes stale.
 *
 * Every anchor a step points at is written in the page as a `guideAnchor("…")` literal, and every
 * literal is used by some step — a renamed or removed control fails here, not in a nightly run. A
 * step's anchor and English copy are fingerprinted against a committed snapshot, so changing what a
 * step says or points at makes its author decide whether that is a new revision. Every step is
 * reachable from every view it can be opened on, and names only panels and sections its screen
 * has. The migrated walkthroughs keep their steps and the elements those steps point at.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";
import {
  GUIDES,
  guideById,
  screenTourForPath,
} from "../../../packages/web-frontend/src/guides/registry.js";
import {
  anchorIn,
  anchorsOf,
  fallbackView,
  type GuideDefinition,
} from "../../../packages/web-frontend/src/guides/types.js";
import { visibleSteps } from "../../../packages/web-frontend/src/guides/GuideContext.js";
import { localeLookup, snapshotOf } from "../../../packages/web-frontend/src/guides/snapshot.js";
import en from "../../../packages/web-frontend/src/locales/en.json";
import { frontendSource, writtenAnchors } from "./helpers/guide-sources.js";

const usedAnchors = new Set(GUIDES.flatMap((guide) => guide.steps.flatMap(anchorsOf)));

describe("guide anchors", () => {
  const written = writtenAnchors();

  test("every anchor a step points at is written in the page", () => {
    expect([...usedAnchors].filter((name) => !written.has(name)).sort()).toEqual([]);
  });

  test("every anchor written in the page is pointed at by a step", () => {
    expect([...written].filter((name) => !usedAnchors.has(name)).sort()).toEqual([]);
  });

  test("names follow <screen>.<name>", () => {
    for (const name of usedAnchors) expect(name).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
  });
});

describe("the revision snapshot", () => {
  test("matches every step's revision, anchor and English copy — on a change, decide whether the step's revision must be raised, then run `npm run guides:snapshot`", () => {
    const committed = JSON.parse(
      fs.readFileSync(path.join(frontendSource, "guides/revisions.snapshot.json"), "utf8"),
    ) as Record<string, unknown>;
    const current = snapshotOf(GUIDES, localeLookup(en));
    const changed = Object.keys({ ...committed, ...current })
      .filter((key) => JSON.stringify(committed[key]) !== JSON.stringify(current[key]))
      .sort();
    expect(changed).toEqual([]);
  });
});

describe("the registry", () => {
  test("gives every guide and every step within a guide its own id", () => {
    expect(new Set(GUIDES.map((guide) => guide.id)).size).toBe(GUIDES.length);
    for (const guide of GUIDES) {
      expect(new Set(guide.steps.map((step) => step.id)).size).toBe(guide.steps.length);
      expect(guide.steps.length).toBeGreaterThan(0);
    }
  });

  test.each(GUIDES.map((guide) => [guide.id, guide] as const))(
    "%s reaches every step from every view it can be opened on, and prepares only what its screen has",
    (_id, guide: GuideDefinition) => {
      for (const step of guide.steps) {
        if (!guide.views) {
          expect(step.views).toBeUndefined();
          expect(typeof step.anchor).toBe("string");
        } else {
          const drawn = typeof step.anchor === "string" ? step.views : Object.keys(step.anchor);
          for (const view of drawn ?? []) expect(guide.views).toContain(view);
          for (const view of guide.views) {
            expect(anchorIn(step, view) ?? anchorIn(step, fallbackView(step))).toBeTruthy();
          }
        }
        if (step.prepare?.panel) expect(guide.panels).toContain(step.prepare.panel);
        if (step.prepare?.section) expect(guide.sections).toContain(step.prepare.section);
      }
    },
  );

  test("lets only an optional step declare when its element is absent", () => {
    const declaring = GUIDES.flatMap((guide) => guide.steps.filter((step) => step.absentWhen));
    expect(declaring.length).toBeGreaterThan(0);
    expect(declaring.filter((step) => !step.optional).map((step) => step.id)).toEqual([]);
  });

  test("shows the owner the edit switch and a reader how the owner edits", () => {
    const flow = guideById("flow")!;
    const ids = (owner: boolean) => visibleSteps(flow, owner).map((step) => step.id);
    expect(ids(true)).toContain("edit");
    expect(ids(true)).not.toContain("edit-reader");
    expect(ids(false)).toContain("edit-reader");
    expect(ids(false)).not.toContain("edit");
  });

  test.each([
    ["/", "home"],
    ["/workflows", "flows"],
    ["/executions", "runs"],
    ["/notes", "notes"],
    ["/playbooks", "playbooks"],
    ["/artifacts", "artifacts"],
    ["/executions/0d4c7a1e", "run"],
    ["/workflows/moira/example-simple-steps", "flow"],
    ["/workflows/7c2f3b8e-1a4d-4e6b-9c1f-5d8a2e3b4c01", "flow"],
    ["/settings", "settings"],
    ["/admin", undefined],
    ["/login", undefined],
  ])("offers %s the screen tour %p", (pathname, expected) => {
    expect(screenTourForPath(pathname)?.id).toBe(expected);
  });

  test.each([
    ["/moira", "home"],
    ["/moira/workflows", "flows"],
    ["/moira/executions/0d4c7a1e", "run"],
    ["/moira/settings", "settings"],
    ["/moira/admin", undefined],
    ["/moirax/settings", undefined],
  ])("under the base path /moira, offers %s the screen tour %p", (pathname, expected) => {
    expect(screenTourForPath(pathname, "/moira")?.id).toBe(expected);
  });
});

describe("the walkthroughs the guides replaced", () => {
  const stepIds = (id: string) => guideById(id)!.steps.map((step) => step.id);
  const step = (guide: string, id: string) => guideById(guide)!.steps.find((s) => s.id === id)!;

  test("keep every step of the run page, the flow page and Settings, in order", () => {
    // The migrated steps keep their order; the steps the full coverage added sit among them.
    const migrated = (guide: string, ids: string[]) =>
      expect(stepIds(guide).filter((id) => ids.includes(id))).toEqual(ids);
    migrated("run", ["process", "agent", "evidence", "loop", "route", "explore"]);
    migrated("flow", [
      "intro",
      "steps",
      "process",
      "agent",
      "evidence",
      "loop",
      "edit",
      "edit-reader",
      "explore",
    ]);
    expect(stepIds("settings")).toEqual([
      "nav",
      "account",
      "security",
      "notifications",
      "github",
      "local-devices",
      "apps",
      "tokens",
      "preferences",
    ]);
    expect(stepIds("settings-github")).toEqual([
      "steps",
      "connect",
      "codespaces",
      "limits",
      "autopause",
    ]);
    expect(stepIds("settings-telegram")).toEqual(["bot", "chat", "enable", "test"]);
  });

  test("point the run page's steps at the elements they explain", () => {
    expect(step("run", "process").anchor).toBe("process.contents-row");
    expect(step("run", "agent")).toMatchObject({
      anchor: "process.current-step",
      prepare: { currentBlock: true, panel: "block", section: "steps" },
    });
    expect(step("run", "evidence").anchor).toBe("process.current-step-inputs");
    expect(step("run", "loop").anchor).toBe("process.return-port");
    expect(step("run", "route")).toMatchObject({
      anchor: "run.route-cursor",
      prepare: { route: true },
    });
    // Each diagram draws its own toolbar, so the step names the one of the open view.
    expect(step("run", "explore").anchor).toEqual({
      map: "process.map-toolbar",
      graph: "process.graph-toolbar",
    });
  });

  test("open the flow page on the agent-first message, then the plain steps where each view draws them", () => {
    expect(step("flow", "intro").anchor).toBe("flow.header");
    // The instruction cards exist only on the steps view; on the map and the graph the step points
    // at the switch that opens them, so it does not take the reader out of their view.
    expect(step("flow", "steps").anchor).toEqual({
      steps: "flow.instruction-card",
      map: "flow.steps-view-switch",
      graph: "flow.steps-view-switch",
    });
    expect(step("flow", "edit")).toMatchObject({
      anchor: "flow.edit-toggle",
      roles: "owner",
      wide: true,
    });
    expect(step("flow", "edit-reader")).toMatchObject({ anchor: "flow.header", roles: "reader" });
    expect(step("flow", "explore").anchor).toEqual({
      map: "process.map-toolbar",
      graph: "process.graph-toolbar",
      steps: "flow.steps-toolbar",
    });
  });
});
