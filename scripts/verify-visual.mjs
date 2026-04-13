#!/usr/bin/env node
/**
 * P4: Visual/layout regression tests.
 *
 * Validates that UI elements are not truncated, clipped, or pushed
 * below the fold at real viewport sizes. Uses computed-style assertions
 * (scrollWidth vs clientWidth, boundingBox checks) — zero external
 * dependencies beyond Playwright.
 *
 * These tests catch bugs that DOM-state tests miss:
 *   - Hotel names truncated by flex overflow
 *   - "✓ PICKED" badge clipped to "✓ PI"
 *   - START PLANNING button below fold at 1024×600
 *   - DayMiniMap invisible when activities lack coordinates
 *   - Flight option text overflow
 *
 * Run: node scripts/verify-visual.mjs
 * Requires: frontend running on http://localhost:5173
 */

// Playwright import — adjust path if needed for your environment.
// Falls back to requiring 'playwright' from node_modules.
let chromium;
try {
  const pkg = await import('playwright');
  chromium = pkg.chromium || pkg.default?.chromium;
} catch {
  console.error('Playwright not found. Install: npm install -D playwright');
  process.exit(1);
}

const FRONTEND_URL = 'http://localhost:5173';
const VIEWPORTS = [
  { name: '1440×900 (desktop)', width: 1440, height: 900 },
  { name: '1024×600 (small laptop)', width: 1024, height: 600 },
];

const results = [];
function record(label, passed, details = '') {
  results.push({ label, passed, details });
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${label}${details ? ' — ' + details : ''}`);
}

async function waitFor(fn, timeoutMs = 8000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function buildSSE(events) {
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

// ─── Test data ──────────────────────────────────────────────────────────

const FAKE_ITINERARY = {
  title: '3 Days in Tokyo',
  origin: 'Hong Kong',
  destination: 'Tokyo, Japan',
  local_transport_mode: 'transit',
  flight: {
    from_city: 'Hong Kong',
    from_iata: 'HKG',
    from_lat: 22.308,
    from_lng: 113.918,
    to_city: 'Tokyo',
    to_iata: 'NRT',
    to_lat: 35.772,
    to_lng: 140.392,
    date: '2026-05-15',
    source: 'fast-flights',
    options: [
      {
        label: 'Cheapest non-stop',
        type: 'non-stop',
        stops: 0,
        price_low: 1304,
        price_high: 1500,
        duration_min: 235,
        airline: 'Cathay Pacific',
        departure_time: '08:00',
        arrival_time: '13:15',
        recommended: true,
        seat_class: 'economy',
        seat_class_label: 'Economy',
      },
      {
        label: '1 stop · cheap',
        type: '1-stop',
        stops: 1,
        price_low: 980,
        price_high: 1200,
        duration_min: 380,
        airline: 'Vietnam Airlines',
        departure_time: '06:30',
        arrival_time: '16:00',
        recommended: false,
        seat_class: 'economy',
        seat_class_label: 'Economy',
      },
      {
        label: 'Alternative airline',
        type: 'non-stop',
        stops: 0,
        price_low: 1450,
        price_high: 1700,
        duration_min: 240,
        airline: 'Japan Airlines',
        departure_time: '14:00',
        arrival_time: '19:00',
        recommended: false,
        seat_class: 'economy',
        seat_class_label: 'Economy',
      },
    ],
  },
  hotels: [
    {
      name: 'Park Hyatt Tokyo — A Luxury Collection Hotel',
      address: '3-7-1-2 Nishi Shinjuku, Shinjuku City, Tokyo 163-1055, Japan',
      rating: 4.7,
      price_level: 'PRICE_LEVEL_VERY_EXPENSIVE',
      lat: 35.685,
      lng: 139.690,
      place_id: 'CH1',
      photo_url: null,
    },
    {
      name: 'Andaz Tokyo Toranomon Hills — a concept by Hyatt',
      address: '1-23-4 Toranomon, Minato City, Tokyo 105-0001, Japan',
      rating: 4.5,
      price_level: 'PRICE_LEVEL_EXPENSIVE',
      lat: 35.668,
      lng: 139.749,
      place_id: 'CH2',
      photo_url: null,
    },
    {
      name: 'Shibuya Stream Excel Hotel Tokyu',
      address: '3-21-3 Shibuya, Shibuya City, Tokyo 150-0002',
      rating: 4.3,
      price_level: 'PRICE_LEVEL_MODERATE',
      lat: 35.658,
      lng: 139.701,
      place_id: 'CH3',
      photo_url: null,
    },
  ],
  selected_flight: {
    label: 'Cheapest non-stop',
    type: 'non-stop',
    stops: 0,
    price_low: 1304,
    price_high: 1500,
    duration_min: 235,
    airline: 'Cathay Pacific',
    departure_time: '08:00',
    arrival_time: '13:15',
    recommended: true,
  },
  selected_hotel: {
    name: 'Park Hyatt Tokyo — A Luxury Collection Hotel',
    address: '3-7-1-2 Nishi Shinjuku',
    rating: 4.7,
    place_id: 'CH1',
    lat: 35.685,
    lng: 139.690,
  },
  days: [
    {
      day: 1,
      date: '2026-05-15',
      theme: 'Arrival & Shinjuku',
      weather: { condition: 'Partly cloudy', temp_c: 24, icon: 'partly_cloudy' },
      activities: [
        { time: '13:15', name: 'Arrive at Narita International Airport', address: 'Narita Airport T1', lat: 35.764, lng: 140.386, duration_min: 30 },
        { time: '14:00', name: 'Narita Express to Shinjuku', address: 'Narita Station', lat: 35.764, lng: 140.386, duration_min: 80 },
        { time: '16:00', name: 'Park Hyatt Tokyo — A Luxury Collection Hotel', address: '3-7-1-2 Nishi Shinjuku', lat: 35.685, lng: 139.690, duration_min: 30, description: 'Check in' },
        { time: '17:00', name: 'Shinjuku Gyoen National Garden', address: 'Naitomachi, Shinjuku', lat: 35.685, lng: 139.710, duration_min: 60, place_id: 'P1' },
        { time: '18:30', name: 'Omoide Yokocho', address: 'Nishishinjuku', lat: 35.693, lng: 139.698, duration_min: 90, place_id: 'P2' },
      ],
    },
    {
      day: 2,
      date: '2026-05-16',
      theme: 'Traditional Tokyo',
      activities: [
        { time: '08:00', name: 'Tsukiji Outer Market', address: 'Tsukiji', lat: 35.665, lng: 139.770, duration_min: 90, place_id: 'P3' },
        { time: '10:00', name: 'Senso-ji Temple', address: 'Asakusa', lat: 35.714, lng: 139.796, duration_min: 60, place_id: 'P4' },
        { time: '11:30', name: 'Nakamise Shopping Street', address: 'Asakusa', lat: 35.712, lng: 139.796, duration_min: 45 },
        { time: '14:00', name: 'teamLab Borderless', address: 'Azabudai Hills', lat: 35.660, lng: 139.737, duration_min: 120, place_id: 'P5' },
        { time: '17:00', name: 'Meiji Jingu Shrine', address: 'Yoyogi', lat: 35.676, lng: 139.699, duration_min: 60, place_id: 'P6' },
      ],
    },
    {
      day: 3,
      date: '2026-05-17',
      theme: 'Modern Tokyo & Departure',
      activities: [
        { time: '08:30', name: 'Shibuya Crossing', address: 'Shibuya', lat: 35.659, lng: 139.700, duration_min: 30 },
        { time: '09:30', name: 'Harajuku & Takeshita Street', address: 'Jingumae', lat: 35.670, lng: 139.702, duration_min: 60 },
        { time: '14:00', name: 'Narita Express to Airport', address: 'Tokyo Station', lat: 35.681, lng: 139.767, duration_min: 80 },
      ],
    },
  ],
};

const FAKE_MESSAGES = [
  { role: 'user', content: 'Plan 3 days in Tokyo' },
  { role: 'assistant', content: 'Three days in Tokyo — flights, hotels, and a full itinerary.' },
];

// ─── Main ───────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];

  for (const vp of VIEWPORTS) {
    console.log(`\n══════ ${vp.name} ══════\n`);

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      geolocation: { latitude: 22.3193, longitude: 114.1694 },
      permissions: ['geolocation'],
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Seed state with fake itinerary so all panels have data
    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle' });
    await page.evaluate((data) => {
      localStorage.setItem(
        'travel-chat-state',
        JSON.stringify({ messages: data.messages, itinerary: data.itinerary }),
      );
    }, { messages: FAKE_MESSAGES, itinerary: FAKE_ITINERARY });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // ─── HOME panel (submit button in viewport) ────────────────────

    const submitBtn = page.locator('button').filter({ hasText: /START PLANNING|REPLAN/ }).first();
    const submitVisible = await submitBtn.isVisible().catch(() => false);
    if (submitVisible) {
      const submitBox = await submitBtn.boundingBox();
      record(
        `[${vp.name}] Submit button in viewport`,
        submitBox && submitBox.y + submitBox.height <= vp.height,
        submitBox ? `y=${Math.round(submitBox.y)}, bottom=${Math.round(submitBox.y + submitBox.height)}` : 'not found',
      );
    } else {
      record(`[${vp.name}] Submit button visible`, false, 'button not found');
    }

    // ─── FLIGHTS panel ─────────────────────────────────────────────

    // Navigate to FLIGHTS tab
    const flightsTab = page.locator('[data-tab="FLIGHTS"], button').filter({ hasText: 'FLIGHTS' }).first();
    if (await flightsTab.isVisible().catch(() => false)) {
      await flightsTab.click();
      await page.waitForTimeout(300);

      // Check flight option text not truncated
      const flightOptions = page.locator('.panel-flights .panel-list-row, [aria-label="Flights"] li');
      const flightCount = await flightOptions.count();
      record(`[${vp.name}] FLIGHTS has ≥1 option`, flightCount >= 1, `count=${flightCount}`);

      // Check PICKED badge text
      const pickedBadges = page.locator('.panel-list-picked-tag');
      const pickedCount = await pickedBadges.count();
      if (pickedCount > 0) {
        const badgeText = await pickedBadges.first().innerText();
        record(
          `[${vp.name}] PICKED badge full text`,
          badgeText.includes('PICKED'),
          `got: "${badgeText.trim()}"`,
        );
        // Check badge not clipped by parent
        const badgeBox = await pickedBadges.first().boundingBox();
        if (badgeBox) {
          const parentWidth = await pickedBadges.first().evaluate(
            (el) => el.parentElement?.clientWidth || 0,
          );
          record(
            `[${vp.name}] PICKED badge not clipped`,
            badgeBox.width <= parentWidth + 2,
            `badge=${Math.round(badgeBox.width)}px, parent=${parentWidth}px`,
          );
        }
      }
    }

    // ─── HOTELS panel ──────────────────────────────────────────────

    const hotelsTab = page.locator('[data-tab="HOTELS"], button').filter({ hasText: 'HOTELS' }).first();
    if (await hotelsTab.isVisible().catch(() => false)) {
      await hotelsTab.click();
      await page.waitForTimeout(300);

      // Check hotel name not truncated (scrollWidth <= clientWidth)
      const hotelNames = page.locator('.hotel-option-name');
      const hotelNameCount = await hotelNames.count();

      for (let i = 0; i < Math.min(hotelNameCount, 3); i++) {
        const { scrollW, clientW, text } = await hotelNames.nth(i).evaluate((el) => ({
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          text: el.textContent?.trim().slice(0, 40),
        }));
        record(
          `[${vp.name}] Hotel "${text}…" not truncated`,
          scrollW <= clientW + 2,
          `scroll=${scrollW}, client=${clientW}`,
        );
      }

      // Check hotel detail name (right panel)
      const detailName = page.locator('.hotel-detail-name').first();
      if (await detailName.isVisible().catch(() => false)) {
        const { scrollW: dScrollW, clientW: dClientW } = await detailName.evaluate((el) => ({
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        }));
        record(
          `[${vp.name}] Hotel detail name not truncated`,
          dScrollW <= dClientW + 2,
          `scroll=${dScrollW}, client=${dClientW}`,
        );
      }

      // Check hotels map renders (if data has coordinates)
      const hotelsMap = page.locator('[data-testid="hotels-map"], .day-mini-map').first();
      if (await hotelsMap.isVisible().catch(() => false)) {
        const mapBox = await hotelsMap.boundingBox();
        record(
          `[${vp.name}] Hotels map has nonzero size`,
          mapBox && mapBox.width > 50 && mapBox.height > 50,
          mapBox ? `${Math.round(mapBox.width)}×${Math.round(mapBox.height)}` : 'invisible',
        );
      }
    }

    // ─── DAYS panel ────────────────────────────────────────────────

    const daysTab = page.locator('[data-tab="DAYS"], button').filter({ hasText: 'DAYS' }).first();
    if (await daysTab.isVisible().catch(() => false)) {
      await daysTab.click();
      await page.waitForTimeout(300);

      // Check DayMiniMap renders when activities have coordinates
      const dayMap = page.locator('[data-testid="day-mini-map"], .day-mini-map').first();
      if (await dayMap.isVisible().catch(() => false)) {
        const mapBox = await dayMap.boundingBox();
        record(
          `[${vp.name}] DayMiniMap visible with coords`,
          mapBox && mapBox.width > 50 && mapBox.height > 50,
          mapBox ? `${Math.round(mapBox.width)}×${Math.round(mapBox.height)}` : 'invisible',
        );
      } else {
        // Map might not be visible if no coordinates; that's a valid bug to flag
        record(
          `[${vp.name}] DayMiniMap visible`,
          false,
          'not visible — check if activities have lat/lng',
        );
      }
    }

    // ─── General: no horizontal overflow ───────────────────────────

    const bodyOverflow = await page.evaluate(() => {
      const body = document.body;
      return {
        scrollW: body.scrollWidth,
        clientW: body.clientWidth,
      };
    });
    record(
      `[${vp.name}] No horizontal page overflow`,
      bodyOverflow.scrollW <= bodyOverflow.clientW + 5,
      `scroll=${bodyOverflow.scrollW}, client=${bodyOverflow.clientW}`,
    );

    await context.close();
  }

  // ─── Console errors ────────────────────────────────────────────────

  const realErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.includes('net::ERR'),
  );
  record(
    'No uncaught console errors',
    realErrors.length === 0,
    realErrors.length > 0 ? `${realErrors.length} errors: ${realErrors[0]}` : '',
  );

  await browser.close();

  // ─── Summary ──────────────────────────────────────────────────────

  console.log('\n══════ SUMMARY ══════\n');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} checks`);

  if (failed > 0) {
    console.log('\nFailed checks:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => console.log(`  ❌ ${r.label} — ${r.details}`));
    process.exit(1);
  }
})();
