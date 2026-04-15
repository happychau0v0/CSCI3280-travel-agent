#!/usr/bin/env node
/**
 * Real-browser E2E performance measurement.
 *
 * Answers the question: "does bench_chat.py reflect what the user actually
 * experiences in the browser?" by measuring the same pipeline from the
 * browser's perspective:
 *
 *   T0  – START PLANNING button clicked (wall clock)
 *   T1  – AgentStatusBar appears (first user-visible feedback)
 *   T2  – First SSE event received (window.__sseEvents[0].at)
 *   T3  – First "thinking" SSE event
 *   T4  – First tool_start SSE event (LLM decided to call a tool)
 *   T5  – First partial_itinerary (flight data visible in UI)
 *   T6  – "done" SSE event received
 *   T7  – AgentStatusBar shows "READY" (done rendered in UI)
 *   T8  – Status bar collapses back to idle
 *
 * Per-tool breakdown comes from window.__sseEvents (populated by client.js
 * in DEV mode). Server-side "t" field on each event gives the server-relative
 * ms so we can also compute client↔server delta (network overhead).
 *
 * Usage:
 *   node scripts/browser-perf.mjs
 *   node scripts/browser-perf.mjs --runs 2
 *   node scripts/browser-perf.mjs --headful       # watch it in a real window
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Use the npx-cached playwright installation
const PW_ROOT = path.join(
  process.env.HOME,
  '.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core'
);
const { chromium } = require(PW_ROOT);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL  = process.env.BACKEND_URL  || 'http://localhost:8000';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : (args[i+1] ?? true); };
const RUNS    = parseInt(flag('runs', '1'), 10);
const HEADFUL = args.includes('--headful');
const OUT     = flag('out', '/tmp/browser-perf.json');

const fmt = (ms) => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(2)}s`;

// Seed form data — fully specified so the LLM shouldn't ask for clarification
const TRIP_FORM = {
  origin:      'Hong Kong',
  destination: 'Tokyo',
  start_date:  '2026-06-01',
  end_date:    '2026-06-03',
  transport:   'plane',
  party_size:  '2',
  interests:   'history, food, temples',
  seat_class:  'economy',
};

async function poll(fn, timeoutMs = 120_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return true; } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function runOnce(runIdx) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Run ${runIdx + 1} / ${RUNS}`);
  console.log(`${'═'.repeat(60)}`);

  const browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    geolocation: { latitude: 22.3193, longitude: 114.1694 },
    permissions: ['geolocation'],
  });
  const page = await ctx.newPage();

  // Capture console errors for debugging
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // ── Load the app ─────────────────────────────────────────────────
  const navStart = Date.now();
  await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
  const domLoadedMs = Date.now() - navStart;

  // Seed localStorage then reload so React picks up the form state
  await page.evaluate((form) => {
    localStorage.clear();
    localStorage.setItem('travel-trip-form', JSON.stringify(form));
    localStorage.setItem('travel-settings', JSON.stringify({ muteVoice: true }));
  }, TRIP_FORM);

  await page.reload({ waitUntil: 'networkidle' });
  const interactiveMs = Date.now() - navStart;

  // ── Find the START PLANNING button ───────────────────────────────
  // Try data-testid first, then text content
  let planBtn = page.locator('[data-testid="trip-plan-btn"]');
  if (!(await planBtn.count())) {
    planBtn = page.locator('button', { hasText: /start planning/i });
  }
  if (!(await planBtn.count())) {
    console.log('  ❌ START PLANNING button not found');
    await browser.close();
    return null;
  }

  await planBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

  // ── Inject timing instrumentation ────────────────────────────────
  // We inject before clicking so MutationObserver is wired up in time.
  await page.evaluate(() => {
    window.__perfT0 = null;
    window.__perfMarks = {};

    // Watch for AgentStatusBar appearance / state changes
    const observer = new MutationObserver(() => {
      const bar = document.querySelector('.agent-status-bar');
      if (!bar) return;
      const now = Date.now();
      if (!window.__perfMarks.statusBarVisible) {
        window.__perfMarks.statusBarVisible = now;
      }
      if (bar.classList.contains('status-done') && !window.__perfMarks.statusBarDone) {
        window.__perfMarks.statusBarDone = now;
      }
      if (!bar.closest('body') && window.__perfMarks.statusBarDone && !window.__perfMarks.statusBarGone) {
        window.__perfMarks.statusBarGone = now;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.__perfObserver = observer;
  });

  // ── Click START PLANNING and record T0 ───────────────────────────
  console.log('  clicking START PLANNING…');
  const t0Wall = Date.now();
  await page.evaluate((t0) => {
    window.__perfT0 = t0;
    window.__sseEvents = [];  // reset the DEV SSE buffer
  }, t0Wall);

  await planBtn.click();

  // ── Wait for done (up to 3 min) ──────────────────────────────────
  const doneOk = await poll(async () => {
    return await page.evaluate(() => {
      const evs = window.__sseEvents || [];
      return evs.some(e => e.type === 'done' || e.type === 'error');
    });
  }, 180_000, 200);

  const t1Wall = Date.now();
  const totalBrowserMs = t1Wall - t0Wall;

  // ── Collect all instrumentation data ─────────────────────────────
  const data = await page.evaluate(() => ({
    sseEvents: window.__sseEvents || [],
    perfMarks: window.__perfMarks || {},
    perfT0: window.__perfT0,
    debug: window.__debug || {},
  }));

  await browser.close();

  const { sseEvents, perfMarks, perfT0 } = data;

  // ── Compute timings from SSE event log ───────────────────────────
  const ev = (type) => sseEvents.find(e => e.type === type);
  const evAll = (type) => sseEvents.filter(e => e.type === type);

  const rel = (wallAt) => wallAt != null ? wallAt - t0Wall : null;

  const firstSSE         = sseEvents[0];
  const firstThinking    = ev('thinking');
  const firstToken       = ev('token');
  const firstToolStart   = ev('tool_start');
  const firstPartial     = ev('partial_itinerary');
  const doneEv           = ev('done');
  const errorEv          = ev('error');

  const timings = {
    // Browser/app load
    domLoadedMs,
    interactiveMs,
    // From click to key milestones (wall-clock deltas)
    statusBarVisibleMs:  rel(perfMarks.statusBarVisible),
    firstSSEMs:          firstSSE        ? firstSSE.at - t0Wall        : null,
    firstThinkingMs:     firstThinking   ? firstThinking.at - t0Wall   : null,
    firstTokenMs:        firstToken      ? firstToken.at - t0Wall      : null,
    firstToolStartMs:    firstToolStart  ? firstToolStart.at - t0Wall  : null,
    firstPartialMs:      firstPartial    ? firstPartial.at - t0Wall    : null,
    sseDoneMs:           doneEv          ? doneEv.at - t0Wall          : null,
    statusBarDoneMs:     rel(perfMarks.statusBarDone),
    totalBrowserMs,
  };

  // ── Server-side "t" field analysis ───────────────────────────────
  // Each SSE event carries data.t = ms since server received the POST.
  // The delta (event.at - t0Wall) - data.t = network+overhead per event.
  const serverOffsets = sseEvents
    .filter(e => e.data?.t != null)
    .map(e => ({ type: e.type, client_ms: e.at - t0Wall, server_t: e.data.t }));

  // Network latency estimate: (client_ms of first SSE) - (server_t of first SSE)
  const networkDeltaMs = serverOffsets.length > 0
    ? serverOffsets[0].client_ms - serverOffsets[0].server_t
    : null;

  // ── Per-tool breakdown ────────────────────────────────────────────
  const toolStarts = new Map();
  const tools = [];
  for (const e of sseEvents) {
    if (e.type === 'tool_start') {
      const name = e.data?.name;
      if (name) toolStarts.set(name, { wallAt: e.at, serverT: e.data.t });
    } else if (e.type === 'tool_end') {
      const name = e.data?.name;
      const start = toolStarts.get(name);
      if (start) {
        tools.push({
          name,
          relStartMs:  start.wallAt - t0Wall,
          durationMs:  e.at - start.wallAt,
          serverElapsedMs: e.data?.elapsed_ms ?? null,  // server-measured wall time
        });
        toolStarts.delete(name);
      }
    }
  }

  // ── LLM round breakdown (using server "t" field on thinking events) ───
  const thinkingEvents = evAll('thinking');
  const rounds = thinkingEvents.map((th, i) => {
    const nextThink = thinkingEvents[i + 1];
    const roundEnd = nextThink ? nextThink.data.t : doneEv?.data?.t;
    const roundStart = th.data.t;

    // First tool_start server_t in this round
    const roundTools = serverOffsets.filter(
      e => e.type === 'tool_start' && e.server_t >= roundStart && (!roundEnd || e.server_t < roundEnd)
    );
    const firstToolT = roundTools[0]?.server_t ?? null;

    // First token in this round
    const roundTokens = serverOffsets.filter(
      e => e.type === 'token' && e.server_t >= roundStart && (!roundEnd || e.server_t < roundEnd)
    );
    const firstTokenT = roundTokens[0]?.server_t ?? null;

    return {
      round: i,
      thinking_server_t: roundStart,
      ttft_ms: firstTokenT != null ? firstTokenT - roundStart : null,
      llm_to_tools_ms: firstToolT != null ? firstToolT - roundStart : null,
    };
  });

  // ── Print report ──────────────────────────────────────────────────
  const W = 60;
  console.log('');
  console.log('  BROWSER TIMING  (click → milestone)');
  console.log('');

  const rows = [
    ['App DOM loaded',           timings.domLoadedMs],
    ['App interactive',          timings.interactiveMs],
    ['→ Status bar visible',     timings.statusBarVisibleMs],
    ['→ First SSE event',        timings.firstSSEMs],
    ['→ First "thinking"',       timings.firstThinkingMs],
    ['→ First token (text)',      timings.firstTokenMs],
    ['→ First tool_start',       timings.firstToolStartMs],
    ['→ First flight/hotel data',timings.firstPartialMs],
    ['→ "done" received',        timings.sseDoneMs],
    ['→ Status bar shows READY', timings.statusBarDoneMs],
    ['→ Total (click → idle)',   timings.totalBrowserMs],
  ];
  for (const [label, ms] of rows) {
    const val = fmt(ms);
    console.log(`  ${label.padEnd(28)} ${val.padStart(8)}`);
  }

  if (networkDeltaMs != null) {
    console.log('');
    console.log(`  Network+overhead delta:      ${fmt(networkDeltaMs)}  (client_ms − server_t on first event)`);
  }

  if (rounds.length > 0) {
    console.log('');
    console.log('  LLM ROUNDS  (server-side "t" field)');
    for (const r of rounds) {
      const ttft = r.ttft_ms != null ? `TTFT ${fmt(r.ttft_ms)}` : '';
      const toLl = r.llm_to_tools_ms != null ? `→ tools ${fmt(r.llm_to_tools_ms)}` : 'no tools';
      console.log(`  Round ${r.round + 1}:  server_t=${fmt(r.thinking_server_t)}  ${ttft}  ${toLl}`);
    }
  }

  if (tools.length > 0) {
    console.log('');
    console.log('  PER-TOOL  (wall-clock from click, server elapsed in parens)');
    for (const t of tools) {
      const srv = t.serverElapsedMs != null ? ` (server: ${fmt(t.serverElapsedMs)})` : '';
      console.log(`  +${fmt(t.relStartMs).padEnd(10)}  ${t.name.padEnd(22)}  ${fmt(t.durationMs)}${srv}`);
    }
  }

  if (doneEv && timings.sseDoneMs && timings.totalBrowserMs) {
    const renderLag = timings.totalBrowserMs - timings.sseDoneMs;
    console.log('');
    console.log(`  Render lag after "done":     ${fmt(renderLag)}  (SSE done → browser idle)`);
  }

  if (consoleErrors.length > 0) {
    console.log('');
    console.log(`  ⚠ Console errors (${consoleErrors.length}):`);
    for (const e of consoleErrors.slice(0, 5)) console.log(`    ${e}`);
  }

  if (!doneOk || errorEv) {
    console.log(`  ❌ ${errorEv ? 'Error: ' + errorEv.data?.message : 'Timed out waiting for done event'}`);
  }

  return {
    runIdx,
    timestamp: new Date().toISOString(),
    query: TRIP_FORM,
    timings,
    rounds,
    tools,
    networkDeltaMs,
    consoleErrors,
    sseEventCount: sseEvents.length,
    ok: doneOk && !errorEv,
  };
}

async function main() {
  // Verify backend is up
  try {
    const res = await fetch(`${BACKEND_URL}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    console.error(`❌ Backend not reachable at ${BACKEND_URL}: ${e.message}`);
    process.exit(1);
  }
  console.log(`Backend: ${BACKEND_URL} ✓`);
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Runs: ${RUNS}  |  Headful: ${HEADFUL}`);

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce(i);
    if (r) runs.push(r);
  }

  if (runs.length > 1) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  AGGREGATE');
    console.log(`${'═'.repeat(60)}`);
    const keys = ['firstSSEMs','firstToolStartMs','firstPartialMs','sseDoneMs','totalBrowserMs'];
    for (const k of keys) {
      const vals = runs.map(r => r.timings[k]).filter(v => v != null).sort((a,b)=>a-b);
      if (!vals.length) continue;
      const p50 = vals[Math.floor(vals.length/2)];
      const p90 = vals[Math.floor(vals.length*0.9)];
      console.log(`  ${k.padEnd(22)}  p50=${fmt(p50)}  p90=${fmt(p90)}  max=${fmt(vals[vals.length-1])}`);
    }
  }

  writeFileSync(OUT, JSON.stringify({ runs }, null, 2));
  console.log(`\nJSON saved: ${OUT}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
