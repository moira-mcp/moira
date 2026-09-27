/**
 * Every screen a reader can open is explained, and every tour explains what its screen must.
 *
 * The web app's routes are data (`routes/routeTable.ts`), and `App.tsx` renders them from it, so a
 * route cannot be added without this check seeing it. Each route is toured by its screen's guide,
 * exempted with a reason, or deferred with a reason tracked as unfinished work; each guide names
 * only routes that exist. Each screen tour, and the editor's task tour, covers its required topics (`guides/topics.ts`) with a
 * step whose anchor is written in the page. The checks are pure functions, run against the app's
 * real tables and against broken ones, so both the pass and each kind of failure are shown.
 */

import { describe, expect, test } from "@jest/globals";
import { GUIDES } from "../../../packages/web-frontend/src/guides/registry.js";
import { REQUIRED_TOPICS } from "../../../packages/web-frontend/src/guides/topics.js";
import {
  anchorsOf,
  type GuideDefinition,
} from "../../../packages/web-frontend/src/guides/types.js";
import {
  ALL_ROUTES,
  type RouteEntry,
} from "../../../packages/web-frontend/src/routes/routeTable.js";
import fs from "node:fs";
import path from "node:path";
import { frontendSource, writtenAnchors } from "./helpers/guide-sources.js";

/** What is wrong with the routes' coverage by the guides, one line per problem. */
function coverageProblems(
  routes: readonly RouteEntry[],
  guides: readonly GuideDefinition[],
): string[] {
  const problems: string[] = [];
  const screenTours = guides.filter((guide) => guide.kind === "screen");
  for (const route of routes) {
    const coverage = route.coverage;
    if ("screen" in coverage) {
      const tour = screenTours.find((guide) => guide.screen === coverage.screen);
      if (!tour) problems.push(`${route.id}: no screen tour for "${coverage.screen}"`);
      else if (!tour.routes.includes(route.path))
        problems.push(`${route.id}: the ${tour.id} tour does not name ${route.path}`);
    } else {
      const reason = "exempt" in coverage ? coverage.exempt : coverage.deferred;
      if (!reason.trim()) problems.push(`${route.id}: no reason given`);
    }
  }
  for (const guide of guides) {
    for (const pattern of guide.routes) {
      // A path can serve two routes: the home screen and, under a base path, the bare root's redirect.
      const named = routes.filter((entry) => entry.path === pattern);
      if (named.length === 0) problems.push(`${guide.id}: names ${pattern}, which is not a route`);
      else if (
        !named.some((route) => "screen" in route.coverage && route.coverage.screen === guide.screen)
      )
        problems.push(`${guide.id}: ${pattern} is not the "${guide.screen}" screen`);
    }
    if (guide.steps.length === 0) problems.push(`${guide.id}: no steps`);
  }
  return problems;
}

/** What is wrong with the tours' required topics, one line per problem. */
function topicProblems(
  topics: Readonly<Record<string, Readonly<Record<string, string>>>>,
  guides: readonly GuideDefinition[],
  written: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const [screen, required] of Object.entries(topics)) {
    const tour = guides.find((guide) => guide.id === screen);
    if (!tour) {
      problems.push(`${screen}: no tour`);
      continue;
    }
    for (const [topic, stepId] of Object.entries(required)) {
      const step = tour.steps.find((candidate) => candidate.id === stepId);
      if (!step) problems.push(`${screen}.${topic}: no step "${stepId}"`);
      else if (!anchorsOf(step).every((anchor) => written.has(anchor)))
        problems.push(`${screen}.${topic}: the anchor of "${stepId}" is not in the page`);
    }
  }
  return problems;
}

const tour = (screen: string, routes: string[], steps = ["intro"]): GuideDefinition => ({
  id: screen,
  kind: "screen",
  screen,
  routes,
  steps: steps.map((id) => ({ id, anchor: `${screen}.${id}`, kind: "look", revision: 1 })),
});

describe("route coverage", () => {
  test("every route of the app is toured, exempted or deferred with a reason, and every guide names real routes", () => {
    expect(coverageProblems(ALL_ROUTES, GUIDES)).toEqual([]);
  });

  test("App.tsx renders its routes only from the table: no route path is written inline", () => {
    // The table's routes, the root redirect, and the two layout routes that hold the main and admin
    // routes; a route written into App.tsx directly would escape the coverage check above.
    const source = fs.readFileSync(path.join(frontendSource, "App.tsx"), "utf8");
    const paths = [...source.matchAll(/\bpath=(\{[^\n]*?\}|"[^"]*")(?=\s|\/?>|$)/gm)].map(
      (match) => match[1],
    );
    expect(paths.sort()).toEqual(
      [
        "{`${APP_PREFIX}${route.path}`}",
        "{ROOT_REDIRECT.path}",
        "{APP_PREFIX}",
        "{ROUTES.ADMIN}",
        '{path.slice(base === "/" ? 1 : base.length + 1)}',
      ].sort(),
    );
  });

  test("every main screen is toured; only standalone pages, redirects and the admin area are not", () => {
    const untoured = ALL_ROUTES.filter((route) => !("screen" in route.coverage)).map(
      (route) => route.id,
    );
    expect(untoured.filter((id) => !/^admin|^root-redirect$/.test(id)).sort()).toEqual(
      [
        "forced-password-reset",
        "forgot-password",
        "invite-accept",
        "login",
        "oauth-authorize",
        "oauth-consent",
        "register",
        "registration-success",
        "reset-password",
        "test-error",
        "verify-email",
      ].sort(),
    );
    const deferred = ALL_ROUTES.filter((route) => "deferred" in route.coverage);
    expect(deferred.every((route) => route.id.startsWith("admin"))).toBe(true);
  });

  test.each([
    [
      "a route whose screen has no tour",
      [{ id: "reports", path: "/reports", coverage: { screen: "reports" } }],
      [],
      ['reports: no screen tour for "reports"'],
    ],
    [
      "a route its screen's tour does not name",
      [{ id: "notes", path: "/notes", coverage: { screen: "notes" } }],
      [tour("notes", [])],
      ["notes: the notes tour does not name /notes"],
    ],
    [
      "a guide naming a route that does not exist",
      [],
      [tour("notes", ["/notes"])],
      ["notes: names /notes, which is not a route"],
    ],
    [
      "a guide naming another screen's route",
      [{ id: "runs", path: "/executions", coverage: { screen: "runs" } }],
      [tour("runs", ["/executions"]), tour("notes", ["/executions"])],
      ['notes: /executions is not the "notes" screen'],
    ],
    [
      "a screen tour with no steps",
      [{ id: "notes", path: "/notes", coverage: { screen: "notes" } }],
      [tour("notes", ["/notes"], [])],
      ["notes: no steps"],
    ],
    [
      "an exemption without a reason",
      [{ id: "login", path: "/login", coverage: { exempt: " " } }],
      [],
      ["login: no reason given"],
    ],
  ] as const)("fails on %s", (_case, routes, guides, expected) => {
    expect(
      coverageProblems(routes as readonly RouteEntry[], guides as readonly GuideDefinition[]),
    ).toEqual(expected);
  });
});

describe("required topics", () => {
  test("every screen tour and the editor tour have a topic list, each topic a step whose anchor is in the page", () => {
    const screens = GUIDES.filter((guide) => guide.kind === "screen").map((guide) => guide.id);
    expect(Object.keys(REQUIRED_TOPICS).sort()).toEqual([...screens, "flow-editor"].sort());
    expect(topicProblems(REQUIRED_TOPICS, GUIDES, writtenAnchors())).toEqual([]);
  });

  test.each([
    [
      "a topic without a step",
      { notes: { quota: "quota" } },
      new Set(["notes.intro"]),
      ['notes.quota: no step "quota"'],
    ],
    [
      "a topic whose anchor is not in the page",
      { notes: { intro: "intro" } },
      new Set<string>(),
      ['notes.intro: the anchor of "intro" is not in the page'],
    ],
    [
      "a screen with topics and no tour",
      { reports: { intro: "intro" } },
      new Set<string>(),
      ["reports: no tour"],
    ],
  ] as const)("fails on %s", (_case, topics, written, expected) => {
    expect(topicProblems(topics, [tour("notes", ["/notes"])], written)).toEqual(expected);
  });
});
