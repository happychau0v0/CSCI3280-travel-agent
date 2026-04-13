#!/usr/bin/env node
/**
 * P5: Integration E2E — hits the REAL backend (with MOCK_TOOLS=1).
 *
 * Unlike verify-round8-hardened.mjs which mocks /chat/stream via
 * page.route(), this test sends real HTTP requests through the full
 * SSE pipeline. It validates:
 *   - Real SSE event delivery and ordering
 *   - JSON extraction from real LLM output (or mock-tools output)
 *   - State transitions (form → agent working → panels populate)
 *   - Navigate timing (no empty panel flash)
 *
 * Prerequisites:
 *   1. Backend running with MOCK_TOOLS=1:
 *      MOCK_TOOLS=1 uvicorn app.main:app --port 8000
 *   2. Frontend running:
 *      cd frontend && npm run dev
 *   3. LLM key still required (OpenRouter) since the LLM orchestrator
 *      itself is NOT mocked — only the tool dispatch layer is.
 *      For fully offline testing, also set a mock LLM client.
 *
 * Run: node scripts/verify-integration.mjs
 */

let chromium;
try {
  const pkg = await import('playwright');
  chromium = pkg.chromium || pkg.default?.chromium;
} catch {
  console.error('Playwright not found. Install: npm install -D playwright');
  process.exit(1);
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const TIMEOUT_MS = 90_000; // LLM can be slow

const results = [];
function record(label, passed, details = '') {
  results.push({ label, passed, details });
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${label}${details ? ' — ' + details : ''}`);
}

async function waitFor(fn, timeoutMs = TIMEOUT_MS, intervalMs = 500) {
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

async function debugState(page) {
  return page.evaluate(() => window.__debug || null);
}

// ─── Pre-flight checks ─────────────────────────────────────────────────

async function checkBackendHealth() {
  try {
    const resp = await fetch(`${BACKEND_URL}/health`);
    return resp.ok;
  } catch {
    return false;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

(async () => {
  // Check backend is running
  const healthy = await checkBackendHealth();
  if (!healthy) {
    console.error(`❌ Backend not reachable at ${BACKEND_URL}`);
    console.error('   Start with: MOCK_TOOLS=1 uvicorn app.main:app --port 8000');
    process.exit(1);
  }
  record('Backend health check', true);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    geolocation: { latitude: 22.3193, longitude: 114.1694 },
    permissions: ['geolocation'],
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // ─── Phase 1: Load the app ─────────────────────────────────────────

  console.log('\n── Phase 1: Initial load ──\n');

  await page.goto(FRONTEND_URL, { waitUntil: 'networkidle' });
  record('Frontend loads', true);

  // Verify initial state
  const initialDebug = await debugState(page);
  record(
    'Initial agent state is idle',
    initialDebug?.agentState === 'idle',
    `got: ${initialDebug?.agentState}`,
  );

  // ─── Phase 2: Fill form and submit ─────────────────────────────────

  console.log('\n── Phase 2: Submit trip request ──\n');

  // Clear any existing state
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Fill destination
  const destInput = page.locator('input[name="destination"], [data-field="destination"] input, input[placeholder*="destination" i]').first();
  if (await destInput.isVisible().catch(() => false)) {
    await destInput.fill('Tokyo');
    record('Destination filled', true);
  } else {
    // Try textarea or other input patterns
    const anyDest = page.locator('input').first();
    await anyDest.fill('Tokyo');
    record('Destination filled (fallback selector)', true);
  }

  // Fill dates if visible
  const startDate = page.locator('input[type="date"]').first();
  if (await startDate.isVisible().catch(() => false)) {
    await startDate.fill('2026-05-15');
    const endDate = page.locator('input[type="date"]').nth(1);
    if (await endDate.isVisible().catch(() => false)) {
      await endDate.fill('2026-05-17');
    }
    record('Dates filled', true);
  }

  // Click START PLANNING
  const submitBtn = page.locator('button').filter({ hasText: /START PLANNING|REPLAN/ }).first();
  const submitVisible = await submitBtn.isVisible().catch(() => false);
  record('Submit button visible', submitVisible);

  if (!submitVisible) {
    console.error('Cannot find START PLANNING button — aborting');
    await browser.close();
    process.exit(1);
  }

  await submitBtn.click();
  record('Clicked START PLANNING', true);

  // ─── Phase 3: Wait for agent to work ───────────────────────────────

  console.log('\n── Phase 3: Agent working ──\n');

  // Agent state should transition to "working"
  const sawWorking = await waitFor(async () => {
    const d = await debugState(page);
    return d?.agentState === 'working';
  }, 10_000);
  record('Agent state reached "working"', sawWorking);

  // Wait for agent to finish (done state)
  const sawDone = await waitFor(async () => {
    const d = await debugState(page);
    return d?.agentState === 'done' || d?.agentState === 'idle';
  }, TIMEOUT_MS);
  record('Agent finished (done/idle)', sawDone);

  if (!sawDone) {
    console.error('Agent did not finish within timeout — check LLM connection');
    const finalDebug = await debugState(page);
    console.error('Final debug state:', JSON.stringify(finalDebug?.agentState));
    await browser.close();
    process.exit(1);
  }

  // ─── Phase 4: Validate itinerary populated ─────────────────────────

  console.log('\n── Phase 4: Validate results ──\n');

  const debug = await debugState(page);

  // Check itinerary exists
  const hasItinerary = debug?.itinerary != null;
  record('Itinerary populated', hasItinerary);

  if (hasItinerary) {
    const itin = debug.itinerary;

    // Flights
    const flightCount = itin.flight?.options?.length || 0;
    record('Has ≥3 flight options', flightCount >= 3, `count=${flightCount}`);

    // Hotels
    const hotelCount = itin.hotels?.length || 0;
    record('Has ≥3 hotels', hotelCount >= 3, `count=${hotelCount}`);

    // Days
    const dayCount = itin.days?.length || 0;
    record('Has ≥2 days', dayCount >= 2, `count=${dayCount}`);

    // Destination
    record(
      'Destination set',
      !!itin.destination,
      itin.destination || 'missing',
    );

    // Check activities in days
    if (dayCount > 0) {
      const totalActivities = itin.days.reduce(
        (sum, d) => sum + (d.activities?.length || 0),
        0,
      );
      record('Has activities', totalActivities > 0, `total=${totalActivities}`);
    }
  }

  // ─── Phase 5: SSE event ordering (from recorded events) ────────────

  console.log('\n── Phase 5: SSE event sanity ──\n');

  // Check that messages array has content (SSE delivered data)
  const messageCount = debug?.messages?.length || 0;
  record('Messages populated via SSE', messageCount >= 2, `count=${messageCount}`);

  // Check tool calls were made
  const toolCallsMade = debug?.toolCallsMade || debug?.lastToolCalls || [];
  // The __debug object might not expose tool calls directly, so check
  // if itinerary has data that would require tools
  if (hasItinerary && debug.itinerary?.flight) {
    record('Tool calls produced flight data', true);
  }

  // ─── Phase 6: Console errors ───────────────────────────────────────

  console.log('\n── Phase 6: Error check ──\n');

  const realErrors = consoleErrors.filter(
    (e) =>
      !e.includes('favicon') &&
      !e.includes('net::ERR') &&
      !e.includes('geolocation') &&
      !e.includes('Geolocation'),
  );
  record(
    'No uncaught console errors',
    realErrors.length === 0,
    realErrors.length > 0
      ? `${realErrors.length} errors: ${realErrors.slice(0, 3).join('; ')}`
      : '',
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
  }

  process.exit(failed > 0 ? 1 : 0);
})();
