#!/usr/bin/env tsx
/**
 * Refresh the committed guide revision snapshot after deciding, for every step whose anchor or
 * English copy changed, whether its `revision` must be raised.
 *
 * Usage: npm run guides:snapshot
 */

import fs from "node:fs";
import path from "node:path";
import { GUIDES } from "../packages/web-frontend/src/guides/registry.js";
import { localeLookup, snapshotOf } from "../packages/web-frontend/src/guides/snapshot.js";

const frontend = path.resolve("packages/web-frontend/src");
const english = JSON.parse(fs.readFileSync(path.join(frontend, "locales/en.json"), "utf8"));
const target = path.join(frontend, "guides/revisions.snapshot.json");
fs.writeFileSync(target, `${JSON.stringify(snapshotOf(GUIDES, localeLookup(english)), null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), target)}`);
