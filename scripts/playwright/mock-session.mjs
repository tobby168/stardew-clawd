#!/usr/bin/env node
/*
 * Drive the daemon with a sequence of mock hook payloads to exercise the
 * full session lifecycle without spending real Claude API credit.
 *
 * Usage:
 *   node scripts/playwright/mock-session.mjs [--sessions=N] [--activity=...]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const HOST = process.env.STARDEW_OFFICE_HOST ?? '127.0.0.1';
const PORT = process.env.STARDEW_OFFICE_HTTP_PORT ?? '47821';
const TOKEN = readFileSync(`${homedir()}/.claude/.stardew-clawd-token`, 'utf-8').trim();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] || true] : [a, true];
  }),
);

const SESSION_COUNT = Number(args.sessions ?? 3);

async function post(path, body) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

async function sendHook(payload) {
  return post('/hook', payload);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CWDS = [
  '/Users/tobby168/Repositories/awesome-project',
  '/Users/tobby168/Repositories/data-pipeline',
  '/Users/tobby168/Repositories/billing-service',
  '/Users/tobby168/Repositories/mobile-app',
  '/Users/tobby168/Repositories/internal-tools',
];

const PROMPTS = [
  'refactor the authentication module to use the new oauth flow',
  'find and fix the bug in the checkout flow',
  'write tests for the user registration endpoint',
  'update dependencies and run the test suite',
  'explain how the websocket reconnect logic works',
];

const TOOL_SEQUENCE = [
  { tool: 'Read', input: (cwd) => ({ file_path: `${cwd}/README.md` }), state: 'reading' },
  { tool: 'Grep', input: () => ({ pattern: 'TODO', path: '.' }), state: 'reading' },
  { tool: 'Read', input: (cwd) => ({ file_path: `${cwd}/src/index.ts` }), state: 'reading' },
  { tool: 'Edit', input: (cwd) => ({ file_path: `${cwd}/src/index.ts`, old_string: 'foo', new_string: 'bar' }), state: 'writing' },
  { tool: 'Bash', input: () => ({ command: 'npm test', description: 'Run test suite' }), state: 'bash' },
  { tool: 'Read', input: (cwd) => ({ file_path: `${cwd}/package.json` }), state: 'reading' },
];

async function spawnSession(index) {
  const sessionId = randomUUID();
  const cwd = CWDS[index % CWDS.length];
  const prompt = PROMPTS[index % PROMPTS.length];

  // SessionStart
  await sendHook({
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    cwd,
    source: 'startup',
    model: 'claude-opus-4-7',
  });
  await sleep(120);

  // UserPromptSubmit
  await sendHook({
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    cwd,
    prompt,
  });
  await sleep(200);

  // Drive a tool sequence
  for (let i = 0; i < TOOL_SEQUENCE.length; i++) {
    const step = TOOL_SEQUENCE[i];
    const toolUseId = randomUUID();
    // PreToolUse — auto-allowed for Read/Grep, ask for Bash/Edit; daemon decides
    sendHook({
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: step.tool,
      tool_input: step.input(cwd),
      tool_use_id: toolUseId,
    }).catch(() => {});
    await sleep(400);
    // PostToolUse
    await sendHook({
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      cwd,
      tool_name: step.tool,
      tool_input: step.input(cwd),
      tool_use_id: toolUseId,
      tool_response: 'ok',
    });
    await sleep(300);
  }

  // Stop
  await sendHook({
    session_id: sessionId,
    hook_event_name: 'Stop',
    cwd,
  });
  return sessionId;
}

(async () => {
  console.log(`spawning ${SESSION_COUNT} mock session(s)`);
  const ids = [];
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = await spawnSession(i);
    ids.push(id);
    console.log(`  session ${i + 1}: ${id.slice(0, 8)}…`);
    await sleep(200);
  }
  console.log('done');
})();
