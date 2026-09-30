/**
 * Every guide the product has, imported explicitly so a check can enumerate them without mounting a
 * page. The declarations are data; the runner that shows them is loaded only when a guide starts.
 */

import { matchPath } from "react-router-dom";
import { APP_PREFIX } from "../constants/routes";
import { runGuide } from "../components/execution/run.guide";
import { artifactsGuide } from "../pages/artifacts.guide";
import { flowGuide } from "../pages/flow.guide";
import { flowEditorGuide } from "../pages/flowEditor.guide";
import { flowsGuide } from "../pages/flows.guide";
import { homeGuide } from "../pages/home.guide";
import { notesGuide } from "../pages/notes.guide";
import { overviewGuide } from "../pages/overview.guide";
import { playbooksGuide } from "../pages/playbooks.guide";
import { runsEmptyGuide, runsGuide } from "../pages/runs.guide";
import {
  githubSetupGuide,
  settingsGuide,
  telegramSetupGuide,
} from "../pages/settings/settings.guide";
import { buildFlowTutorial } from "./tutorial/buildFlow.guide";
import type { GuideDefinition } from "./types";

/** In the order "Show me around" lists the screens: the way a reader meets them. */
export const GUIDES: readonly GuideDefinition[] = [
  homeGuide,
  overviewGuide,
  flowsGuide,
  flowGuide,
  runsGuide,
  runGuide,
  runsEmptyGuide,
  notesGuide,
  playbooksGuide,
  artifactsGuide,
  settingsGuide,
  githubSetupGuide,
  telegramSetupGuide,
  flowEditorGuide,
  buildFlowTutorial,
];

export function guideById(id: string | null | undefined): GuideDefinition | undefined {
  return id ? GUIDES.find((guide) => guide.id === id) : undefined;
}

/** A pathname without the app's base path, the form guides' route patterns are written in. */
export function appPathname(pathname: string, prefix: string = APP_PREFIX): string {
  if (!prefix) return pathname;
  if (pathname === prefix) return "/";
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

/** The screen tour of the route a pathname is on, if the screen has one. */
export function screenTourForPath(
  pathname: string,
  prefix: string = APP_PREFIX,
): GuideDefinition | undefined {
  const path = appPathname(pathname, prefix);
  return GUIDES.find(
    (guide) =>
      guide.kind === "screen" &&
      guide.routes.some((pattern) => matchPath({ path: pattern, end: true }, path)),
  );
}
