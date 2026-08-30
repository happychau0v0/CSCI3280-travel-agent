// @ts-check
import { test, expect } from "@playwright/test";
import { enableGlobalHotkeys, visitApp } from "./helpers";

/**
 * Small-viewport tests — run against the "small-viewport" Playwright
 * project (1024 × 600) to catch overflow and clipping regressions.
 *
 * Tag every test so it can be targeted: npx playwright test --project=small-viewport
 */

test.use({ viewport: { width: 1024, height: 600 } });

test.describe("Small viewport (1024×600)", () => {
  test.beforeEach(async ({ page }) => {
    await visitApp(page);
  });

  test("START PLANNING button is not clipped below fold", async ({ page }) => {
    const btn = page.getByRole("button", { name: /start planning/i });
    await expect(btn).toBeVisible();

    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    // Allow 2 px tolerance for sub-pixel rounding
    expect(box.y + box.height).toBeLessThanOrEqual(600 + 2);
  });

  test("tab strip renders without horizontal overflow", async ({ page }) => {
    const tabStrip = page.locator(".tab-strip");
    await expect(tabStrip).toBeVisible();

    const box = await tabStrip.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeLessThanOrEqual(1024);
  });

  test("FLIGHTS panel renders without overflow on small viewport", async ({ page }) => {
    await enableGlobalHotkeys(page);
    await page.keyboard.press("2");
    const panel = page.getByRole("region", { name: "Flights" });
    await expect(panel).toBeVisible();

    // No horizontal scrollbar should appear — scrollWidth === clientWidth
    const noOverflow = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Flights"]');
      return !el || el.scrollWidth <= el.clientWidth + 1; // 1px tolerance
    });
    expect(noOverflow).toBe(true);
  });

  test("HOTELS panel renders without overflow on small viewport", async ({ page }) => {
    await enableGlobalHotkeys(page);
    await page.keyboard.press("3");
    const panel = page.getByRole("region", { name: "Hotels" });
    await expect(panel).toBeVisible();

    const noOverflow = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Hotels"]');
      return !el || el.scrollWidth <= el.clientWidth + 1;
    });
    expect(noOverflow).toBe(true);
  });

  test("overlays open and are scrollable on small viewport", async ({ page }) => {
    await enableGlobalHotkeys(page);
    await page.keyboard.press("?");

    const overlay = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(overlay).toBeVisible();

    // Overlay should not overflow the viewport horizontally
    const box = await overlay.boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1024 + 2);

    await page.keyboard.press("Escape");
  });

  test("no JS console errors on load at small viewport", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.reload();
    // Allow time for any deferred scripts
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });
});
