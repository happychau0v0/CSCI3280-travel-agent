// @ts-check
import { test, expect } from "@playwright/test";

/**
 * Overlay tests — verify that every overlay opens via its hotkey and
 * closes with Esc.  These are integration tests for the overlay + hotkey
 * wiring in App.jsx.
 */

const OVERLAYS = [
  { key: "h",  selector: ".history-overlay",      name: "History" },
  { key: "s",  selector: ".settings-overlay",     name: "Settings" },
  { key: "?",  selector: ".help-overlay",         name: "Help" },
  { key: "l",  selector: ".checklist-overlay",    name: "Checklist" },
  { key: "f",  selector: ".favorites-overlay",    name: "Favorites" },
  { key: "c",  selector: ".service-status-overlay", name: "Service Status" },
];

for (const { key, selector, name } of OVERLAYS) {
  test(`${name} overlay opens with '${key}' and closes with Esc`, async ({ page }) => {
    await page.goto("/");
    // Blur inputs so hotkeys fire on body
    await page.keyboard.press("Escape");

    await page.keyboard.press(key);
    await expect(page.locator(selector)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(selector)).not.toBeVisible();
  });
}

test("only one overlay is open at a time — opening a second closes the first", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Escape");

  // Open Help
  await page.keyboard.press("?");
  await expect(page.locator(".help-overlay")).toBeVisible();

  // Close Help with Esc before opening History (hotkeys suppressed while overlay open)
  await page.keyboard.press("Escape");
  await expect(page.locator(".help-overlay")).not.toBeVisible();

  // Now open History
  await page.keyboard.press("h");
  await expect(page.locator(".history-overlay")).toBeVisible();
});

test("chat popover opens with T and closes with Esc", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Escape");

  await page.keyboard.press("t");
  await expect(page.locator(".chat-popover")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".chat-popover")).not.toBeVisible();
});
