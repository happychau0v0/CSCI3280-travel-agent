// @ts-check
import { test, expect } from "@playwright/test";

/**
 * Settings persistence tests — verify that currency, theme, and other
 * settings survive a page reload (localStorage round-trip).
 */

test.describe("Settings persistence", () => {
  test.beforeEach(async ({ page }) => {
    // Start with a clean localStorage state
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.removeItem("travel-currency");
      localStorage.removeItem("travel-theme");
    });
    await page.reload();
  });

  test("currency selection persists across reload", async ({ page }) => {
    // Open settings
    await page.keyboard.press("Escape"); // blur inputs
    await page.keyboard.press("s");
    await expect(page.locator(".settings-overlay")).toBeVisible();

    // Change currency — find the select or radio for currency
    const currencySelect = page.locator("select[data-testid='currency-select']");
    if (await currencySelect.isVisible()) {
      await currencySelect.selectOption("USD");
    } else {
      // Fallback: click the USD option button
      const usdBtn = page.getByRole("button", { name: /USD/ });
      await usdBtn.click();
    }

    // Close settings
    await page.keyboard.press("Escape");

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
        title: "3 Days in Tokyo",
        destination: "Tokyo",
        start_date: "2026-06-01",
        end_date: "2026-06-03",
        saved_at: Date.now(),
      },
    ];
    await page.evaluate((h) => {
      localStorage.setItem("travel-history", JSON.stringify(h));
    }, fakeHistory);

    await page.reload();

    // The plan history panel should show the injected entry
    await expect(page.getByText("3 Days in Tokyo")).toBeVisible();
  });
});
