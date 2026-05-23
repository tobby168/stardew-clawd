#!/usr/bin/env node
/*
 * Remove stardew-clawd entries from the configured settings file.
 *
 * Defaults to project-local. Pass --global to clean the global settings file
 * instead, --all to clean both.
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
const wantAll = args.includes('--all');
const wantGlobal = args.includes('--global');
const marker = cfg.hooks.markerKey;

const targets = [];
if (wantAll || !wantGlobal) {
  const local = path.isAbsolute(cfg.hooks.settingsFileLocal)
    ? cfg.hooks.settingsFileLocal
    : path.join(projectRoot, cfg.hooks.settingsFileLocal);
  targets.push(local);
}
if (wantAll || wantGlobal) {
  targets.push(expandHome(cfg.hooks.settingsFileGlobal));
}

for (const settingsPath of targets) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    console.log(`no settings.json at ${settingsPath}; skipping`);
    continue;
  }

  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event]
        .map((group) => {
          if (!group || !Array.isArray(group.hooks)) return group;
          group.hooks = group.hooks.filter((h) => !(h && h[marker]));
          return group;
        })
        .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  console.log(`removed stardew-clawd hooks from ${settingsPath}`);
}
