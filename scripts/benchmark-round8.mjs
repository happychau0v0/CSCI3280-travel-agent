#!/usr/bin/env node
/**
 * Round 8.5 E2E performance benchmark.
 *
 * Measures the timings that matter for user-perceived responsiveness:
 *
 *   1. Time to first paint (browser navigation commit → first contentful paint)
 *   2. Time to interactive (navigation → globe canvas mounted → PLAN button enabled)
 *   3. send-to-status-bar latency (PLAN click → AgentStatusBar visible)
 *   4. send-to-first-narration latency (PLAN click → first tool-narration subtitle)
 *   5. send-to-first-tool latency (PLAN click → first tool_start SSE event)
 *   6. per-tool wall-clock duration (tool_start → tool_end)
 *   7. turn 1 total latency (PLAN click → done event)
 *   8. turn 2 total latency (follow-up send → done event)
 *   9. itinerary delivery latency (PLAN click → setCurrentItinerary committed)
 *   10. TTS start latency (done → SpeechSynthesis utterance start)
 *
 * Writes a JSON report to /tmp/round8-benchmark.json and prints a
 * human-readable table to stdout. Rerun after each optimization to
 * track progress. Uses the SAME backend+LLM as the real-LLM smoke
 * test, so it has to hit the real OpenRouter + Google Maps APIs.
 *
 * Usage:
 *   node scripts/benchmark-round8.mjs
 *   node scripts/benchmark-round8.mjs --turns 2   # also run the replan turn
 *   node scripts/benchmark-round8.mjs --runs 3    # average across 3 runs
 *   node scripts/benchmark-round8.mjs --out /tmp/out.json
 */
import pkg from '/home/hpc/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.js';
import { writeFileSync } from 'node:fs';

const { chromium } = pkg;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/home/hpc/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';

// CLI args
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  return args[i + 1] ?? true;
}
const RUNS = parseInt(flag('runs', '1'), 10);
const TURNS = parseInt(flag('turns', '1'), 10);
const OUT = flag('out', '/tmp/round8-benchmark.json');

function fmt(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

async function waitFor(fn, timeoutMs, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function runOnce(runIdx) {
  console.log(`\n=== Run ${runIdx + 1}/${RUNS} ===`);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });
  const context = await browser.newContext({
    geolocation: { latitude: 22.3193, longitude: 114.1694 },
    permissions: ['geolocation'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const metrics = {
    runIdx,
    timestamp: new Date().toISOString(),
    timings: {},
    tools: [], // per-tool timing rows
  };

  // Per-event SSE timings come from window.__sseEvents which
  // client.js populates (in DEV mode) on every chunk read. Each
  // event has its own {at} timestamp so we can compute per-tool
  // durations accurately — much better than page.on('response')
  // which only fires once when the whole body arrives.
  let planClickAt = null;
  let turn2ClickAt = null;

  // ── Time to First Paint + TTI ────────────────────────────────────
  const navStart = Date.now();
  await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
  metrics.timings.navToDomContentLoaded = Date.now() - navStart;

  // Wait for globe canvas to mount (time to interactive)
  const ttiStart = Date.now();
  const globeOk = await waitFor(
    async () => (await page.locator('.globe-canvas canvas').count()) > 0,
    30000,
    100,
  );
  metrics.timings.globeMountMs = Date.now() - ttiStart;
  if (!globeOk) {
    console.log('  ❌ globe never mounted — skipping this run');
    await browser.close();
    return metrics;
  }

  // Clear localStorage + seed a fully-specified form so the LLM
  // doesn't need to ask for clarification.
  await page.evaluate(() => {
    localStorage.clear();
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

  // ── Time to Interactive (PLAN button ready) ──────────────────────
  const buttonReadyStart = Date.now();
  await waitFor(
    async () => await page.locator('[data-testid="trip-plan-btn"]').isEnabled(),
    5000,
  );
  metrics.timings.buttonEnabledMs = Date.now() - buttonReadyStart;

  // ── Turn 1 ───────────────────────────────────────────────────────
  console.log('  firing turn 1 (PLAN)…');
  planClickAt = Date.now();
  await page.locator('[data-testid="trip-plan-btn"]').click();

  // Status bar first visible
  const statusBarAppeared = await waitFor(
    async () => (await page.locator('.agent-status-bar').count()) > 0,
    2000,
    25,
  );
  metrics.timings.statusBarFirstPaintMs = statusBarAppeared ? Date.now() - planClickAt : null;

  // First tool narration subtitle
  const firstNarrationAt = await waitFor(async () => {
    const sub = await page.locator('.subtitle-text').innerText().catch(() => '');
    // The ▸ preview echo, or a tool narration like "Searching flights…"
    return sub && (sub.includes('▸') || sub.toLowerCase().includes('searching') || sub.toLowerCase().includes('looking') || sub.toLowerCase().includes('routing'));
  }, 5000, 50);
  metrics.timings.firstSubtitleMs = firstNarrationAt ? Date.now() - planClickAt : null;

  // Turn 1 completion
  const turn1Ok = await waitFor(async () => {
    const d = await page.evaluate(() => window.__debug);
    return d?.agentState === 'idle' && (d?.messages || []).length >= 2;
  }, 240000, 200);
  metrics.timings.turn1TotalMs = turn1Ok ? Date.now() - planClickAt : null;

  // ── Per-tool breakdown from window.__sseEvents ───────────────────
  const sseEvents = await page.evaluate(() => window.__sseEvents || []);
  if (sseEvents.length > 0 && planClickAt) {
    const toolStarts = new Map();
    for (const ev of sseEvents) {
      if (ev.type === 'tool_start') {
        const name = ev.data?.name;
        if (name) toolStarts.set(name, ev.at);
      } else if (ev.type === 'tool_end') {
        const name = ev.data?.name;
        const started = toolStarts.get(name);
        if (started) {
          metrics.tools.push({
            turn: 1,
            name,
            relStartMs: started - planClickAt,
            durationMs: ev.at - started,
          });
          toolStarts.delete(name);
        }
      }
    }
    const firstTool = sseEvents.find((e) => e.type === 'tool_start');
    if (firstTool) {
      metrics.timings.firstToolStartMs = firstTool.at - planClickAt;
    }
    const doneEv = sseEvents.find((e) => e.type === 'done');
    if (doneEv) {
      metrics.timings.sseDoneMs = doneEv.at - planClickAt;
    }
  }
  // Clear the SSE buffer for turn 2 — only turn 2's events should
  // be counted against turn 2's planClickAt.
  await page.evaluate(() => { window.__sseEvents = []; });

  // ── Turn 2 (optional) ────────────────────────────────────────────
  if (TURNS >= 2 && turn1Ok) {
    // Fire the "yes proceed" follow-up
    console.log('  firing turn 2 (confirmation)…');
    await page.waitForTimeout(500);
    // Open popover if not already
    if (!(await page.locator('.chat-popover').isVisible().catch(() => false))) {
      await page.keyboard.press('t');
      await page.waitForTimeout(200);
    }
    const t2Start = Date.now();
    turn2ClickAt = t2Start;
    await page.locator('.chat-popover input[type="text"]').fill(
      'Yes, proceed with the full plan. Fill every day with 3-4 distinct activities.',
    );
    await page.keyboard.press('Enter');

    const turn2Ok = await waitFor(async () => {
      const d = await page.evaluate(() => window.__debug);
      return d?.agentState === 'idle' && d?.itinerary?.days?.length >= 1;
    }, 300000, 200);
    metrics.timings.turn2TotalMs = turn2Ok ? Date.now() - t2Start : null;

    // Turn 2 per-tool breakdown
    const sseEvents2 = await page.evaluate(() => window.__sseEvents || []);
    if (turn2Ok && sseEvents2.length > 0) {
      const toolStarts = new Map();
      for (const ev of sseEvents2) {
        if (ev.type === 'tool_start') {
          const name = ev.data?.name;
          if (name) toolStarts.set(name, ev.at);
        } else if (ev.type === 'tool_end') {
          const name = ev.data?.name;
          const started = toolStarts.get(name);
          if (started) {
            metrics.tools.push({
              turn: 2,
              name,
              relStartMs: started - t2Start,
              durationMs: ev.at - started,
            });
            toolStarts.delete(name);
          }
        }
      }
    }

    // Itinerary quality signals for post-hoc analysis
    const d = await page.evaluate(() => window.__debug);
    const days = d?.itinerary?.days || [];
    metrics.itinerary = {
      destination: d?.itinerary?.destination || null,
      dayCount: days.length,
      hotelCount: (d?.itinerary?.hotels || []).length,
      avgActivitiesPerDay:
        days.length > 0
          ? days.reduce((s, x) => s + (x.activities || []).length, 0) / days.length
          : 0,
      singleStopDayCount: days.filter((x) => (x.activities || []).length === 1).length,
      emptyDayCount: days.filter((x) => (x.activities || []).length === 0).length,
    };
  }

  await browser.close();
  return metrics;
}

async function main() {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const m = await runOnce(i);
    runs.push(m);
    console.log(`  turn1: ${fmt(m.timings.turn1TotalMs)}   ` +
      `statusBar: ${fmt(m.timings.statusBarFirstPaintMs)}   ` +
      `subtitle: ${fmt(m.timings.firstSubtitleMs)}`);
  }

  // Summary table
  console.log('\n=== Summary (all runs) ===');
  const header = ['#', 'globe', 'planBtn', 'statusBar', 'subtitle', 'firstTool', 'turn1', 'turn2', 'days', 'avg/day'];
  const rows = runs.map((r, i) => [
    i + 1,
    fmt(r.timings.globeMountMs),
    fmt(r.timings.buttonEnabledMs),
    fmt(r.timings.statusBarFirstPaintMs),
    fmt(r.timings.firstSubtitleMs),
    fmt(r.timings.firstToolStartMs),
    fmt(r.timings.turn1TotalMs),
    fmt(r.timings.turn2TotalMs),
    r.itinerary?.dayCount ?? '—',
    r.itinerary?.avgActivitiesPerDay?.toFixed(1) ?? '—',
  ]);
  const widths = header.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)),
  );
  const printRow = (cells) =>
    console.log(cells.map((c, i) => String(c).padStart(widths[i])).join('  '));
  printRow(header);
  printRow(widths.map((w) => '─'.repeat(w)));
  for (const r of rows) printRow(r);

  // Per-tool breakdown for run 1
  if (runs[0]?.tools?.length > 0) {
    console.log('\n=== Per-tool timing (run 1) ===');
    const thdr = ['turn', 'tool', 'relStart', 'duration'];
    const trows = runs[0].tools.map((t) => [
      t.turn,
      t.name,
      fmt(t.relStartMs),
      fmt(t.durationMs),
    ]);
    const tw = thdr.map((h, i) =>
      Math.max(String(h).length, ...trows.map((r) => String(r[i]).length)),
    );
    const printT = (cells) =>
      console.log(cells.map((c, i) => String(c).padStart(tw[i])).join('  '));
    printT(thdr);
    printT(tw.map((w) => '─'.repeat(w)));
    for (const r of trows) printT(r);
  }

  // Write JSON report
  writeFileSync(OUT, JSON.stringify({ runs }, null, 2));
  console.log(`\nReport: ${OUT}`);
  console.log(`\nOptimization hints:
  - statusBar > 200ms         → handleSend is doing too much sync work before setAgentState
  - firstSubtitle > 300ms     → subtitle queue race (see B3); check useSubtitleQueue
  - firstTool > 3s            → LLM model is slow to first-token; consider model switch
  - turn1 > 30s               → consider trimming SYSTEM_PROMPT or switching to a faster model
  - avg/day < 3               → prompt tuning needed (Step 5 per-day rules)
  - any single tool > 15s     → investigate tool implementation (Places/Routes API latency)
`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
