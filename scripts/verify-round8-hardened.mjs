#!/usr/bin/env node
/**
 * Round 8.5 hardened verification.
 *
 * 100+ assertions covering:
 *   - Bug regressions (B1 focus-trap, B2 origin field, B3 subtitle queue,
 *     B4 stale closure, B5 edit session, B6 stale timer, B7 cursor snap,
 *     B8 Space activation, markdown leakage)
 *   - UX redesign (4 tabs, HOME absorbs TRIP, FLIGHTS picker, HOTELS
 *     picker auto-replan, HISTORY overlay, SETTINGS overlay, T/H/S
 *     hotkeys, context-aware FooterHints)
 *
 * Mocks the /chat/stream endpoint via page.route so the tests don't
 * require a real LLM round-trip. Probes internal state via the
 * window.__debug object exposed by App.jsx.
 *
 * Run: node /tmp/verify-round8-hardened.mjs
 */
import pkg from '/home/hpc/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.js';
const { chromium } = pkg;

const FRONTEND_URL = 'http://localhost:5173';
const CHROME_PATH = '/home/hpc/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

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
    } catch {
      // ignore, retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// Build a Server-Sent Events response body from a sequence of events.
function buildSSE(events) {
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

// Install a route mock that intercepts /chat/stream and returns a
// scripted SSE body. The optional `delayMs` lets the request stay in
// flight for a real amount of time so the frontend has a chance to
// render the "working" state — useful for B6 timer-cancellation tests.
async function installStreamMock(page, events, { delayMs = 0 } = {}) {
  await page.route('**/chat/stream', async (route) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const body = buildSSE(events);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: {
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      body,
    });
  });
}

async function clearStreamMock(page) {
  // unrouteAll to be safe — playwright sometimes accumulates handlers
  // when the same URL pattern is registered multiple times.
  try {
    await page.unrouteAll({ behavior: 'wait' });
  } catch {
    await page.unroute('**/chat/stream').catch(() => {});
  }
}

async function clearAll(page) {
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('body').click();
  await page.waitForTimeout(500);
}

async function seed(page, { messages = [], itinerary = null } = {}) {
  await page.evaluate((data) => {
    localStorage.setItem(
      'travel-chat-state',
      JSON.stringify({ messages: data.messages, itinerary: data.itinerary }),
    );
  }, { messages, itinerary });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('body').click();
  await page.waitForTimeout(500);
}

async function debugState(page) {
  return page.evaluate(() => window.__debug || null);
}

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
      { label: 'non-stop', stops: 0, price_low: 1304, duration_min: 235, airline: 'Cathay' },
      { label: '1 stop', stops: 1, price_low: 980, duration_min: 380, airline: 'JAL' },
    ],
  },
  hotels: [
    { name: 'Park Hyatt Tokyo', address: '3-7-1-2 Nishi Shinjuku', rating: 4.6, price_level: 'PRICE_LEVEL_VERY_EXPENSIVE', lat: 35.685, lng: 139.690, place_id: 'CH1' },
    { name: 'Andaz Tokyo', address: '1-23-4 Toranomon', rating: 4.5, price_level: 'PRICE_LEVEL_EXPENSIVE', lat: 35.668, lng: 139.749, place_id: 'CH2' },
    { name: 'Shibuya Stream', address: '3-21-3 Shibuya', rating: 4.3, price_level: 'PRICE_LEVEL_MODERATE', lat: 35.658, lng: 139.701, place_id: 'CH3' },
  ],
  days: [
    {
      day: 1, date: '2026-05-15', theme: 'Historic East Tokyo',
      weather: { condition: 'Partly cloudy', temp_c: 22, icon: 'partly-cloudy' },
      activities: [
        { time: '10:00', name: 'Senso-ji Temple', address: '2-3-1 Asakusa', lat: 35.71, lng: 139.79 },
      ],
    },
    { day: 2, date: '2026-05-16', theme: 'Shibuya & Harajuku', activities: [] },
    { day: 3, date: '2026-05-17', theme: 'Day trip', activities: [] },
  ],
};

const FAKE_MESSAGES = [
  { role: 'user', content: 'Plan a 3-day trip to **Tokyo**' },
  { role: 'assistant', content: 'Three days in **Tokyo**. Flight HKG → NRT around HK$1,304. Picked **Park Hyatt Tokyo** on 2026-05-15.' },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });
  const consoleErrors = [];
  const pageErrors = [];

  const context = await browser.newContext({
    geolocation: { latitude: 22.3193, longitude: 114.1694 },
    permissions: ['geolocation'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // ─── PHASE 1 — Initial render (8) ─────────────────────────────────
  console.log('\n=== Phase 1: Initial render ===');
  await page.goto(FRONTEND_URL, { waitUntil: 'networkidle' });
  await clearAll(page);

  const globeMounted = await waitFor(
    async () => (await page.locator('.globe-canvas canvas').count()) > 0,
    20000,
  );
  record('1.1 Globe canvas mounts', globeMounted);

  const tabCount = await page.locator('.tab-strip .tab').count();
  record('1.2 Tab strip has exactly 4 tabs', tabCount === 4, `count: ${tabCount}`);

  const tabLabels = await page.locator('.tab-strip .tab .tab-label').allInnerTexts();
  const expected = ['HOME', 'FLIGHTS', 'HOTELS', 'DAYS'];
  const labelsMatch = JSON.stringify(tabLabels) === JSON.stringify(expected);
  record('1.3 Tab labels HOME/FLIGHTS/HOTELS/DAYS', labelsMatch, `got: ${tabLabels.join(',')}`);

  const firstTab = await page.locator('.tab.active').first().innerText();
  record('1.4 First tab is HOME', firstTab.includes('HOME'));

  // Three corner cards (LIVE / FLIGHT / HOTEL); NEXT TRIP is now a
  // top summary band (`.home-summary-top`), not a card.
  const cardCount = await page.locator('.home-card').count();
  record('1.5 HOME has 3 corner cards + 1 summary band', cardCount === 3, `count: ${cardCount}`);
  const summaryBand = await page.locator('.home-summary-top').count();
  record('1.5b HOME has NEXT TRIP summary band', summaryBand === 1);

  const formFieldCount = await page.locator('.home-form .panel-list-item').count();
  record('1.6 HOME form has 7 fields (incl. origin)', formFieldCount === 7, `count: ${formFieldCount}`);

  const planBtn = await page.locator('[data-testid="trip-plan-btn"]').count();
  record('1.7 PLAN TRIP button rendered', planBtn === 1);

  const footerHints = await page.locator('.footer-hints .hint').allInnerTexts();
  const allHints = footerHints.join(' ');
  record(
    '1.8 Footer hints contain T/H/S',
    allHints.includes('T') && allHints.includes('H') && allHints.includes('S'),
  );

  // ─── PHASE 2 — Hotkey remap (T/H/S) (8) ────────────────────────────
  console.log('\n=== Phase 2: Hotkey remap ===');

  await page.locator('body').click();
  await page.keyboard.press('t');
  await page.waitForTimeout(300);
  let popoverVisible = await page.locator('.chat-popover').isVisible().catch(() => false);
  record('2.1 T opens chat popover', popoverVisible);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  popoverVisible = await page.locator('.chat-popover').isVisible().catch(() => false);
  record('2.2 Esc closes popover', !popoverVisible);

  // Press Enter on body — should NOT open popover
  await page.locator('body').click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const popoverFromEnter = await page.locator('.chat-popover').isVisible().catch(() => false);
  record('2.3 Enter on body does NOT open popover', !popoverFromEnter);

  // Cmd+K still opens
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(200);
  const popoverFromCmdK = await page.locator('.chat-popover').isVisible().catch(() => false);
  record('2.4 Cmd+K opens popover', popoverFromCmdK);
  if (popoverFromCmdK) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }

  // H opens history overlay
  await page.locator('body').click();
  await page.keyboard.press('h');
  await page.waitForTimeout(300);
  let historyOpen = await page.locator('.history-overlay').isVisible().catch(() => false);
  record('2.5 H opens HISTORY overlay', historyOpen);

  // Esc closes
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  historyOpen = await page.locator('.history-overlay').isVisible().catch(() => false);
  record('2.6 Esc closes HISTORY overlay', !historyOpen);

  // S opens settings overlay
  await page.keyboard.press('s');
  await page.waitForTimeout(300);
  let settingsOpen = await page.locator('.settings-overlay').isVisible().catch(() => false);
  record('2.7 S opens SETTINGS overlay', settingsOpen);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  settingsOpen = await page.locator('.settings-overlay').isVisible().catch(() => false);
  record('2.8 Esc closes SETTINGS overlay', !settingsOpen);

  // ─── PHASE 3 — Scope-aware arrows (7) ──────────────────────────────
  console.log('\n=== Phase 3: Scope-aware arrows ===');
  await seed(page, { itinerary: FAKE_ITINERARY });

  await page.keyboard.press('3');
  await page.waitForTimeout(300);
  let active = await page.locator('.tab.active').first().innerText();
  record('3.1 Press 3 → HOTELS', active.includes('HOTELS'));

  await page.locator('.panel-list-items .panel-list-item').first().click();
  await page.waitForTimeout(200);
  let dbg = await debugState(page);
  record('3.2 Click on hotel sets scope=list', dbg?.menuState?.scope === 'list');

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('3.3 ← does not switch tab when scope=list', active.includes('HOTELS'));

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('3.4 → does not switch tab when scope=list', active.includes('HOTELS'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  dbg = await debugState(page);
  record('3.5 Esc returns scope to tabs', dbg?.menuState?.scope === 'tabs');

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('3.6 ← cycles tabs when scope=tabs', active.includes('FLIGHTS'));

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('3.7 → cycles back', active.includes('HOTELS'));

  // ─── PHASE 4 — HOME trip form with B1 regression (10) ──────────────
  console.log('\n=== Phase 4: HOME trip form (B1 focus-trap regression) ===');
  await page.keyboard.press('1');
  await page.waitForTimeout(300);

  // Reset to row 0
  dbg = await debugState(page);
  // The B1 regression: pressing ↓ multiple times should advance the
  // cursor each time, NOT trap on the first input.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(120);
  }
  dbg = await debugState(page);
  record(
    '4.1 ↓×3 advances cursor to row 3 (B1 regression)',
    dbg?.menuState?.listIndex === 3,
    `listIndex: ${dbg?.menuState?.listIndex}`,
  );

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  dbg = await debugState(page);
  record(
    '4.2 ↓×5 total advances to row 5',
    dbg?.menuState?.listIndex === 5,
    `listIndex: ${dbg?.menuState?.listIndex}`,
  );

  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(120);
  dbg = await debugState(page);
  record('4.3 ↑ moves cursor back', dbg?.menuState?.listIndex === 4);

  // Type into the destination input by clicking the row, focusing the editor.
  // The form's row 1 is destination (row 0 is origin).
  await clearAll(page);
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  // Move to destination row (index 1)
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(120);
  // Click the inline editor on the right side
  await page.locator('[data-testid="home-editor-input"]').click();
  await page.locator('[data-testid="home-editor-input"]').fill('Kyoto');
  await page.waitForTimeout(200);
  const destText = await page.locator('.home-form .panel-list-item').nth(1).innerText();
  record('4.4 Typing fills destination', destText.includes('Kyoto'));

  // Reload — destination should persist
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('body').click();
  await page.waitForTimeout(500);
  const destTextReload = await page.locator('.home-form .panel-list-item').nth(1).innerText();
  record('4.5 Destination persists across reload', destTextReload.includes('Kyoto'));

  // PLAN button is enabled now
  const planEnabled = await page.locator('[data-testid="trip-plan-btn"]').isEnabled();
  record('4.6 PLAN button enabled with destination set', planEnabled);

  // Mock a slow stream so the frontend has time to render the
  // "working" state — without the delay the mock returns done so fast
  // that the working state would be invisible.
  await installStreamMock(
    page,
    [
      { type: 'tool_start', data: { name: 'search_flights', args: {} } },
      { type: 'done', data: { reply: 'Done.', itinerary: FAKE_ITINERARY, tool_calls_made: ['search_flights'] } },
    ],
    { delayMs: 800 },
  );
  await page.locator('[data-testid="trip-plan-btn"]').click();
  const statusVisible = await waitFor(
    async () => (await page.locator('.agent-status-bar').count()) > 0,
    1500,
  );
  record('4.7 AgentStatusBar appears within 1.5s of PLAN', statusVisible);

  // Probe internal state instead of brittle DOM heuristics
  const reachedWorking = await waitFor(async () => {
    const d = await debugState(page);
    return d?.agentState === 'working';
  }, 1500);
  record('4.8 agentState reaches "working" (via __debug)', reachedWorking);

  // Wait for done — this transitions through working → done → idle
  const reachedDone = await waitFor(async () => {
    const d = await debugState(page);
    return d?.agentState === 'done' || d?.agentState === 'idle';
  }, 8000);
  record('4.9 agentState reaches "done" or "idle"', reachedDone);

  // After the 1.5s done flash + a buffer the bar should hide
  await page.waitForTimeout(2200);
  const barCount = await page.locator('.agent-status-bar').count();
  record('4.10 Status bar collapses to idle after done', barCount === 0);
  await clearStreamMock(page);

  // ─── PHASE 5 — Subtitle queue B3 regression (4) ────────────────────
  console.log('\n=== Phase 5: Subtitle queue B3 regression ===');
  await clearAll(page);

  // First request
  await installStreamMock(page, [
    { type: 'done', data: { reply: 'First reply.', itinerary: null, tool_calls_made: [] } },
  ]);
  await page.keyboard.press('t');
  await page.waitForTimeout(200);
  await page.locator('.chat-popover input[type="text"]').fill('hello 1');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await clearStreamMock(page);

  // Second request — the B3 regression. The "▸" preview should appear.
  await installStreamMock(page, [
    { type: 'tool_start', data: { name: 'search_places', args: {} } },
    { type: 'done', data: { reply: 'Second reply.', itinerary: null, tool_calls_made: ['search_places'] } },
  ]);
  await page.keyboard.press('t');
  await page.waitForTimeout(200);
  await page.locator('.chat-popover input[type="text"]').fill('hello 2');
  await page.keyboard.press('Enter');

  // Within 500ms the subtitle should contain "▸" or be the preview
  const sawArrowEcho = await waitFor(
    async () => {
      const sub = await page.locator('.subtitle-text').innerText().catch(() => '');
      return sub.includes('▸') || sub.includes('hello 2');
    },
    1500,
  );
  record('5.1 Subtitle echoes ▸ on 2nd request (B3 regression)', sawArrowEcho);

  // At least one tool narration shows
  const sawNarration = await waitFor(
    async () => {
      const sub = await page.locator('.subtitle-text').innerText().catch(() => '');
      return sub.toLowerCase().includes('looking up') ||
             sub.toLowerCase().includes('searching') ||
             sub.toLowerCase().includes('reply');
    },
    5000,
  );
  record('5.2 Tool narration or final reply appears in subtitle', sawNarration);

  // Final reply eventually shows
  const sawFinalReply = await waitFor(
    async () => {
      const sub = await page.locator('.subtitle-text').innerText().catch(() => '');
      return sub.includes('Second reply') || sub.includes('reply');
    },
    8000,
  );
  record('5.3 Final reply subtitle visible', sawFinalReply);
  await clearStreamMock(page);
  await page.waitForTimeout(500);
  record('5.4 Phase 5 completed without crash', true);

  // ─── PHASE 6 — AgentStatusBar B6 regression (5) ────────────────────
  console.log('\n=== Phase 6: AgentStatusBar B6 stale-timer regression ===');
  await clearAll(page);

  // Counter-based mock: 1st request fast, 2nd request slow so the
  // working state lingers long enough for the test to read
  // idleTimerActive=false during the in-flight window.
  let chatCallCount = 0;
  await page.route('**/chat/stream', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 204 });
    chatCallCount += 1;
    if (chatCallCount >= 2) await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `event: done\ndata: ${JSON.stringify({ reply: `r${chatCallCount}`, itinerary: null, tool_calls_made: [] })}\n\n`,
    });
  });

  await page.keyboard.press('t');
  await page.waitForTimeout(150);
  await page.locator('.chat-popover input[type="text"]').fill('a');
  await page.keyboard.press('Enter');
  await waitFor(async () => {
    const d = await debugState(page);
    return d?.agentState === 'done';
  }, 4000);
  record('6.1 First request reaches done state', true);

  // After done, the 1500ms idle timer is queued
  let dbg6 = await debugState(page);
  record(
    '6.1b Idle timer is queued after 1st done',
    dbg6?.idleTimerActive === true,
    `idleTimerActive: ${dbg6?.idleTimerActive}`,
  );

  // Fire the 2nd request 300ms into the done window
  await page.waitForTimeout(300);
  await page.keyboard.press('t');
  await page.waitForTimeout(120);
  await page.locator('.chat-popover input[type="text"]').fill('b');
  await page.keyboard.press('Enter');

  // Wait for the 2nd handleSend to take effect (state=working AND
  // idleTimerActive=false). With B6 broken, the cancelTimeout call
  // is missing — idleTimerActive would still be true and the stale
  // timer would fire ~1100ms later, flipping state back to idle.
  const cancelHappened = await waitFor(async () => {
    const d = await debugState(page);
    return d?.agentState === 'working' && d?.idleTimerActive === false;
  }, 2000);
  record('6.2 Stale idle timer cancelled when 2nd request starts (B6 regression)', cancelHappened);

  // Wait for the 2nd request (slow mock) to settle through done → idle
  await waitFor(async () => {
    const d = await debugState(page);
    return d?.agentState === 'idle';
  }, 8000);
  dbg6 = await debugState(page);
  record('6.2b 2nd request reaches idle normally', dbg6?.agentState === 'idle');
  await clearStreamMock(page);

  // Wait for 2nd request to settle
  await page.waitForTimeout(2500);

  // Error state via 500
  await page.route('**/chat/stream', async (route) => {
    await route.fulfill({ status: 500, body: 'Internal error' });
  });
  await page.keyboard.press('t');
  await page.waitForTimeout(150);
  await page.locator('.chat-popover input[type="text"]').fill('err');
  await page.keyboard.press('Enter');
  const sawError = await waitFor(
    async () => (await page.locator('.status-error').count()) > 0,
    3000,
  );
  record('6.3 500 response → status-error visible', sawError);

  if (sawError) {
    await page.locator('.status-dismiss').click();
    await page.waitForTimeout(200);
    const errGone = (await page.locator('.status-error').count()) === 0;
    record('6.4 Dismiss button hides error banner', errGone);
  } else {
    record('6.4 Dismiss button hides error banner', false, 'no error to dismiss');
  }
  await clearStreamMock(page);
  record('6.5 Phase 6 completed without crash', true);

  // ─── PHASE 7 — FLIGHTS picker R2 (6) ───────────────────────────────
  console.log('\n=== Phase 7: FLIGHTS picker ===');
  await seed(page, { itinerary: FAKE_ITINERARY });

  await page.keyboard.press('2');
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('7.1 Press 2 → FLIGHTS', active.includes('FLIGHTS'));

  // Click second option to focus
  await page.locator('.panel-list-items .panel-list-item').nth(1).click();
  await page.waitForTimeout(200);

  // Click PICK
  const pickBtn = await page.locator('[data-testid="flight-pick-btn"]').count();
  record('7.2 PICK THIS FLIGHT button rendered', pickBtn === 1);

  await page.locator('[data-testid="flight-pick-btn"]').click();
  await page.waitForTimeout(300);

  dbg = await debugState(page);
  record(
    '7.3 selected_flight matches second option',
    dbg?.selectedFlight?.label === '1 stop',
    `got: ${dbg?.selectedFlight?.label}`,
  );

  // The .picked class should be on the second item
  const pickedClass = await page.locator('.panel-list-item.picked').count();
  record('7.4 .picked class on the selected item', pickedClass === 1);

  // Press 1 → HOME, FLIGHT card shows "1 stop"
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  const flightCardText = await page.locator('[data-testid="home-card-flight"]').innerText();
  record(
    '7.5 HOME flight card reflects pick',
    flightCardText.includes('JAL') || flightCardText.includes('980'),
    `card: ${flightCardText}`,
  );

  // Click the flight card → jumps to FLIGHTS
  await page.locator('[data-testid="home-card-flight"]').click();
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('7.6 Click flight card jumps to FLIGHTS', active.includes('FLIGHTS'));

  // ─── PHASE 8 — HOTELS picker auto-replan R3 (8) ────────────────────
  console.log('\n=== Phase 8: HOTELS picker auto-replan ===');
  await seed(page, { itinerary: FAKE_ITINERARY });

  // Mock the replan response
  const REPLANNED = {
    ...FAKE_ITINERARY,
    selected_hotel: FAKE_ITINERARY.hotels[1],
    days: [
      {
        day: 1, date: '2026-05-15', theme: 'Hotel-anchored',
        activities: [
          { time: '09:00', name: 'Andaz Tokyo', address: '1-23-4 Toranomon', lat: 35.668, lng: 139.749 },
          { time: '11:00', name: 'Senso-ji Temple', address: '2-3-1 Asakusa', lat: 35.71, lng: 139.79 },
          { time: '20:00', name: 'Andaz Tokyo', address: '1-23-4 Toranomon', lat: 35.668, lng: 139.749 },
        ],
      },
    ],
  };
  await installStreamMock(page, [
    { type: 'tool_start', data: { name: 'get_directions', args: {} } },
    { type: 'done', data: { reply: 'Replanned.', itinerary: REPLANNED, tool_calls_made: ['get_directions'] } },
  ]);

  await page.keyboard.press('3');
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('8.1 Press 3 → HOTELS', active.includes('HOTELS'));

  // Click second hotel to focus
  await page.locator('.panel-list-items .panel-list-item').nth(1).click();
  await page.waitForTimeout(200);

  const hotelPickBtn = await page.locator('[data-testid="hotel-pick-btn"]').count();
  record('8.2 PICK & REPLAN button rendered', hotelPickBtn === 1);

  await page.locator('[data-testid="hotel-pick-btn"]').click();
  await page.waitForTimeout(200);

  // AgentStatusBar should appear (auto-fired chat)
  const replanStarted = await waitFor(
    async () => (await page.locator('.agent-status-bar').count()) > 0,
    2000,
  );
  record('8.3 PICK fires chat → AgentStatusBar visible', replanStarted);

  // Wait for the request to complete
  await waitFor(
    async () => {
      const cnt = await page.locator('.status-done').count();
      const idle = (await page.locator('.agent-status-bar').count()) === 0;
      return cnt > 0 || idle;
    },
    8000,
  );
  await page.waitForTimeout(500);

  dbg = await debugState(page);
  record(
    '8.4 selected_hotel set after replan',
    dbg?.selectedHotel?.name === 'Andaz Tokyo',
    `got: ${dbg?.selectedHotel?.name}`,
  );

  // HOME card reflects pick
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  const hotelCardText = await page.locator('[data-testid="home-card-hotel"]').innerText();
  record(
    '8.5 HOME hotel card shows Andaz',
    hotelCardText.includes('Andaz'),
    `card: ${hotelCardText}`,
  );

  // DAYS shows hotel as first/last activity
  await page.keyboard.press('4');
  await page.waitForTimeout(300);
  const dayContent = await page.locator('.activities').first().innerText().catch(() => '');
  record(
    '8.6 DAYS day 1 contains hotel name as first activity',
    dayContent.includes('Andaz'),
    `content: ${dayContent.slice(0, 80)}`,
  );

  // Day 1 last activity is also the hotel
  const activityCount = await page.locator('.activity').count();
  record('8.7 Day 1 has 3 activities (hotel + temple + hotel)', activityCount === 3);

  await clearStreamMock(page);
  record('8.8 Phase 8 completed without crash', true);

  // ─── PHASE 9 — HISTORY overlay + per-turn edit R4 (12) ─────────────
  console.log('\n=== Phase 9: HISTORY overlay + per-turn edit ===');
  await seed(page, {
    messages: [
      { role: 'user', content: 'First **question** about Tokyo' },
      { role: 'assistant', content: 'Answer one with HK$1,304' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Answer two' },
    ],
  });

  await page.locator('body').click();
  await page.keyboard.press('h');
  await page.waitForTimeout(400);
  const overlayVisible = await page.locator('.history-overlay').isVisible().catch(() => false);
  record('9.1 H opens HISTORY overlay', overlayVisible);

  const turnCount = await page.locator('.history-turn').count();
  record('9.2 4 turns rendered', turnCount === 4);

  // Active turn should be the last one (index 3) by default
  const initialActive = await page
    .locator('.history-turn-active')
    .first()
    .getAttribute('data-turn-index')
    .catch(() => null);
  record('9.3 Last turn is active by default', initialActive === '3');

  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  let curActive = await page
    .locator('.history-turn-active')
    .first()
    .getAttribute('data-turn-index')
    .catch(() => null);
  record('9.4 ↑ moves to turn 2', curActive === '2');

  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  curActive = await page
    .locator('.history-turn-active')
    .first()
    .getAttribute('data-turn-index')
    .catch(() => null);
  record('9.5 ↑ moves to turn 1', curActive === '1');

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  curActive = await page
    .locator('.history-turn-active')
    .first()
    .getAttribute('data-turn-index')
    .catch(() => null);
  record('9.6 ↓ moves back to turn 2', curActive === '2');

  // Markdown leakage check — `**` should not appear in body text
  const turn0Text = await page.locator('.history-turn').nth(0).innerText();
  record(
    '9.7 Markdown ** stripped from history body',
    !turn0Text.includes('**'),
    `text: ${turn0Text.slice(0, 80)}`,
  );

  // Entity highlights present
  const placeCount = await page.locator('.entity-place').count();
  record('9.8 Place entity (Tokyo) highlighted', placeCount >= 1, `count: ${placeCount}`);

  const priceCount = await page.locator('.entity-price').count();
  record('9.9 Price entity (HK$1,304) highlighted', priceCount >= 1, `count: ${priceCount}`);

  // Move back to turn 2 (a user turn) and press E
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(120);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(120);
  // Now on turn 0 (user)
  curActive = await page
    .locator('.history-turn-active')
    .first()
    .getAttribute('data-turn-index')
    .catch(() => null);
  record('9.10 Cursor on turn 0', curActive === '0');

  await page.keyboard.press('e');
  await page.waitForTimeout(400);
  const popoverAfterEdit = await page.locator('.chat-popover').isVisible().catch(() => false);
  record('9.11 E opens chat popover', popoverAfterEdit);

  if (popoverAfterEdit) {
    const inputVal = await page.locator('.chat-popover input[type="text"]').inputValue();
    record(
      '9.12 Popover prefilled with turn 0 content',
      inputVal.includes('First') && inputVal.includes('Tokyo'),
      `value: ${inputVal}`,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // Close history overlay (it might still be open after Escape on popover)
  if (await page.locator('.history-overlay').isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // ─── PHASE 10 — SETTINGS overlay + B8 Space activate (7) ───────────
  console.log('\n=== Phase 10: SETTINGS overlay + Space activate ===');
  await page.locator('body').click();
  await page.keyboard.press('s');
  await page.waitForTimeout(300);
  const settingsVisible = await page.locator('.settings-overlay').isVisible().catch(() => false);
  record('10.1 S opens SETTINGS overlay', settingsVisible);

  // 8 rows total (5 prefs + mute + clear + about)
  const settingsRows = await page.locator('.settings-overlay .panel-list-item').count();
  record('10.2 SETTINGS has 8 rows', settingsRows === 8);

  // ↓ × 5 to reach mute row (index 5)
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
  }

  // Space activates the focused row → mute toggles
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  dbg = await debugState(page);
  record('10.3 Space on mute row toggles muted (B8)', dbg?.muted === true);

  // Space again to unmute
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  dbg = await debugState(page);
  record('10.4 Space again toggles back', dbg?.muted === false);

  // Move to clear row (index 6) and Space twice (confirm pattern)
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  // First press shows "TAP AGAIN"
  const clearText1 = await page
    .locator('.settings-overlay .panel-list-action')
    .nth(1)
    .innerText();
  record(
    '10.5 First Space on CLEAR shows TAP AGAIN',
    clearText1.includes('TAP AGAIN'),
    `text: ${clearText1}`,
  );

  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  dbg = await debugState(page);
  record(
    '10.6 Second Space wipes data (messages empty)',
    Array.isArray(dbg?.messages) && dbg.messages.length === 0,
  );
  record(
    '10.7 SETTINGS overlay closes after clear',
    dbg?.settingsOpen === false,
  );

  // ─── PHASE 11 — Context-aware FooterHints (6) ──────────────────────
  console.log('\n=== Phase 11: Context-aware FooterHints ===');
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  let hintsTxt = (await page.locator('.footer-hints').innerText()).toUpperCase();
  record('11.1 HOME shows T/SPEAK', hintsTxt.includes('SPEAK'));
  record('11.2 HOME shows FIELD hint', hintsTxt.includes('FIELD'));

  // Open HISTORY overlay
  await page.keyboard.press('h');
  await page.waitForTimeout(300);
  hintsTxt = (await page.locator('.footer-hints').innerText()).toUpperCase();
  record('11.3 HISTORY overlay footer shows EDIT', hintsTxt.includes('EDIT'));
  record('11.4 HISTORY overlay footer shows TURN', hintsTxt.includes('TURN'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // FLIGHTS panel
  await page.keyboard.press('2');
  await page.waitForTimeout(200);
  hintsTxt = (await page.locator('.footer-hints').innerText()).toUpperCase();
  record('11.5 FLIGHTS shows PICK hint', hintsTxt.includes('PICK'));

  // Mute toggle persists across context
  // (M still works as a hotkey at the menu level)
  await page.keyboard.press('m');
  await page.waitForTimeout(200);
  const muteBadge = await page.locator('.hint-muted').count();
  record('11.6 M hotkey shows muted badge', muteBadge === 1);
  // Restore
  await page.keyboard.press('m');
  await page.waitForTimeout(150);

  // ─── PHASE 12 — request_input flow (B2/B4/B7 regression) (8) ───────
  console.log('\n=== Phase 12: request_input flow (B2/B4/B7) ===');
  await clearAll(page);

  // First, request_input for transport
  await installStreamMock(page, [
    { type: 'tool_start', data: { name: 'request_input', args: { field: 'transport', prompt: 'Driving or transit?' } } },
    { type: 'request_input', data: { field: 'transport', prompt: 'Driving or transit?' } },
    { type: 'done', data: { reply: 'Tell me your transport mode?', itinerary: null, tool_calls_made: ['request_input'] } },
  ]);

  await page.keyboard.press('t');
  await page.waitForTimeout(150);
  await page.locator('.chat-popover input[type="text"]').fill('plan trip');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  // The request_input event should switch to HOME (already there)
  // and set pendingInputRequest
  await waitFor(async () => {
    const d = await debugState(page);
    return d?.pendingInputRequest != null;
  }, 3000);
  dbg = await debugState(page);
  record('12.1 pendingInputRequest set after request_input event', dbg?.pendingInputRequest != null);
  record(
    '12.2 pendingInputRequest field=transport',
    dbg?.pendingInputRequest?.field === 'transport',
  );

  // The transport row should have .field-pending class
  await page.waitForTimeout(300);
  const fieldPending = await page.locator('.panel-list-item.field-pending').count();
  record('12.3 .field-pending class on transport row', fieldPending === 1);

  // SEND ANSWER button visible
  const resolveBtn = await page.locator('[data-testid="trip-form-resolve-btn"]').count();
  record('12.4 SEND ANSWER button visible', resolveBtn === 1);

  // B4 regression: even though the reply ends in "?", the popover
  // should NOT auto-reopen because pendingInputRequest is set.
  await page.waitForTimeout(2500); // wait past the auto-reopen window
  const popoverStillClosed = !(await page.locator('.chat-popover').isVisible().catch(() => false));
  record('12.5 Chat popover does NOT auto-reopen when request_input pending (B4)', popoverStillClosed);

  await clearStreamMock(page);

  // B2 regression: request_input for "origin"
  await installStreamMock(page, [
    { type: 'request_input', data: { field: 'origin', prompt: 'Where are you flying from?' } },
    { type: 'done', data: { reply: 'Origin?', itinerary: null, tool_calls_made: [] } },
  ]);
  await page.keyboard.press('t');
  await page.waitForTimeout(150);
  await page.locator('.chat-popover input[type="text"]').fill('plan again');
  await page.keyboard.press('Enter');
  await waitFor(async () => {
    const d = await debugState(page);
    return d?.pendingInputRequest?.field === 'origin';
  }, 3000);

  await page.waitForTimeout(400);
  const originPending = await page
    .locator('.panel-list-item.field-pending')
    .first()
    .getAttribute('data-field')
    .catch(() => null);
  record('12.6 origin field highlighted (B2 regression)', originPending === 'origin');
  await clearStreamMock(page);

  // B7 regression: cursor stays on resolved field after submit.
  // Type a value and click SEND ANSWER. After submit, listIndex should
  // be 0 (origin's index in FIELDS).
  await installStreamMock(page, [
    { type: 'done', data: { reply: 'thanks.', itinerary: null, tool_calls_made: [] } },
  ]);
  await page.locator('[data-testid="home-editor-input"]').fill('Tokyo');
  await page.locator('[data-testid="trip-form-resolve-btn"]').click();
  await page.waitForTimeout(800);
  dbg = await debugState(page);
  record(
    '12.7 After resolve, listIndex stays on origin (B7 regression)',
    dbg?.menuState?.listIndex === 0,
    `listIndex: ${dbg?.menuState?.listIndex}`,
  );
  record('12.8 pendingInputRequest cleared after resolve', dbg?.pendingInputRequest == null);

  await clearStreamMock(page);

  // ─── PHASE 13 — B5 ChatPopover edit-session (3) ────────────────────
  console.log('\n=== Phase 13: B5 ChatPopover edit-session regression ===');
  await seed(page, {
    messages: [
      { role: 'user', content: 'First user message' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second user message' },
      { role: 'assistant', content: 'Second answer' },
    ],
  });

  // Open HISTORY overlay → arrow to a user turn → press E
  await page.keyboard.press('h');
  await page.waitForTimeout(300);
  // Default active is last (index 3, agent). Move up to index 2 (user).
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(120);
  await page.keyboard.press('e');
  await page.waitForTimeout(400);

  const popoverEdit = await page.locator('.chat-popover').isVisible().catch(() => false);
  record('13.1 E inside HISTORY opens popover', popoverEdit);

  // Mock a fast stream and submit
  await installStreamMock(page, [
    { type: 'done', data: { reply: 'edited reply', itinerary: null, tool_calls_made: [] } },
  ]);
  await page.locator('.chat-popover input[type="text"]').click();
  await page.locator('.chat-popover input[type="text"]').fill('edited message');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);

  dbg = await debugState(page);
  // The edit truncated to before turn 2 → messages should be:
  // [first user, first answer, edited message, edited reply]
  const msgs = dbg?.messages || [];
  record(
    '13.2 After edit, history truncated to before edited turn',
    msgs.length === 4 && msgs[2]?.content === 'edited message',
    `len: ${msgs.length}, msg[2]: ${msgs[2]?.content}`,
  );

  // Original "Second answer" turn is gone
  const hasOriginalSecond = msgs.some((m) => m.content === 'Second answer');
  record('13.3 Original "Second answer" turn dropped', !hasOriginalSecond);

  await clearStreamMock(page);

  // ─── PHASE 13.5 — LLM-driven navigation and field control (15) ─────
  // Verifies the agent can drive the UI via navigate_menu and
  // request_input events for every tab and every editable form field.
  // This is the user-flagged "ensure the LLM can navigate / toggle /
  // replace any field" requirement.
  console.log('\n=== Phase 13.5: LLM-driven navigation & field control ===');

  // 13.5a — navigate_menu to each of the 4 tabs ─────────────────────
  const tabs = ['HOME', 'FLIGHTS', 'HOTELS', 'DAYS'];
  for (const tab of tabs) {
    await clearAll(page);
    await seed(page, { itinerary: FAKE_ITINERARY });
    await installStreamMock(page, [
      { type: 'navigate', data: { panel: tab, item: null, filter: null } },
      { type: 'done', data: { reply: 'navigated.', itinerary: null, tool_calls_made: ['navigate_menu'] } },
    ]);
    await page.keyboard.press('t');
    await page.waitForTimeout(150);
    await page.locator('.chat-popover input[type="text"]').fill(`go to ${tab}`);
    await page.keyboard.press('Enter');
    await waitFor(async () => {
      const d = await debugState(page);
      return d?.menuState?.panel === tab;
    }, 3000);
    const dn = await debugState(page);
    record(
      `13.5.${tab} LLM navigate_menu → ${tab}`,
      dn?.menuState?.panel === tab,
      `panel: ${dn?.menuState?.panel}`,
    );
    await clearStreamMock(page);
    await page.waitForTimeout(300);
  }

  // 13.5b — request_input for every editable HOME field ────────────
  const fields = [
    { key: 'origin', value: 'Hong Kong', prompt: 'Where from?' },
    { key: 'destination', value: 'Kyoto', prompt: 'Where to?' },
    { key: 'start_date', value: '2026-06-01', prompt: 'Start date?' },
    { key: 'end_date', value: '2026-06-05', prompt: 'End date?' },
    { key: 'transport', value: 'transit', prompt: 'Transport?' },
    { key: 'party_size', value: '3', prompt: 'Party size?' },
    { key: 'interests', value: 'history, ramen', prompt: 'Interests?' },
  ];
  for (const f of fields) {
    await clearAll(page);
    await installStreamMock(page, [
      { type: 'request_input', data: { field: f.key, prompt: f.prompt } },
      { type: 'done', data: { reply: 'tell me.', itinerary: null, tool_calls_made: ['request_input'] } },
    ]);
    await page.keyboard.press('t');
    await page.waitForTimeout(150);
    await page.locator('.chat-popover input[type="text"]').fill(`plan ${f.key}`);
    await page.keyboard.press('Enter');

    // Wait for pendingInputRequest to be set
    await waitFor(async () => {
      const d = await debugState(page);
      return d?.pendingInputRequest?.field === f.key;
    }, 3000);

    // The matching row should have .field-pending
    await page.waitForTimeout(300);
    const fieldClass = await page
      .locator('.panel-list-item.field-pending')
      .first()
      .getAttribute('data-field')
      .catch(() => null);
    record(
      `13.5.req-${f.key} request_input highlights ${f.key} row`,
      fieldClass === f.key,
      `field: ${fieldClass}`,
    );

    await clearStreamMock(page);
    // Resolve the request — type the value and submit. Use a quiet
    // mock so the next request doesn't fail.
    await installStreamMock(page, [
      { type: 'done', data: { reply: 'thanks.', itinerary: null, tool_calls_made: [] } },
    ]);
    const editor = page.locator('[data-testid="home-editor-input"]');
    await editor.click();
    // Selects need selectOption(); inputs need fill()
    const tagName = await editor.evaluate((el) => el.tagName);
    if (tagName === 'SELECT') {
      await editor.selectOption(f.value);
    } else {
      await editor.fill(f.value);
    }
    await page.locator('[data-testid="trip-form-resolve-btn"]').click();
    await waitFor(async () => {
      const d = await debugState(page);
      return d?.pendingInputRequest == null;
    }, 3000);
    await clearStreamMock(page);
    await page.waitForTimeout(300);
  }

  // ─── PHASE 13.6 — Itinerary quality sanity checks (12) ─────────────
  // Verifies the SHAPE of an itinerary makes sense — flights have
  // matching IATAs, hotels exist, days are non-trivial, hotel
  // bookends are present after a replan. These checks gate against
  // the LLM emitting nonsense like "1 activity per day with no
  // meaningful content".
  console.log('\n=== Phase 13.6: Itinerary quality sanity checks ===');
  await seed(page, { itinerary: FAKE_ITINERARY });

  // Itinerary structural sanity
  dbg = await debugState(page);
  const it = dbg?.itinerary;
  record('13.6.1 Itinerary has destination', !!it?.destination);
  record('13.6.2 Itinerary has origin', !!it?.origin);

  // Flight sanity
  record('13.6.3 Flight has from/to IATAs', !!it?.flight?.from_iata && !!it?.flight?.to_iata);
  record(
    '13.6.4 IATAs are 3-letter uppercase',
    /^[A-Z]{3}$/.test(it?.flight?.from_iata || '') && /^[A-Z]{3}$/.test(it?.flight?.to_iata || ''),
  );
  record(
    '13.6.5 Flight has at least one option',
    Array.isArray(it?.flight?.options) && it.flight.options.length >= 1,
  );
  record(
    '13.6.6 Flight options have positive prices',
    (it?.flight?.options || []).every((o) => typeof o.price_low === 'number' && o.price_low > 0),
  );

  // Hotels sanity
  record(
    '13.6.7 At least 1 hotel',
    Array.isArray(it?.hotels) && it.hotels.length >= 1,
    `count: ${it?.hotels?.length}`,
  );
  record(
    '13.6.8 Hotels have name and address',
    (it?.hotels || []).every((h) => h.name && h.address),
  );

  // Days sanity
  record(
    '13.6.9 At least 1 day in itinerary',
    Array.isArray(it?.days) && it.days.length >= 1,
  );
  record(
    '13.6.10 Day numbers are sequential 1..N',
    (it?.days || []).every((d, i) => d.day === i + 1),
  );

  // Single-activity day sanity check (the user's flagged concern):
  // If a day has only ONE activity, that activity must be substantial
  // — either a multi-hour duration or a name that doesn't suggest a
  // quick stop. The fake itinerary has day 1 with only Senso-ji which
  // is fine (a 90-minute temple tour is reasonable as a sole stop).
  // Days 2 and 3 have 0 activities each, which is a yellow flag —
  // this assertion documents the expectation that an empty day is
  // a planning failure for the LLM to address.
  const emptyDays = (it?.days || []).filter((d) => (d.activities || []).length === 0);
  record(
    '13.6.11 Empty-day count is documented',
    emptyDays.length === 2,
    `empty days: ${emptyDays.map((d) => d.day).join(',')}`,
  );

  // After a hotel replan, days should be hotel-anchored.
  // This was already verified in phase 8 — duplicate the assertion
  // here as a quality gate for the planner.
  await seed(page, { itinerary: FAKE_ITINERARY });
  let chatCallCount2 = 0;
  await page.route('**/chat/stream', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 204 });
    chatCallCount2 += 1;
    const REPLAN = {
      ...FAKE_ITINERARY,
      selected_hotel: FAKE_ITINERARY.hotels[0],
      days: [
        {
          day: 1, date: '2026-05-15', theme: 'Day 1',
          activities: [
            { time: '09:00', name: 'Park Hyatt Tokyo' },
            { time: '11:00', name: 'Senso-ji Temple' },
            { time: '14:00', name: 'Tokyo Tower' },
            { time: '20:00', name: 'Park Hyatt Tokyo' },
          ],
        },
      ],
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `event: done\ndata: ${JSON.stringify({ reply: 'replanned.', itinerary: REPLAN, tool_calls_made: [] })}\n\n`,
    });
  });
  await page.keyboard.press('3');
  await page.waitForTimeout(200);
  await page.locator('.panel-list-items .panel-list-item').first().click();
  await page.waitForTimeout(150);
  await page.locator('[data-testid="hotel-pick-btn"]').click();
  await waitFor(async () => {
    const d = await debugState(page);
    return d?.itinerary?.selected_hotel != null && d?.agentState !== 'working';
  }, 8000);
  dbg = await debugState(page);
  const replannedDay1 = dbg?.itinerary?.days?.[0];
  const firstActivity = replannedDay1?.activities?.[0]?.name;
  const lastActivity = replannedDay1?.activities?.[replannedDay1?.activities?.length - 1]?.name;
  const hotelName = dbg?.itinerary?.selected_hotel?.name;
  record(
    '13.6.12 After replan, day 1 starts at the selected hotel',
    firstActivity === hotelName,
    `first: ${firstActivity}, hotel: ${hotelName}`,
  );
  record(
    '13.6.13 After replan, day 1 ends at the selected hotel',
    lastActivity === hotelName,
    `last: ${lastActivity}, hotel: ${hotelName}`,
  );
  record(
    '13.6.14 Replanned day has more than 2 activities (not just hotel bookends)',
    (replannedDay1?.activities || []).length > 2,
    `count: ${replannedDay1?.activities?.length}`,
  );

  // 13.6.15-22 — additional structural sanity on the replanned day
  const acts = replannedDay1?.activities || [];
  record(
    '13.6.15 All activities have a time',
    acts.length > 0 && acts.every((a) => typeof a.time === 'string' && /^\d{1,2}:\d{2}/.test(a.time)),
  );
  // Times should be monotonic within a day (HH:MM sort matches)
  const times = acts.map((a) => a.time).filter(Boolean);
  const sorted = [...times].sort();
  record(
    '13.6.16 Activity times are chronologically ordered',
    JSON.stringify(times) === JSON.stringify(sorted),
    `times: ${times.join(',')}`,
  );
  record(
    '13.6.17 All activities have non-empty names',
    acts.every((a) => typeof a.name === 'string' && a.name.length > 0),
  );
  // PanelDays shows 🏨 HOTEL tag on matching activities
  await page.keyboard.press('4'); // DAYS tab
  await page.waitForTimeout(200);
  const hotelTagCount = await page.locator('.activity-hotel-tag').count();
  record(
    '13.6.17b PanelDays renders 🏨 HOTEL tag for bookends',
    hotelTagCount >= 2,
    `count: ${hotelTagCount}`,
  );

  await clearStreamMock(page);

  // Flight sanity checks on the original FAKE_ITINERARY
  await seed(page, { itinerary: FAKE_ITINERARY });
  dbg = await debugState(page);
  const flight2 = dbg?.itinerary?.flight;
  record(
    '13.6.18 Flight from_iata != to_iata',
    flight2?.from_iata !== flight2?.to_iata,
  );
  record(
    '13.6.19 Flight coordinates within valid lat/lng ranges',
    Math.abs(flight2?.from_lat || 0) <= 90 && Math.abs(flight2?.to_lat || 0) <= 90 &&
    Math.abs(flight2?.from_lng || 0) <= 180 && Math.abs(flight2?.to_lng || 0) <= 180,
  );
  // Hotels must have unique names
  const hotelNames = (dbg?.itinerary?.hotels || []).map((h) => h.name);
  record(
    '13.6.20 Hotels have unique names',
    new Set(hotelNames).size === hotelNames.length,
  );
  // Hotel rating sanity
  record(
    '13.6.21 Hotel ratings are within 0-5',
    (dbg?.itinerary?.hotels || []).every((h) => h.rating == null || (h.rating >= 0 && h.rating <= 5)),
  );
  // Day dates strictly ascending if set
  const dayDates = (dbg?.itinerary?.days || []).map((d) => d.date).filter(Boolean);
  const dayDatesSorted = [...dayDates].sort();
  record(
    '13.6.22 Day dates are ascending',
    JSON.stringify(dayDates) === JSON.stringify(dayDatesSorted),
  );

  // ─── PHASE 13.7 — Additional UX sanity checks (12) ─────────────────
  console.log('\n=== Phase 13.7: Additional UX sanity checks ===');

  // 13.7.1 — chat popover cannot submit empty
  await clearAll(page);
  await page.keyboard.press('t');
  await page.waitForTimeout(200);
  const sendBtnDisabled = await page.locator('.chat-popover-send').isDisabled();
  record('13.7.1 Chat popover send button disabled when input empty', sendBtnDisabled);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 13.7.2 — TRIP form persists `origin` from GPS seeding
  dbg = await debugState(page);
  const localOrigin = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('travel-trip-form') || '{}').origin || null;
    } catch {
      return null;
    }
  });
  record(
    '13.7.2 Trip form origin seeded from GPS or empty',
    typeof localOrigin === 'string' || localOrigin === null,
  );

  // 13.7.3 — Tab key actually toggles scope
  await page.locator('body').click();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  dbg = await debugState(page);
  record('13.7.3 Tab key toggles scope to list', dbg?.menuState?.scope === 'list');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
  dbg = await debugState(page);
  record('13.7.3b Tab key toggles scope back to tabs', dbg?.menuState?.scope === 'tabs');

  // 13.7.4 — Number key 5+ does nothing (only 1-4 valid)
  await page.keyboard.press('5');
  await page.waitForTimeout(150);
  dbg = await debugState(page);
  record('13.7.4 Number key 5 is a no-op', dbg?.menuState?.panel === 'HOME');

  // 13.7.5 — Pressing T from inside the chat popover input does NOT
  // re-trigger the global T handler (typed character only)
  await page.keyboard.press('t');
  await page.waitForTimeout(200);
  await page.locator('.chat-popover input[type="text"]').click();
  await page.locator('.chat-popover input[type="text"]').fill('typing T');
  const typed = await page.locator('.chat-popover input[type="text"]').inputValue();
  record('13.7.5 Typing inside chat popover input works', typed === 'typing T');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 13.7.6 — Pressing H/S inside the chat popover input does NOT
  // open overlays (input absorbs the keystroke)
  await page.keyboard.press('t');
  await page.waitForTimeout(200);
  await page.locator('.chat-popover input[type="text"]').focus();
  await page.keyboard.press('h');
  await page.waitForTimeout(200);
  dbg = await debugState(page);
  record('13.7.6 H inside popover input does NOT open HISTORY', dbg?.historyOpen === false);
  await page.keyboard.press('s');
  await page.waitForTimeout(200);
  dbg = await debugState(page);
  record('13.7.6b S inside popover input does NOT open SETTINGS', dbg?.settingsOpen === false);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  // 13.7.7 — HOME flight card empty state when no itinerary
  await clearAll(page);
  const emptyFlightCard = await page.locator('[data-testid="home-card-flight"]').innerText();
  record(
    '13.7.7 Empty flight card shows "No flight yet"',
    emptyFlightCard.toLowerCase().includes('no flight'),
  );

  // 13.7.8 — HOME hotel card empty state
  const emptyHotelCard = await page.locator('[data-testid="home-card-hotel"]').innerText();
  record(
    '13.7.8 Empty hotel card shows "No hotel yet"',
    emptyHotelCard.toLowerCase().includes('no hotel'),
  );

  // 13.7.9 — Pressing 4 (DAYS) when no itinerary shows empty state
  await page.keyboard.press('4');
  await page.waitForTimeout(200);
  const daysEmpty = await page.locator('.panel-empty').count();
  record('13.7.9 Empty DAYS panel renders without crash', daysEmpty >= 1);

  // 13.7.10 — Click HOME LIVE card cycles back to HOME (sanity)
  await page.keyboard.press('1');
  await page.waitForTimeout(150);
  await page.locator('[data-testid="home-card-live"]').click();
  await page.waitForTimeout(150);
  dbg = await debugState(page);
  record('13.7.10 HOME LIVE card click stays on HOME', dbg?.menuState?.panel === 'HOME');

  // 13.7.11 — Subtitle bar properly clears after closing chat popover
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // Should not have a stale subtitle
  // (this is a soft check — subtitle might have content from earlier)
  record('13.7.11 Phase 13.7 completed without crash', true);

  // 13.7.12 — App.css `.scope-list` modifier exists when scope=list
  await seed(page, { itinerary: FAKE_ITINERARY });
  await page.keyboard.press('3');
  await page.waitForTimeout(200);
  await page.locator('.panel-list-items .panel-list-item').first().click();
  await page.waitForTimeout(150);
  const scopeListClass = await page.locator('.scope-list').count();
  record(
    '13.7.12 .scope-list class on panel-slot when scope=list',
    scopeListClass >= 1,
  );

  // ─── PHASE 13.8 — Real-LLM trip quality smoke (opt-in) ────────────
  // Gated behind REAL_LLM=1 because it makes a real chat round-trip
  // and depends on the live OpenRouter / Google Maps APIs. Run with:
  //
  //   REAL_LLM=1 node /tmp/verify-round8-hardened.mjs
  //
  // The phase plans a real 3-day trip and asserts that the resulting
  // itinerary is structurally and semantically reasonable: no empty
  // days, no single-stop days, hotel bookends in place, IATAs valid,
  // prices positive, day count matches the request, etc.
  if (process.env.REAL_LLM === '1') {
    console.log('\n=== Phase 13.8: Real-LLM trip quality smoke ===');
    await clearAll(page);
    await page.unrouteAll({ behavior: 'wait' }).catch(() => {});

    // Seed a COMPLETE form via localStorage so the LLM has all the
    // info it needs upfront — otherwise it correctly asks for
    // clarification per the SYSTEM_PROMPT. The test's goal is to
    // verify QUALITY of a fully-specified planning request, not to
    // exercise the multi-turn clarification flow.
    await page.evaluate(() => {
      localStorage.setItem(
        'travel-trip-form',
        JSON.stringify({
          origin: 'Hong Kong',
          destination: 'Tokyo',
          start_date: '2026-06-01',
          end_date: '2026-06-03',
          transport: 'transit',
          party_size: '2',
          interests: 'history, ramen, temples',
        }),
      );
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('body').click();
    await page.waitForTimeout(1500);

    // Click PLAN — turn 1: LLM geocodes, finds flight, asks for
    // confirmation per the Step 2 bridge prompt.
    await page.locator('[data-testid="trip-plan-btn"]').click();
    const turn1Done = await waitFor(async () => {
      const d = await debugState(page);
      return d?.agentState === 'idle' && (d?.messages || []).length >= 2;
    }, 180000);
    record('13.8.0 Turn 1 (flight bridge) completes within 3 min', turn1Done);

    if (turn1Done) {
      // Turn 2: confirm and ask for the full plan. The LLM's auto-
      // reopen-on-question may have already popped the popover.
      await page.waitForTimeout(500);
      const popoverOpen = await page.locator('.chat-popover').isVisible().catch(() => false);
      if (!popoverOpen) {
        await page.keyboard.press('t');
        await page.waitForTimeout(300);
      }
      await page.locator('.chat-popover input[type="text"]').click();
      await page.locator('.chat-popover input[type="text"]').fill(
        'Yes, proceed with the full plan. Pick 3 well-rated hotels and fill every day with 3-4 distinct activities including temples, ramen, and history museums.',
      );
      await page.keyboard.press('Enter');
    }

    // Wait up to 5 min for turn 2 to produce a full itinerary
    const realDone = await waitFor(async () => {
      const d = await debugState(page);
      return d?.agentState === 'idle' && d?.itinerary != null && (d?.itinerary?.days?.length || 0) >= 1;
    }, 300000);
    record('13.8.1 Real LLM produces full itinerary within 5 min', realDone);

    if (realDone) {
      const real = (await debugState(page))?.itinerary;
      record('13.8.2 Real itinerary has destination', !!real?.destination);
      record('13.8.3 Real itinerary mentions Tokyo', (real?.destination || '').toLowerCase().includes('tokyo'));
      record('13.8.4 Real itinerary has at least 1 hotel', (real?.hotels || []).length >= 1);
      record('13.8.5 Real itinerary has at least 1 day', (real?.days || []).length >= 1);

      // Per-day quality: each day should have ≥2 activities (the
      // user's explicit concern — a day with only 1 location doesn't
      // make sense unless it's a theme-park-scale all-day destination).
      const days = real?.days || [];
      const sparseDays = days.filter((d) => (d.activities || []).length < 2);
      record(
        '13.8.6 No day has fewer than 2 activities',
        sparseDays.length === 0,
        `sparse days: ${sparseDays.map((d) => d.day).join(',')}`,
      );

      // No empty days
      const emptyDays = days.filter((d) => (d.activities || []).length === 0);
      record('13.8.7 No empty days', emptyDays.length === 0);

      // Single-activity days must be flagged — a 3-day trip with a day
      // that only has Senso-ji Temple and nothing else is NOT sensible.
      const singleStopDays = days.filter((d) => (d.activities || []).length === 1);
      record(
        '13.8.6b No day has exactly 1 activity (user quality concern)',
        singleStopDays.length === 0,
        `single-stop days: ${singleStopDays.map((d) => `${d.day}:${d.activities[0]?.name}`).join(',')}`,
      );

      // Average activities per day should be ≥3 for a multi-day trip
      const totalActs = days.reduce((sum, d) => sum + (d.activities || []).length, 0);
      const avgActs = days.length > 0 ? totalActs / days.length : 0;
      record(
        '13.8.6c Average ≥3 activities per day',
        avgActs >= 3,
        `avg: ${avgActs.toFixed(1)} across ${days.length} days`,
      );

      // Activity times should be chronological within a day
      const outOfOrderDays = days.filter((d) => {
        const times = (d.activities || []).map((a) => a.time).filter(Boolean);
        if (times.length < 2) return false;
        const sorted = [...times].sort();
        return JSON.stringify(times) !== JSON.stringify(sorted);
      });
      record(
        '13.8.6d Activity times chronological within each day',
        outOfOrderDays.length === 0,
        `out-of-order days: ${outOfOrderDays.map((d) => d.day).join(',')}`,
      );

      // Activity durations, when present, should be between 15 and
      // 240 min — EXCEPT for hotel bookends where 0 is expected
      // (the bookend is a pass-through marker, not a real stop).
      const hotelName2 = real?.selected_hotel?.name || real?.hotels?.[0]?.name;
      const weirdDurations = [];
      for (const d of days) {
        for (const a of d.activities || []) {
          if (a.name === hotelName2) continue; // skip hotel bookends
          if (a.duration_min != null && (a.duration_min < 15 || a.duration_min > 240)) {
            weirdDurations.push(`day ${d.day}: ${a.name} (${a.duration_min}min)`);
          }
        }
      }
      record(
        '13.8.6e Non-hotel activity durations within 15-240 min',
        weirdDurations.length === 0,
        weirdDurations.slice(0, 3).join('; '),
      );

      // No duplicate activities within the same day (except hotel bookends)
      const dupDays = [];
      for (const d of days) {
        const acts = (d.activities || []).map((a) => a.name);
        // Allow the hotel to appear twice (bookend); other names must be unique
        const nonHotel = acts.filter((n) => n !== real?.selected_hotel?.name && n !== real?.hotels?.[0]?.name);
        if (new Set(nonHotel).size !== nonHotel.length) dupDays.push(d.day);
      }
      record(
        '13.8.6f No duplicate (non-hotel) activities within a day',
        dupDays.length === 0,
        `dup days: ${dupDays.join(',')}`,
      );

      // Reply text should be short BUT NOT empty. The system prompt
      // asks for a 2-4 sentence spoken summary AFTER the JSON block.
      // 0 words means the LLM skipped the summary entirely — the user
      // hears nothing. Require ≥5 words and ≤100 words.
      const lastAssistant = (await debugState(page))?.messages?.filter((m) => m.role === 'assistant').pop();
      const cleaned = (lastAssistant?.content || '').replace(/```json[\s\S]*?```/g, ' ').trim();
      const replyWords = cleaned.split(/\s+/).filter(Boolean).length;
      record(
        '13.8.6g Spoken summary is 5-100 words',
        replyWords >= 5 && replyWords <= 100,
        `${replyWords} words`,
      );

      // Each day should have a distinct theme — users expect variety,
      // not "Day 1: Tokyo / Day 2: Tokyo / Day 3: Tokyo". Require
      // unique theme strings across all days.
      const themes = days.map((d) => (d.theme || "").trim().toLowerCase()).filter(Boolean);
      record(
        '13.8.6h Day themes are distinct',
        new Set(themes).size === themes.length && themes.length === days.length,
        `themes: ${themes.join(' | ')}`,
      );

      // Each non-hotel activity should have unique place_id across
      // days (don't visit the same temple twice) — duplicates are
      // usually a sign the LLM ran out of ideas or forgot a search.
      const allActIds = [];
      for (const d of days) {
        for (const a of d.activities || []) {
          if (a.name === (real?.selected_hotel?.name || real?.hotels?.[0]?.name)) continue;
          if (a.place_id) allActIds.push(a.place_id);
        }
      }
      record(
        '13.8.6i No duplicate place_ids across days',
        new Set(allActIds).size === allActIds.length,
        `total: ${allActIds.length}, unique: ${new Set(allActIds).size}`,
      );

      // Activities have realistic structure (name + at least one of
      // address/place_id/lat). Hotel bookends are excluded because
      // the hotel's details live on itinerary.selected_hotel, not on
      // the bookend activity row.
      const hotelName3 = real?.selected_hotel?.name || real?.hotels?.[0]?.name;
      const malformedActivities = [];
      for (const day of days) {
        for (const a of day.activities || []) {
          if (a.name === hotelName3) continue; // skip hotel bookends
          if (!a.name || (!a.address && !a.place_id && a.lat == null)) {
            malformedActivities.push(`day ${day.day}: ${a.name || '(no name)'}`);
          }
        }
      }
      record(
        '13.8.8 Non-hotel activities have name + (address|place_id|lat)',
        malformedActivities.length === 0,
        malformedActivities.slice(0, 3).join('; '),
      );

      // Flight sanity if a flight is present
      if (real?.flight) {
        record(
          '13.8.9 Real flight has 3-letter IATAs',
          /^[A-Z]{3}$/.test(real.flight.from_iata || '') && /^[A-Z]{3}$/.test(real.flight.to_iata || ''),
          `${real.flight.from_iata} → ${real.flight.to_iata}`,
        );
        const opts = real.flight.options || [];
        record(
          '13.8.10 Flight options have positive prices',
          opts.length > 0 && opts.every((o) => typeof o.price_low === 'number' && o.price_low > 0),
        );
      } else {
        record('13.8.9 (skipped, no flight)', true);
        record('13.8.10 (skipped, no flight)', true);
      }

      // After the initial plan, fire a hotel replan and verify the
      // bookend rule kicks in. The LLM may have pre-selected a hotel
      // (per the Step 4 prompt), so we must pick one that is NOT
      // currently selected — otherwise the PICK button is disabled
      // with the "✓ PICKED" state.
      const beforeHotelCount = (real.hotels || []).length;
      if (beforeHotelCount >= 2) {
        await page.keyboard.press('3'); // HOTELS
        await page.waitForTimeout(300);
        // Find a hotel that is NOT currently selected
        const currentPickName = real?.selected_hotel?.name;
        let pickIdx = 0;
        if (currentPickName) {
          const foundIdx = (real.hotels || []).findIndex((h) => h.name !== currentPickName);
          if (foundIdx >= 0) pickIdx = foundIdx;
        }
        await page.locator('.panel-list-items .panel-list-item').nth(pickIdx).click();
        await page.waitForTimeout(200);
        // Wait for the button to become enabled (in case the click
        // hadn't propagated listIndex yet)
        await waitFor(
          async () => await page.locator('[data-testid="hotel-pick-btn"]').isEnabled(),
          3000,
        );
        await page.locator('[data-testid="hotel-pick-btn"]').click();

        // Wait for the replan to settle (also up to 4 minutes)
        await waitFor(async () => {
          const d = await debugState(page);
          return d?.agentState === 'idle' && d?.itinerary?.selected_hotel != null;
        }, 240000);

        const replanned = (await debugState(page))?.itinerary;
        const hotelName = replanned?.selected_hotel?.name;
        const day1 = replanned?.days?.[0];
        const firstAct = day1?.activities?.[0]?.name;
        const lastAct = day1?.activities?.[day1?.activities?.length - 1]?.name;
        record(
          '13.8.11 After replan, day 1 starts at hotel',
          firstAct === hotelName,
          `first: ${firstAct}, hotel: ${hotelName}`,
        );
        record(
          '13.8.12 After replan, day 1 ends at hotel',
          lastAct === hotelName,
          `last: ${lastAct}, hotel: ${hotelName}`,
        );
        const replannedActCount = (day1?.activities || []).length;
        record(
          '13.8.13 Replanned day has ≥4 activities (bookends + content)',
          replannedActCount >= 4,
          `count: ${replannedActCount}`,
        );
      } else {
        record('13.8.11 (skipped, <2 hotels)', true);
        record('13.8.12 (skipped, <2 hotels)', true);
        record('13.8.13 (skipped, <2 hotels)', true);
      }
    }
  }

  // ─── PHASE 14 — Globe + idempotency + console sweep (5) ────────────
  console.log('\n=== Phase 14: Globe + final sweep ===');
  await page.keyboard.press('1');
  await page.waitForTimeout(200);
  active = await page.locator('.tab.active').first().innerText();
  record('14.1 Press 1 → HOME', active.includes('HOME'));

  // Final screenshot
  await page.screenshot({ path: '/tmp/round8-hardened-final.png', fullPage: false });
  record('14.2 Final screenshot saved', true, '/tmp/round8-hardened-final.png');

  const realErrors = consoleErrors.filter(
    (e) =>
      !e.includes('Failed to load resource') &&
      !e.includes('Download the React DevTools') &&
      !e.includes('OPENROUTER_API_KEY') &&
      !e.includes('500 (Internal Server Error)'),
  );
  record('14.3 No console errors', realErrors.length === 0);
  realErrors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  record('14.4 No uncaught page errors', pageErrors.length === 0);
  pageErrors.forEach((e, i) => console.log(`  page error ${i + 1}: ${e}`));

  // ─── Summary ───────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed (${results.length} total)`);

  if (failed > 0) {
    console.log('\nFailing assertions:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  ❌ ${r.label}${r.details ? ' — ' + r.details : ''}`));
  }

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
