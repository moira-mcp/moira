/**
 * Every guide the product has, imported explicitly so a check can enumerate them without mounting a
 * page. The declarations are data; the runner that shows them is loaded only when a guide starts.
 */

import { matchPath } from "react-router-dom";
import { runGuide } from "../components/execution/run.guide";
import { flowGuide } from "../pages/flow.guide";
import {
  githubSetupGuide,
  settingsGuide,
  telegramSetupGuide,
} from "../pages/settings/settings.guide";
import type { GuideDefinition } from "./types";

export const GUIDES: readonly GuideDefinition[] = [
  runGuide,
  flowGuide,
  settingsGuide,
  githubSetupGuide,
  telegramSetupGuide,
];

export function guideById(id: string | null | undefined): GuideDefinition | undefined {
  return id ? GUIDES.find((guide) => guide.id === id) : undefined;
}

/** The screen tour of the route a pathname is on, if the screen has one. */
export function screenTourForPath(pathname: string): GuideDefinition | undefined {
  return GUIDES.find(
    (guide) =>
      guide.kind === "screen" &&
      guide.routes.some((pattern) => matchPath({ path: pattern, end: true }, pathname)),
  );
}
