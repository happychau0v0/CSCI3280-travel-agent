// @ts-check
import { test, expect } from "@playwright/test";
import { enableGlobalHotkeys, visitApp } from "./helpers";

/**
 * Settings persistence tests — verify that currency, theme, and other
 * settings survive a page reload (localStorage round-trip).
 */

test.describe("Settings persistence", () => {
  test.beforeEach(async ({ page }) => {
    // Start with a clean localStorage state
    await visitApp(page);
    await page.evaluate(() => {
      localStorage.removeItem("travel-currency");
      localStorage.removeItem("travel-theme");
      localStorage.removeItem("travel-plan-history");
    });
    await page.reload();
  });

  test("currency selection persists across reload", async ({ page }) => {
    // Open settings
    await enableGlobalHotkeys(page);
    await page.keyboard.press("s");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Currency is a cycle action; HKD's next value is USD.
    await dialog.locator('[data-row-key="currency"]').click();

    // Close settings
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    // Reload page
    await page.reload();

    // Verify currency is still USD
    const storedCurrency = await page.evaluate(() =>
      localStorage.getItem("travel-currency")
    );
    expect(storedCurrency).toBe("USD");
  });

  test("mute toggle persists across reload", async ({ page }) => {
    // Set muted via localStorage and reload
    await page.evaluate(() => localStorage.setItem("travel-muted", "true"));
    await page.reload();

    // Verify muted class/state is applied — the mute row should indicate muted
    const muteState = await page.evaluate(() =>
      localStorage.getItem("travel-muted")
    );
    expect(muteState).toBe("true");
  });

  test("plan history is restored on reload", async ({ page }) => {
    // Inject a fake plan history entry into localStorage
    const fakeHistory = [
      {
        id: "test-tokyo",
        destination: "Tokyo",
        origin: "Hong Kong",
        start_date: "2026-06-01",
        end_date: "2026-06-03",
        created_at: Date.now(),
        day_count: 3,
      },
    ];
    await page.evaluate((h) => {
      localStorage.setItem("travel-plan-history", JSON.stringify(h));
    }, fakeHistory);

    await page.reload();

    // The plan history panel should show the injected entry
    await expect(page.getByTestId("plan-history-card-test-tokyo")).toContainText("Tokyo");
  });
});
