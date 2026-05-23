// Tight focus on the subagent visualization: spawn, walk in, sit, SubagentStop,
// walk out, despawn.  Captures lots of intermediate frames so the path is clear.
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

async function hook(payload) { return post('/hook', payload); }

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
let page;
for (const ctx of browser.contexts()) {
  for (const p of ctx.pages()) {
    if (p.url().includes('localhost:5173')) { page = p; break; }
  }
}
if (!page) throw new Error('renderer not found');
console.log('renderer at', page.url());

async function snap(name) {
  await page.screenshot({ path: `/tmp/sub-${name}.png` });
  console.log('→ /tmp/sub-' + name + '.png');
}

// Clean slate: despawn anything labelled snap-* from prior runs
for (const sid of ['snap-helper-gamma', 'snap-helper-delta', 'snap-session-alpha', 'snap-session-beta']) {
  await post('/sessions/despawn', { sessionId: sid }).catch(() => {});
}

// Establish a parent worker so the helper has a context to appear alongside.
const PARENT = 'sub-demo-parent';
const HELPER = 'sub-demo-helper';
await hook({ session_id: PARENT, hook_event_name: 'SessionStart', cwd: '/repos/my-app', source: 'startup' });
await new Promise(r => setTimeout(r, 1800));        // parent walks in
await hook({ session_id: PARENT, hook_event_name: 'UserPromptSubmit', prompt: 'analyze the codebase' });
await new Promise(r => setTimeout(r, 600));         // parent enters thinking
await snap('00-parent-only');

// Helper appears (parent fired Task → child session_id starts).
await hook({ session_id: HELPER, hook_event_name: 'SessionStart', cwd: '/repos/my-app/helper', source: 'startup' });
await snap('01-helper-spawn');                       // helper at the door
await new Promise(r => setTimeout(r, 600));
await snap('02-helper-midwalk');                     // walking toward desk
await new Promise(r => setTimeout(r, 1400));
await snap('03-helper-seated');                      // helper at desk (no [sub] yet — Task tool fired, SubagentStop not yet)

// Helper does some "work" — set its activity through PostToolUse events the
// same way Claude would. (Tool routing is config-driven so this updates intent.)
await hook({ session_id: HELPER, hook_event_name: 'UserPromptSubmit', prompt: 'subagent: scan modules' });
await new Promise(r => setTimeout(r, 800));
await snap('04-helper-thinking');

await hook({ session_id: HELPER, hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: {}, tool_use_id: 'h-tu1', tool_response: {} });
await new Promise(r => setTimeout(r, 700));
await snap('05-helper-after-grep');

// SubagentStop — daemon marks isSubagent + sets activity 'leaving'.
await hook({ session_id: HELPER, hook_event_name: 'SubagentStop' });
await new Promise(r => setTimeout(r, 200));
await snap('06-helper-getup');                       // just started walking, [sub] tag now visible
await new Promise(r => setTimeout(r, 900));
await snap('07-helper-midexit');                     // halfway to door
await new Promise(r => setTimeout(r, 1600));
await snap('08-helper-near-door');                   // near door
await new Promise(r => setTimeout(r, 1200));
await snap('09-helper-despawned');                   // gone, count drops back

await browser.close();
console.log('all frames saved');
