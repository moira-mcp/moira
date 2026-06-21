/**
 * Visual Regression Tests
 * Captures screenshots of all key pages in both light and dark mode
 * to establish baseline for visual regression detection.
 */

import { test, expect } from "./fixtures";
import { loginAsAdmin } from "./helpers/auth-helper";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

const PAGES = [
  { name: "dashboard", path: "/", waitFor: '[data-testid="stat-card"]' },
  { name: "workflows", path: "/workflows", waitFor: '[data-testid="workflow-card"]' },
  { name: "executions", path: "/executions", waitFor: "table" },
  { name: "notes", path: "/notes", waitFor: "main" },
  { name: "artifacts", path: "/artifacts", waitFor: "main" },
  { name: "settings", path: "/settings", waitFor: "main" },
  { name: "admin-dashboard", path: "/admin", waitFor: "main" },
  { name: "audit-log", path: "/admin/audit-log", waitFor: "main" },
  { name: "login", path: "/login", waitFor: "form", requiresAuth: false },
];

test.describe("Visual Regression Screenshots", () => {
  for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} mode`, () => {
      for (const page of PAGES) {
        test(`${page.name} - ${theme}`, async ({ page: pw }) => {
          // Login as admin for all pages except login
          if (page.requiresAuth !== false) {
            await loginAsAdmin(pw);
          }

          // Set theme
          await pw.addInitScript((t) => {
            localStorage.setItem("moira-theme", t);
          }, theme);

          await pw.goto(`${BASE_URL}${page.path}`);

          // Wait for page content
          await pw.waitForSelector(page.waitFor, { timeout: 10000 }).catch(() => {
            // Some pages may not have the exact selector, just wait for load
          });

          // Wait for animations to settle
          await pw.waitForTimeout(500);

          // Take screenshot
          await expect(pw).toHaveScreenshot(`${page.name}-${theme}.png`, {
            fullPage: true,
            maxDiffPixelRatio: 0.05,
          });
        });
      }
    });
  }
});
