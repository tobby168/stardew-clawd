#!/usr/bin/env node
/*
 * Idempotently install the stardew-clawd hook bridge into a settings.json.
 * Default scope is project-local (.claude/settings.json in the project root),
 * which is safe during development.
 *
 * Pass --global to install into ~/.claude/settings.json (observes EVERY claude
 * session on this machine). Required for the "magical, all sessions" demo.
 *
 * Tags all entries with a marker key so uninstall can remove only ours.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const projectRoot = path.resolve(__dirname, '..');
const cfg = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'config', 'app.config.json'), 'utf-8'),
);

const args = process.argv.slice(2);
const wantGlobal = args.includes('--global');
const scope = wantGlobal ? 'global' : cfg.hooks.defaultScope ?? 'local';

const settingsRaw = scope === 'global' ? cfg.hooks.settingsFileGlobal : cfg.hooks.settingsFileLocal;
const settingsPath = path.isAbsolute(settingsRaw)
  ? settingsRaw
  : settingsRaw.startsWith('~')
    ? expandHome(settingsRaw)
    : path.join(projectRoot, settingsRaw);

const marker = cfg.hooks.markerKey;
const bridge = path.join(projectRoot, 'scripts', 'hooks', 'hook-bridge.cjs');

if (!fs.existsSync(bridge)) {
  console.error(`bridge script missing: ${bridge}`);
  process.exit(1);
}

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
} catch {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  settings = {};
}

if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

const cmd = `STARDEW_OFFICE_CONFIG_DIR=${JSON.stringify(path.join(projectRoot, 'config'))} node ${JSON.stringify(bridge)}`;

const ourEntry = (timeoutSec) => ({
  type: 'command',
  command: cmd,
  ...(timeoutSec ? { timeout: timeoutSec } : {}),
  [marker]: true,
});

const matchers = (cfg.hooks.eventMatchers && typeof cfg.hooks.eventMatchers === 'object')
  ? cfg.hooks.eventMatchers
  : {};

for (const event of cfg.hooks.events) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  // Strip any previous stardew-clawd entries.
  settings.hooks[event] = settings.hooks[event].filter((group) => {
    if (!group || !Array.isArray(group.hooks)) return true;
    group.hooks = group.hooks.filter((h) => !(h && h[marker]));
    return group.hooks.length > 0;
  });
  // Append our group. PreToolUse uses the configured matcher (narrowed to
  // interactive tools only); everything else fires for all tools.
  const timeoutSec = event === 'PreToolUse' ? cfg.hooks.preToolUseTimeoutSec : undefined;
  const matcher = matchers[event] || '*';
  settings.hooks[event].push({
    matcher,
    hooks: [ourEntry(timeoutSec)],
  });
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
console.log(`installed hooks (${scope}) into ${settingsPath}`);
console.log(`events: ${cfg.hooks.events.join(', ')}`);
console.log(`bridge: ${bridge}`);
if (scope === 'local') {
  console.log(`\nThis is the safe default: hooks only fire when you run claude from`);
  console.log(`inside ${projectRoot}`);
  console.log(`\nTo install hooks for EVERY claude session on the machine, re-run with --global.`);
}
