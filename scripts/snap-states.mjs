// Drives the daemon through a scripted session, screenshotting state transitions
// from the live Electron window via CDP.  Run from project root:
//   node scripts/snap-states.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN = readFileSync(join(homedir(), '.claude', '.stardew-clawd-token'), 'utf-8').trim();
const HOST = 'http://127.0.0.1:47821';

async function post(path, body) {
  const r = await fetch(HOST + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function hook(payload) {
  return post('/hook', payload);
}

// Connect to the Electron renderer via CDP.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
let page;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    if (p.url().includes('localhost:5173')) { page = p; break; }
  }
}
if (!page) throw new Error('renderer page not found');
console.log('found renderer:', page.url());

async function snap(name) {
  await page.screenshot({ path: `/tmp/state-${name}.png` });
  console.log(`saved /tmp/state-${name}.png`);
}

const SID_A = 'snap-session-alpha';
const SID_B = 'snap-session-beta';

// 1) Spawn alpha — walks in from the door
await hook({ session_id: SID_A, hook_event_name: 'SessionStart', cwd: '/tmp/snap-alpha', source: 'startup' });
await new Promise(r => setTimeout(r, 200));
await snap('01-spawn');

// 2) Let alpha walk to desk and idle
await new Promise(r => setTimeout(r, 1500));
await snap('02-arrived-at-desk');

// 3) UserPromptSubmit → thinking
await hook({ session_id: SID_A, hook_event_name: 'UserPromptSubmit', prompt: 'help me explore' });
await new Promise(r => setTimeout(r, 700));
await snap('03-thinking');

// 4) A burst: Read, Grep, then Edit — should collapse to coding (highest priority)
await hook({ session_id: SID_A, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 'tu1' });
await new Promise(r => setTimeout(r, 100));
// Re-set activity by re-firing PreToolUse-like via PostToolUse (we narrowed PreToolUse matcher)
// Easier: simulate by setting activity via subsequent PostToolUse cycles.
// Actually update intent by sending a Bash one:
await hook({ session_id: SID_A, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu2', tool_response: { exit_code: 0 } });
await new Promise(r => setTimeout(r, 800));
await snap('04-thinking-after-tools');

// 5) WebFetch — should send worker to bookshelf after sustained intent
// We don't have a non-intercepted PreToolUse path through the daemon (matcher blocks it),
// so we simulate by directly forcing intent via a fake AskUserQuestion to looking_up...
// Easier: use a direct intent-write helper. Since we don't have one, post a sequence
// of PostToolUse for WebFetch which the daemon will treat as thinking, not looking_up.
// To test the walk-to-bookshelf, we need real intent. Do it via the session-store
// indirectly: we'll emit an AskUserQuestion to put the worker into holding state,
// resolve it, and observe the return.
const askPromise = hook({
  session_id: SID_A, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
  tool_use_id: 'tuq1',
  tool_input: { questions: [{ question: 'Pick a fruit', header: 'Fruit', multiSelect: false, options: [{label:'Apple'},{label:'Pear'},{label:'Mango', description: 'sweet'}] }] }
});
await new Promise(r => setTimeout(r, 700));
await snap('05-holding-question');

// 6) Answer the question via the panel
await post('/sessions/question-answer', { toolUseId: 'tuq1', answers: [{ value: 'Mango' }] });
await askPromise;
await new Promise(r => setTimeout(r, 500));
await snap('06-back-to-desk');

// 7) Plan mode
const planPromise = hook({
  session_id: SID_A, hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode',
  tool_use_id: 'tup1',
  tool_input: { plan: '## Plan\n1. Read all README files\n2. Sketch the architecture\n3. Identify weak points\n4. Propose 3 cleanup PRs\n' }
});
await new Promise(r => setTimeout(r, 700));
await snap('07-holding-plan');

await post('/sessions/plan-decision', { toolUseId: 'tup1', accept: true, feedback: 'sounds good' });
await planPromise;
await new Promise(r => setTimeout(r, 500));
await snap('08-after-plan');

// 8) Bring up a second worker — beta
await hook({ session_id: SID_B, hook_event_name: 'SessionStart', cwd: '/tmp/snap-beta', source: 'startup' });
await new Promise(r => setTimeout(r, 1500));
await snap('09-two-workers');

// 9) Beta gets a Notification → idle waiting → coffee soon (after coffeeBreakIdleMs).
//    We can't wait 30s in this short script, so just confirm activity flips.
await hook({ session_id: SID_B, hook_event_name: 'Notification' });
await new Promise(r => setTimeout(r, 500));
await snap('10-notification');

// 10) Spawn a subagent worker (SID_C). SubagentStop later makes them walk out.
const SID_C = 'snap-helper-gamma';
await hook({ session_id: SID_C, hook_event_name: 'SessionStart', cwd: '/tmp/snap-helper', source: 'startup' });
await new Promise(r => setTimeout(r, 1500));
await snap('11-helper-arrived');

// 11) SubagentStop → walks out the door
await hook({ session_id: SID_C, hook_event_name: 'SubagentStop' });
await new Promise(r => setTimeout(r, 600));
await snap('12-helper-leaving');
await new Promise(r => setTimeout(r, 4500));
await snap('13-helper-gone');

await browser.close();
console.log('all done');
