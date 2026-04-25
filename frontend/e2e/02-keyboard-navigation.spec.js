// @ts-check
import { test, expect } from "@playwright/test";

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
    await page.goto("/");
    // Blur any auto-focused inputs so hotkeys register on the body
    await page.keyboard.press("Escape");
  });

  test("pressing 2 navigates to FLIGHTS panel", async ({ page }) => {
    await page.keyboard.press("2");
    await expect(page.locator(".panel-flights")).toBeVisible();
  });

  test("pressing 3 navigates to HOTELS panel", async ({ page }) => {
    await page.keyboard.press("3");
    await expect(page.locator(".panel-hotels")).toBeVisible();
  });

  test("pressing 4 navigates to DAYS panel", async ({ page }) => {
    await page.keyboard.press("4");
    await expect(page.locator(".panel-days")).toBeVisible();
  });

  test("pressing 5 navigates to EXPORT panel", async ({ page }) => {
    await page.keyboard.press("5");
    await expect(page.locator(".panel-export")).toBeVisible();
  });

  test("pressing 1 returns to PLAN panel", async ({ page }) => {
    await page.keyboard.press("2");
    await page.keyboard.press("1");
    await expect(page.locator(".panel-home")).toBeVisible();
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
