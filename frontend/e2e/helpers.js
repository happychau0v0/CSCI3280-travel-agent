import { expect } from "@playwright/test";

export async function visitApp(page) {
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Menu sections" })).toBeVisible();
}

// The PLAN form intentionally autofocuses its first field. Blur it through
// the application's Escape handler before testing document-level hotkeys.
export async function enableGlobalHotkeys(page) {
  const origin = page.locator('[data-field="origin"] .airport-combo-input');
  await expect(origin).toBeVisible();
  await origin.focus();
  await page.keyboard.press("Escape");
  await expect(origin).not.toBeFocused();
}
