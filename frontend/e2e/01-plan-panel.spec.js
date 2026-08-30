// @ts-check
import { test, expect } from "@playwright/test";

test.describe("PLAN panel — initial render", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("shows the PLAN form with all required fields", async ({ page }) => {
    // Header
    await expect(page.getByTestId("trip-plan-btn")).toBeVisible();

    // Origin field
    await expect(page.locator('[data-field="origin"] .airport-combo-input')).toBeVisible();

    // Destination field — any combobox labelled "destination"
    const destination = page.locator('[data-field="destination"] .airport-combo-input');
    await expect(destination).toBeVisible();

    // Date inputs
    const dates = page.locator('input[type="date"]');
    await expect(dates).toHaveCount(2);

    // Party size exists
    await expect(page.getByText(/party/i).first()).toBeVisible();
  });

  test("START PLANNING button is visible and not clipped", async ({ page }) => {
    const btn = page.getByRole("button", { name: /start planning/i });
    await expect(btn).toBeVisible();

    // Button must be fully within the viewport — not scrolled below the fold
    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    const { height } = page.viewportSize();
    expect(box.y + box.height).toBeLessThanOrEqual(height);
  });

  test("shows PLAN HISTORY card on the right column", async ({ page }) => {
    // The plan history panel renders even when empty
    await expect(
      page.getByText(/plan history|next trip/i).first()
    ).toBeVisible();
  });

  test("tab strip shows five numbered panels", async ({ page }) => {
    for (const label of ["PLAN", "FLIGHTS", "HOTELS", "DAYS", "EXPORT"]) {
      await expect(
        page.getByRole("tab", { name: new RegExp(label, "i") })
      ).toBeVisible();
    }
  });
});
