// @ts-check
import { test, expect } from "@playwright/test";
import { enableGlobalHotkeys, visitApp } from "./helpers";

/**
 * Overlay tests — verify that every overlay opens via its hotkey and
 * closes with Esc.  These are integration tests for the overlay + hotkey
 * wiring in App.jsx.
 */

const OVERLAYS = [
  { key: "h", dialogName: "Conversation history", name: "History" },
  { key: "s", dialogName: "Settings", name: "Settings" },
  { key: "?", dialogName: "Keyboard shortcuts", name: "Help" },
  { key: "l", dialogName: "Trip checklist", name: "Checklist" },
  { key: "f", dialogName: "Favorite activities", name: "Favorites" },
  { key: "c", dialogName: "Service Status", name: "Service Status" },
];

for (const { key, dialogName, name } of OVERLAYS) {
  test(`${name} overlay opens with '${key}' and closes with Esc`, async ({ page }) => {
    await visitApp(page);
    await enableGlobalHotkeys(page);

    await page.keyboard.press(key);
    const dialog = page.getByRole("dialog", { name: dialogName });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });
}

test("only one overlay is open at a time — opening a second closes the first", async ({ page }) => {
  await visitApp(page);
  await enableGlobalHotkeys(page);

  // Open Help
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();

  // Close Help with Esc before opening History (hotkeys suppressed while overlay open)
  await page.keyboard.press("Escape");
  await expect(help).not.toBeVisible();

  // Now open History
  await page.keyboard.press("h");
  await expect(page.getByRole("dialog", { name: "Conversation history" })).toBeVisible();
});

test("chat popover opens with T and closes with Esc", async ({ page }) => {
  await visitApp(page);
  await enableGlobalHotkeys(page);

  await page.keyboard.press("t");
  await expect(page.getByRole("dialog", { name: /chat/i })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /chat/i })).not.toBeVisible();
});
