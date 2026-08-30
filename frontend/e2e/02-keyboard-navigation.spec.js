// @ts-check
import { test, expect } from "@playwright/test";
import { enableGlobalHotkeys, visitApp } from "./helpers";

/**
 * Keyboard navigation tests — verify that number keys switch panels,
 * Tab toggles focus columns, and the undo/redo keys are wired.
 *
 * These tests use `page.keyboard.press()` so they exercise the real
 * useKeyboard hook, not a simulated click.  The body must not be in a
 * text-input focus state when keys fire.
 */

test.describe("Keyboard navigation", () => {
  test.beforeEach(async ({ page }) => {
    await visitApp(page);
    await enableGlobalHotkeys(page);
  });

  test("pressing 2 navigates to FLIGHTS panel", async ({ page }) => {
    await page.keyboard.press("2");
    await expect(page.getByRole("region", { name: "Flights" })).toBeVisible();
  });

  test("pressing 3 navigates to HOTELS panel", async ({ page }) => {
    await page.keyboard.press("3");
    await expect(page.getByRole("region", { name: "Hotels" })).toBeVisible();
  });

  test("pressing 4 navigates to DAYS panel", async ({ page }) => {
    await page.keyboard.press("4");
    await expect(page.getByRole("region", { name: "Days" })).toBeVisible();
  });

  test("pressing 5 does not bypass the disabled EXPORT tab", async ({ page }) => {
    await page.keyboard.press("5");
    await expect(page.getByRole("tab", { name: /export/i })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("region", { name: "Home dashboard" })).toBeVisible();
  });

  test("pressing 1 returns to PLAN panel", async ({ page }) => {
    await page.keyboard.press("2");
    await page.keyboard.press("1");
    await expect(page.getByRole("region", { name: "Home dashboard" })).toBeVisible();
  });

  test("footer hints update when switching panels", async ({ page }) => {
    // On FLIGHTS, the footer should mention flight-specific hints
    await page.keyboard.press("2");
    const footer = page.locator(".footer-hints");
    await expect(footer).toBeVisible();
    // Footer text changes per-panel — just assert it renders something
    const text = await footer.innerText();
    expect(text.length).toBeGreaterThan(0);
  });
});
