/**
 * E2E Tests for ErrorBoundary Component
 *
 * Tests the redesigned ErrorBoundary with shadcn/ui components:
 * - Card-based professional error UI
 * - Technical details hidden in production
 * - Go Home button functionality
 * - Proper styling with Tailwind CSS
 */

import { test, expect } from "./fixtures.js";

test.describe("ErrorBoundary", () => {
  test.describe("Error UI Display", () => {
    test("should display error card when error occurs", async ({ page }) => {
      // Navigate to test-error route which intentionally throws
      await page.goto("/test-error");

      // Wait for error boundary to render
      const errorCard = page.locator('[data-testid="error-boundary-card"]');
      await expect(errorCard).toBeVisible({ timeout: 10000 });

      // Verify card structure - title and subtitle should be visible
      await expect(page.locator("text=Something went wrong")).toBeVisible();
      await expect(page.locator("text=MCP Moira Web UI")).toBeVisible();
    });

    test("should display action buttons", async ({ page }) => {
      await page.goto("/test-error");

      // Wait for error boundary
      await expect(page.locator('[data-testid="error-boundary-card"]')).toBeVisible({
        timeout: 10000,
      });

      // Verify all action buttons are present
      await expect(page.locator('[data-testid="error-try-again"]')).toBeVisible();
      await expect(page.locator('[data-testid="error-reload"]')).toBeVisible();
      await expect(page.locator('[data-testid="error-go-home"]')).toBeVisible();
    });

    test("should display help text", async ({ page }) => {
      await page.goto("/test-error");

      await expect(page.locator('[data-testid="error-boundary-card"]')).toBeVisible({
        timeout: 10000,
      });

      // Verify help text is displayed
      await expect(page.locator("text=If this error persists")).toBeVisible();
      await expect(page.locator("text=Try refreshing the page")).toBeVisible();
    });
  });

  test.describe("Go Home Button", () => {
    test("should navigate to home page when Go Home is clicked", async ({ page }) => {
      await page.goto("/test-error");

      // Wait for error boundary
      await expect(page.locator('[data-testid="error-boundary-card"]')).toBeVisible({
        timeout: 10000,
      });

      // Click Go Home button
      await page.locator('[data-testid="error-go-home"]').click();

      // Should navigate to home (which redirects to / or /login)
      await page.waitForURL((url) => !url.pathname.includes("/test-error"), { timeout: 10000 });

      // Verify we're no longer on the error page
      await expect(page.locator('[data-testid="error-boundary-card"]')).not.toBeVisible();
    });
  });

  test.describe("Technical Details (Development Mode)", () => {
    // Note: In Docker, NODE_ENV=production so showDetails=false
    // This test verifies production behavior - technical details should be hidden

    test("should hide technical details in production mode", async ({ page }) => {
      await page.goto("/test-error");

      await expect(page.locator('[data-testid="error-boundary-card"]')).toBeVisible({
        timeout: 10000,
      });

      // In production mode (Docker), technical details should NOT be visible
      // Error ID should not be shown
      await expect(page.locator("text=Error ID:")).not.toBeVisible();
      // Copy button should not be visible
      await expect(page.locator('[data-testid="error-copy"]')).not.toBeVisible();
    });
  });

  test.describe("Styling", () => {
    test("should use professional styling from shadcn/ui Card", async ({ page }) => {
      await page.goto("/test-error");

      const errorCard = page.locator('[data-testid="error-boundary-card"]');
      await expect(errorCard).toBeVisible({ timeout: 10000 });

      // Verify Card component styles are applied
      // Card should have border and shadow (from shadcn Card)
      const cardClasses = await errorCard.getAttribute("class");
      expect(cardClasses).toContain("rounded");
      expect(cardClasses).toContain("border");
      expect(cardClasses).toContain("shadow");
    });

    test("should display warning icon in destructive color", async ({ page }) => {
      await page.goto("/test-error");

      await expect(page.locator('[data-testid="error-boundary-card"]')).toBeVisible({
        timeout: 10000,
      });

      // Check that AlertTriangle icon is rendered (lucide-react)
      // The icon is inside a div with bg-destructive/10 class
      const iconContainer = page.locator(".bg-destructive\\/10");
      await expect(iconContainer).toBeVisible();
    });
  });
});
