#!/usr/bin/env node
/*
 * Drives the demo recording. Attaches to the running Electron dev instance via
 * CDP, reads the audio manifest (durations) and the script (action keys), and
 * for each beat: fires the beat's action, then sleeps for the beat's audio
 * duration. A *global* ambient ticker fires random tool activity on every
 * worker every ~700ms throughout the run so the office is never visually still.
 *
 * Usage:
 *   node scripts/video/orchestrator.mjs              # dry-run pacing only
 *   node scripts/video/orchestrator.mjs --record     # log cues to /tmp/video-cues.txt
 *
 * Assumes electron-vite dev is running with CDP at 127.0.0.1:9222 and the
 * daemon HTTP at 127.0.0.1:47821. `interceptExternalSessions: true` must be
 * set in config/interactive-tools.json.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Manifest path is overridable so the same orchestrator can drive both the
// long narrated intro (audio/manifest.json — written by generate-tts.mjs) and
// the 20s teaser (teaser-manifest.json — hand-tuned durations, no narration).
const manifestArg = process.argv.find((a) => a.startsWith('--manifest='));
const MANIFEST_PATH = manifestArg
  ? resolve(process.cwd(), manifestArg.slice('--manifest='.length))
  : resolve(__dirname, 'audio/manifest.json');

const CDP_URL = process.env.STARDEW_OFFICE_CDP ?? 'http://127.0.0.1:9222';
const HOST = process.env.STARDEW_OFFICE_HOST ?? '127.0.0.1';
const HTTP_PORT = process.env.STARDEW_OFFICE_HTTP_PORT ?? '47821';
const TOKEN_PATH = `${homedir()}/.claude/.stardew-clawd-token`;
const RECORD = process.argv.includes('--record');
const CUES_PATH = '/tmp/video-cues.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function token() {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(`daemon token missing at ${TOKEN_PATH} — is dev running?`);
  }
  return readFileSync(TOKEN_PATH, 'utf-8').trim();
}

async function hook(payload) {
  const res = await fetch(`http://${HOST}:${HTTP_PORT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

async function despawn(sessionId) {
  await fetch(`http://${HOST}:${HTTP_PORT}/sessions/despawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
}

const CWDS = [
  '/Users/demo/awesome-project',
  '/Users/demo/data-pipeline',
  '/Users/demo/billing-service',
  '/Users/demo/mobile-app',
  '/Users/demo/internal-tools',
  '/Users/demo/web-frontend',
  '/Users/demo/ml-experiments',
  '/Users/demo/api-gateway',
  '/Users/demo/auth-service',
  '/Users/demo/cron-runner',
];

const PROMPTS = [
  'refactor the auth module',
  'fix the checkout bug',
  'write tests for registration',
  'update dependencies',
  'explain the websocket reconnect',
  'add pagination to dashboard',
  'profile the slow report endpoint',
  'migrate the legacy config',
  'audit input validation',
  'add idempotency to retries',
];

const TOOLS_ACTIVITY = ['Read', 'Read', 'Grep', 'Edit', 'Write', 'Bash', 'Read', 'WebFetch'];

const spawned = [];

async function startSession({ cwd, prompt }) {
  const sessionId = randomUUID();
  await hook({
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    cwd,
    source: 'startup',
    model: 'claude-opus-4-7',
  });
  await sleep(80);
  await hook({
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    cwd,
    prompt,
  });
  spawned.push({ sessionId, cwd });
  return sessionId;
}

async function fireTool(sessionId, cwd, tool) {
  const id = randomUUID();
  hook({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: tool,
    tool_input: {},
    tool_use_id: id,
  }).catch(() => {});
  await sleep(40);
  await hook({
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: tool,
    tool_input: {},
    tool_use_id: id,
    tool_response: 'ok',
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function pickRendererPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      const u = p.url() ?? '';
      if (u.startsWith('devtools://')) continue;
      const t = (await p.title()) ?? '';
      if (t === 'Stardew Clawd' || u.includes('localhost:517')) return p;
    }
  }
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (!p.url().startsWith('devtools://')) return p;
    }
  }
  return null;
}

async function safeClick(page, selector) {
  // Robust click: locator-based, scrolls into view, waits for actionable.
  try {
    await page.locator(selector).first().click({ timeout: 1500, force: true });
    return true;
  } catch (e) {
    console.warn(`  click ${selector} failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function canvasBox(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.scene-pane canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}

async function setZoom(page, scale) {
  // Drive the zoom slider directly via its range input rather than clicking
  // the +/− buttons. Button clicks proved flaky in the orchestrator context
  // (the React local state mirror sometimes lagged, so chained clicks landed
  // on stale `zoom` closures). Setting input.value + dispatching input/change
  // events runs through the same React onChange handler the user would, and
  // the next animation frame mirrors targetScale back into local state.
  await page.evaluate((scale) => {
    const range = document.querySelector('input.zoom-range');
    if (!range) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(range, String(Math.round(scale * 100)));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }, scale).catch(() => {});
}

async function dragPan(page, dx) {
  // Drag horizontally by dx pixels on the canvas to pan the camera.
  const box = await canvasBox(page);
  if (!box) return;
  const startX = box.x + box.w * 0.5 - dx / 2;
  const endX = startX + dx;
  const y = box.y + box.h * 0.55;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + ((endX - startX) * i) / steps, y);
    await sleep(30);
  }
  await page.mouse.up();
}

// ---------------------------------------------------------------------------
// Ambient ticker — runs throughout the recording so workers always animate.
// ---------------------------------------------------------------------------

let ambientHandle = null;
let currentSelectedSid = null;

function startAmbient() {
  if (ambientHandle) return;
  ambientHandle = setInterval(() => {
    // Skip workers with a pending AskUserQuestion — they should hold the
    // question pose, not flip back to reading/editing. Also skip the
    // currently-selected worker (we want their transcript stable during
    // panel-fold demos, not constantly appending new tool rows).
    const selectedSid = currentSelectedSid;
    const eligible = spawned.filter(
      (s) => !s.pendingAskToolUseId && s.sessionId !== selectedSid,
    );
    if (eligible.length === 0) return;
    const n = Math.min(eligible.length, 1 + Math.floor(Math.random() * 2));
    for (let i = 0; i < n; i++) {
      const s = eligible[Math.floor(Math.random() * eligible.length)];
      const t = TOOLS_ACTIVITY[Math.floor(Math.random() * TOOLS_ACTIVITY.length)];
      fireTool(s.sessionId, s.cwd, t).catch(() => {});
    }
  }, 700);
}

function stopAmbient() {
  if (ambientHandle) clearInterval(ambientHandle);
  ambientHandle = null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function makeTick(fn, intervalMs) {
  const handle = setInterval(fn, intervalMs);
  return { stop: () => clearInterval(handle) };
}

const ACTIONS = {
  async 'reset-then-spawn-3'({ page }) {
    // Despawn anything we already created.
    for (const { sessionId } of spawned.splice(0)) await despawn(sessionId);
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.side-panel .close-btn');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    await sleep(300);
    // Spawn the first three workers steadily over ~6 seconds.
    for (let i = 0; i < 3; i++) {
      await startSession({ cwd: CWDS[i], prompt: PROMPTS[i] });
      await sleep(1800);
    }
    return null;
  },

  async noop() {
    return null;
  },

  async 'pan-and-spawn'({ page }) {
    // Spawn 2 more workers + a small camera pan to show motion.
    for (let i = 3; i < 5; i++) {
      await startSession({ cwd: CWDS[i % CWDS.length], prompt: PROMPTS[i % PROMPTS.length] });
      await sleep(600);
    }
    await sleep(700);
    await dragPan(page, 150);
    return null;
  },

  async 'cycle-states-tour'() {
    // Walk every worker through varied tool sequences in parallel.
    let i = 0;
    const tools = ['Bash', 'Edit', 'WebFetch', 'Grep', 'Read', 'Write'];
    const tick = makeTick(async () => {
      if (spawned.length === 0) return;
      const targets = spawned.slice(0, Math.min(spawned.length, 3));
      for (const s of targets) {
        const t = tools[(i++) % tools.length];
        fireTool(s.sessionId, s.cwd, t).catch(() => {});
      }
    }, 900);
    return tick;
  },

  async 'trigger-ask'() {
    if (spawned.length === 0) {
      await startSession({ cwd: CWDS[0], prompt: PROMPTS[0] });
      await sleep(300);
    }
    const target = spawned[0];
    const toolUseId = randomUUID();
    hook({
      session_id: target.sessionId,
      hook_event_name: 'PreToolUse',
      cwd: target.cwd,
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: "I'd like to refactor the auth flow. Which approach should I use?",
            header: 'Auth refactor',
            multiSelect: false,
            options: [
              { label: 'Drop-in oauth2 lib', description: 'Lowest risk, conventional. ~1 day.' },
              { label: 'Hand-roll PKCE', description: 'Maximum control, more code to maintain.' },
              { label: 'Defer to next sprint', description: 'Document the constraint, ship the rest.' },
            ],
          },
        ],
      },
      tool_use_id: toolUseId,
    }).catch(() => {});
    target.pendingAskToolUseId = toolUseId;
    return null;
  },

  async 'answer-question-delayed'({ page, beat }) {
    // Wait most of the beat before answering so the user reads the dialog
    // while the narrator explains the intercept, then watches it dismiss.
    const target = spawned.find((s) => s.pendingAskToolUseId);
    if (!target) return null;
    const dwellMs = Math.max(0, beat.durationSec * 1000 - 2400);
    await sleep(dwellMs);
    // Click first option chip.
    await safeClick(page, '.question-option');
    await sleep(600);
    // Click ANSWER button (button.allow with text ANSWER).
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button.allow')).find(
        (b) => /answer/i.test(b.textContent ?? ''),
      );
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) console.warn('  ANSWER button not found');
    target.pendingAskToolUseId = undefined;
    return null;
  },

  async 'pan-camera'({ page }) {
    // A slow, full-width pan during a noop narration beat.
    await dragPan(page, -300);
    await sleep(600);
    await dragPan(page, 300);
    return null;
  },

  async 'fake-transcript'({ page }) {
    // Inject a tool burst on a session so the fold UI is visible in the panel.
    if (spawned.length === 0) return null;
    const target = spawned[1] ?? spawned[0];
    // Mark this worker as selected so the ambient ticker leaves them alone
    // (otherwise random Read/Edit calls land between our deliberate ones and
    // the chip count looks weird).
    currentSelectedSid = target.sessionId;
    const tools = ['Read', 'Grep', 'Read', 'Read', 'Edit', 'Read', 'Grep', 'Edit', 'Bash', 'Read', 'Edit', 'Write'];
    for (const t of tools) {
      await fireTool(target.sessionId, target.cwd, t);
      await sleep(70);
    }
    return null;
  },

  async 'spawn-more-then-pan'({ page }) {
    // Spawn enough to force a second room, then pan across.
    const startCount = spawned.length;
    for (let i = 0; i < 5; i++) {
      await startSession({
        cwd: CWDS[(startCount + i) % CWDS.length],
        prompt: PROMPTS[(startCount + i) % PROMPTS.length],
      });
      await sleep(280);
    }
    await sleep(600);
    await dragPan(page, -400);
    return null;
  },

  async 'zoom-in-status'({ page }) {
    // Just a slow pan to highlight the top-right status bar area.
    await dragPan(page, 200);
    await sleep(400);
    await dragPan(page, -200);
    return null;
  },

  async 'cycle-themes'({ page }) {
    // Robust theme cycle: click + dwell, in a serial loop, so each scene is
    // visible for ~3s. page.click handles waiting for actionability.
    const themeCount = 5;          // cozy/modern/school/lab/construction
    const cycleCount = themeCount - 1; // we're starting on cozy; click 4 times to traverse the rest
    const dwellMs = 2800;
    let running = true;
    (async () => {
      for (let i = 0; i < cycleCount && running; i++) {
        const ok = await safeClick(page, '.scene-switcher-btn');
        const title = await page.evaluate(
          () => document.querySelector('.scene-switcher-btn')?.title ?? '?',
        ).catch(() => '?');
        console.log(`    theme click ${i + 1}: ${ok ? 'OK' : 'FAIL'} → ${title}`);
        if (!running) break;
        await sleep(dwellMs);
      }
    })();
    return { stop: () => { running = false; } };
  },

  async outro({ page }) {
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.side-panel .close-btn');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    return null;
  },

  // -- Teaser actions (20s no-narration variant) -----------------------------

  async 'teaser-spawn-rush'({ page }) {
    // Despawn anything already there, then rapid-fire 4 workers so the office
    // visibly fills up in ~3 seconds. Zoom is left alone — the renderer's
    // auto-fit recenter handles the camera naturally as population grows.
    for (const { sessionId } of spawned.splice(0)) await despawn(sessionId);
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.side-panel .close-btn');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    await sleep(150);
    for (let i = 0; i < 4; i++) {
      await startSession({ cwd: CWDS[i], prompt: PROMPTS[i] });
      await sleep(550);
    }
    return null;
  },

  async 'teaser-ask-answer'({ page, beat }) {
    // Single-beat ask + answer: trigger the question, dwell while the ? sign
    // and dialog are visible, then click an option + ANSWER. Mirrors the
    // narrated 03-ask + 04-answer pair, compressed into one beat.
    if (spawned.length === 0) return null;
    const target = spawned[0];
    const toolUseId = randomUUID();
    hook({
      session_id: target.sessionId,
      hook_event_name: 'PreToolUse',
      cwd: target.cwd,
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: "Refactor the auth flow — which approach?",
            header: 'Auth refactor',
            multiSelect: false,
            options: [
              { label: 'Drop-in oauth2 lib', description: 'Lowest risk, ~1 day.' },
              { label: 'Hand-roll PKCE', description: 'Maximum control.' },
              { label: 'Defer next sprint', description: 'Document, ship the rest.' },
            ],
          },
        ],
      },
      tool_use_id: toolUseId,
    }).catch(() => {});
    target.pendingAskToolUseId = toolUseId;
    // Dwell on the dialog for most of the beat, then answer near the end.
    const dwellMs = Math.max(0, beat.durationSec * 1000 - 1600);
    await sleep(dwellMs);
    await safeClick(page, '.question-option');
    await sleep(500);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button.allow')).find(
        (b) => /answer/i.test(b.textContent ?? ''),
      );
      if (btn) btn.click();
    }).catch(() => {});
    target.pendingAskToolUseId = undefined;
    return null;
  },

  async 'teaser-cycle-themes'({ page, beat }) {
    // Fast theme tour. Transition count is derived from beat duration so the
    // pacing stays consistent whether the manifest gives this beat 3s or 6s.
    // ~950ms dwell per scene feels snappy without being jumpy.
    const dwellMs = 950;
    const transitions = Math.max(2, Math.floor((beat.durationSec * 1000) / dwellMs));
    let running = true;
    (async () => {
      for (let i = 0; i < transitions && running; i++) {
        await safeClick(page, '.scene-switcher-btn');
        if (!running) break;
        await sleep(dwellMs);
      }
    })();
    return { stop: () => { running = false; } };
  },

  async 'teaser-expand-calls'({ page }) {
    // The ask-answer beat left the panel open on spawned[0] with the question
    // answered. Fire a burst of tool calls on that same worker so the panel's
    // fold UI coalesces them into a "N calls" chip, then click the chip to
    // expand the group. Marks the worker as "selected" in the ambient ticker
    // so random tools don't land in the middle of our deliberate sequence.
    if (spawned.length === 0) return null;
    const target = spawned[0];
    currentSelectedSid = target.sessionId;
    const tools = ['Read', 'Grep', 'Read', 'Edit', 'Read'];
    for (const t of tools) {
      await fireTool(target.sessionId, target.cwd, t);
      await sleep(80);
    }
    await sleep(500);
    // Click the most recent fold-chip — there may be more than one chip in the
    // transcript history; the orchestrator's burst created the LAST one, so
    // clicking the last `.tool-group.collapsed .tool-group-chip` targets it.
    await page.evaluate(() => {
      const chips = document.querySelectorAll('.tool-group.collapsed .tool-group-chip');
      const last = chips[chips.length - 1];
      if (last) last.click();
    }).catch(() => {});
    return null;
  },

  async 'teaser-expand-scenes'({ page }) {
    // Click the chevron next to the scene switcher to open the popup picker
    // that lists every available scene. The popup auto-closes if the user
    // clicks outside, so we hold without dismissing.
    await page.evaluate(() => {
      const chev = document.querySelector('button.scene-switcher-chev');
      if (chev) chev.click();
    }).catch(() => {});
    return null;
  },

  async 'teaser-multiroom'({ page }) {
    // Spawn 6 more workers (4 + 6 = 10 > workersPerRoom=6) so a second room
    // appears and the centroid shifts. The renderer's recenterOnWorkers
    // (triggered on each add) re-fits and pans the camera with a smooth lerp,
    // so the camera moves on its own as the office grows.
    const startIdx = spawned.length;
    for (let i = 0; i < 6; i++) {
      await startSession({
        cwd: CWDS[(startIdx + i) % CWDS.length],
        prompt: PROMPTS[(startIdx + i) % PROMPTS.length],
      });
      await sleep(380);
    }
    return null;
  },

  async 'teaser-outro'({ page }) {
    // Close any open panel for a clean closing composition. Camera continues
    // to settle from the last recenter.
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.side-panel .close-btn');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    return null;
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`no manifest at ${MANIFEST_PATH} — run generate-tts.mjs first`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

  console.log(`connecting to ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = await pickRendererPage(browser);
  if (!page) {
    console.error('no renderer page found — is the dev server running?');
    process.exit(1);
  }
  await page.bringToFront().catch(() => {});

  const totalSec = manifest.beats.reduce((s, b) => s + b.durationSec, 0);
  console.log(`${manifest.beats.length} beats, total ${totalSec.toFixed(1)}s`);
  if (RECORD) writeFileSync(CUES_PATH, '');

  // Ambient activity ticker — runs the whole show.
  startAmbient();

  const startWall = Date.now();
  let cursorSec = 0;
  for (const beat of manifest.beats) {
    const wall = ((Date.now() - startWall) / 1000).toFixed(2);
    console.log(`[+${wall}s | beat-cursor ${cursorSec.toFixed(2)}s] ${beat.id} — ${beat.action} (${beat.durationSec.toFixed(2)}s)`);
    if (RECORD) {
      writeFileSync(CUES_PATH, readFileSync(CUES_PATH, 'utf-8') + `${cursorSec.toFixed(3)}\t${beat.id}\t${beat.action}\n`);
    }

    const fn = ACTIONS[beat.action];
    if (!fn) console.warn(`  ! unknown action: ${beat.action}`);
    // Fire-and-forget — never block the run loop on action work. The action
    // either returns synchronously, returns a tick {stop()}, or schedules
    // its own delayed work via setTimeout. Awaiting it would drift wall
    // time past beat-cursor and break audio sync.
    let tickP = null;
    if (fn) {
      try {
        tickP = Promise.resolve(fn({ page, beat })).catch((e) => {
          console.error(`  ! action ${beat.action} threw: ${e.message}`);
          return null;
        });
      } catch (e) {
        console.error(`  ! action ${beat.action} threw sync: ${e.message}`);
      }
    }

    await sleep(beat.durationSec * 1000);
    if (tickP) {
      const tick = await tickP;
      if (tick && typeof tick.stop === 'function') tick.stop();
    }
    cursorSec += beat.durationSec;
  }

  stopAmbient();
  console.log(`done in ${((Date.now() - startWall) / 1000).toFixed(2)}s`);
  await browser.close().catch(() => {});
}

main().catch((e) => {
  stopAmbient();
  console.error(e);
  process.exit(1);
});
