#!/usr/bin/env node
/*
 * stardew-clawd hook bridge.
 *
 * Invoked by Claude Code for every configured hook event. Reads the JSON payload
 * from stdin, POSTs it to the local daemon, and (for PreToolUse) writes the
 * decision JSON to stdout so Claude can act on it.
 *
 * All settings come from config files; no values are hard-coded.
 * If the daemon is unreachable, the hook fails open (exits 0 with no output)
 * so the user is never blocked.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function findConfigDir() {
  if (process.env.STARDEW_OFFICE_CONFIG_DIR) return process.env.STARDEW_OFFICE_CONFIG_DIR;
  // Walk up from this file.
  let cur = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(cur, 'config', 'app.config.json');
    if (fs.existsSync(candidate)) return path.join(cur, 'config');
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function loadConfig() {
  const dir = findConfigDir();
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'app.config.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function readToken(p) {
  try {
    return fs.readFileSync(p, 'utf-8').trim();
  } catch {
    return '';
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function post(opts) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(opts.body);
    const req = http.request(
      {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          authorization: `Bearer ${opts.token}`,
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  const cfg = loadConfig();
  if (!cfg) {
    // No config → fail open. (Daemon not installed.)
    process.exit(0);
  }
  const token = readToken(expandHome(cfg.tokenPath));
  const payload = await readStdin();
  if (!payload) process.exit(0);

  let event = '';
  try {
    const j = JSON.parse(payload);
    event = j.hook_event_name || '';
  } catch {
    process.exit(0);
  }

  // PreToolUse needs the full timeout; others just fire-and-forget.
  const isBlocking = event === 'PreToolUse';
  const timeoutMs = isBlocking
    ? Math.max(5000, (cfg.hooks.preToolUseTimeoutSec - 5) * 1000)
    : 3000;

  try {
    const res = await post({
      host: cfg.daemon.host,
      port: cfg.daemon.httpPort,
      path: '/hook',
      token,
      body: payload,
      timeoutMs,
    });
    if (isBlocking && res.body) {
      // The daemon returned a PreToolUseHookOutput JSON; pipe it to stdout.
      try {
        const out = JSON.parse(res.body);
        if (out && out.hookSpecificOutput) {
          process.stdout.write(JSON.stringify(out));
        }
      } catch {
        // ignore
      }
    }
    process.exit(0);
  } catch {
    // Daemon down or refused. Fail open.
    process.exit(0);
  }
})();
