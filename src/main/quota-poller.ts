import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { configRoot, loadStatusBarConfig } from '@shared/config';
import type { ClassicRateLimit, UsageAuthMode, UsageSnapshot, UsageWindow } from '@shared/events';

const cfg = loadStatusBarConfig();

// Find the project's .env. Cannot rely on process.cwd() — Electron's main
// process changes it during app init, and our resolver runs inside the
// `app.whenReady()` callback (whereas resume-runner.ts dodges this by loading
// its env at module-import time). Anchor on configRoot() instead: it walks
// up to find `config/` once and caches the result.
function findDotEnv(): string | null {
  const anchors: string[] = [];
  try { anchors.push(dirname(configRoot())); } catch {}
  anchors.push(process.cwd());
  for (let cur of anchors) {
    for (let i = 0; i < 8; i++) {
      const p = join(cur, '.env');
      if (existsSync(p)) return p;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return null;
}

function loadEnvFromDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = findDotEnv();
  if (!p) return out;
  try {
    const text = readFileSync(p, 'utf-8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (/^sk-(ant-)?x+$/i.test(val) || /^x+$/i.test(val)) continue;
      out[key] = val;
    }
  } catch {
    // missing or unreadable — fall through
  }
  return out;
}

interface ResolvedAuth {
  mode: UsageAuthMode;
  /** Headers to send with the probe call. */
  headers: Record<string, string>;
  /** A short tag for logs (never logs the secret itself). */
  tag: string;
  /** Unix ms when this credential is known to expire (OAuth only). */
  expiresAt?: number;
}

function readKeychainOauth(): { token: string; expiresAt?: number } | null {
  if (process.platform !== 'darwin') return null;
  try {
    const r = spawnSync(
      'security',
      ['find-generic-password', '-s', cfg.auth.keychainService, '-a', userInfo().username, '-w'],
      { timeout: 5000 },
    );
    if (r.status !== 0) return null;
    const raw = r.stdout.toString().trim();
    try {
      const parsed = JSON.parse(raw);
      const blob = parsed?.claudeAiOauth ?? parsed;
      if (!blob?.accessToken) return null;
      // expiresAt may be stored as ISO string or epoch (ms or s). Normalize → ms.
      let expiresAt: number | undefined;
      if (typeof blob.expiresAt === 'string') {
        const t = Date.parse(blob.expiresAt);
        if (Number.isFinite(t)) expiresAt = t;
      } else if (typeof blob.expiresAt === 'number') {
        // Heuristic: seconds vs. ms.
        expiresAt = blob.expiresAt < 1e12 ? blob.expiresAt * 1000 : blob.expiresAt;
      }
      return { token: blob.accessToken, expiresAt };
    } catch {
      if (raw.startsWith('sk-ant-')) return { token: raw };
      return null;
    }
  } catch {
    return null;
  }
}

// Use `||` not `??`: empty-string env vars (e.g. when the parent shell exported
// the var as "") would otherwise tunnel through and override the .env value.
function pickEnv(name: string, dotenv: Record<string, string>): string | undefined {
  return process.env[name] || dotenv[name] || undefined;
}

function resolveApiKey(dotenv: Record<string, string>): ResolvedAuth {
  const envApiKey = pickEnv(cfg.auth.envApiKey, dotenv);
  if (envApiKey) {
    return {
      mode: 'api_key',
      headers: { 'x-api-key': envApiKey },
      tag: `env:${cfg.auth.envApiKey}`,
    };
  }
  return { mode: 'none', headers: {}, tag: 'none' };
}

function resolveAuth(): ResolvedAuth {
  const dotenv = loadEnvFromDotEnv();
  const envOauth = pickEnv(cfg.auth.envOauthToken, dotenv);
  if (envOauth) {
    return {
      mode: 'oauth',
      headers: {
        authorization: `Bearer ${envOauth}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      tag: `env:${cfg.auth.envOauthToken}`,
    };
  }

  // macOS Keychain. We return the keychain creds even if expired — the
  // refresh path in doPoll() will piggyback on `claude -p ping` to make
  // the CLI rotate the token (it's already installed; that's how the
  // keychain entry got there in the first place). If refresh fails or no
  // CLI is on PATH, the probe surfaces 401 and the runtime fallback in
  // doPoll() demotes to the API key. Port of:
  // https://github.com/HermannBjorgvin/Clawdmeter/pull/32
  const kc = readKeychainOauth();
  if (kc) {
    return makeOauthAuth(kc, 'keychain');
  }

  return resolveApiKey(dotenv);
}

function makeOauthAuth(kc: { token: string; expiresAt?: number }, tag: string): ResolvedAuth {
  return {
    mode: 'oauth',
    headers: {
      authorization: `Bearer ${kc.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    tag,
    expiresAt: kc.expiresAt,
  };
}

/**
 * Spawn `claude -p ping` so the CLI auto-refreshes its OAuth token and
 * persists the new value back to the same keychain entry we read from.
 * Resolves true on a clean exit within the timeout, false otherwise
 * (CLI missing, hung, or exited non-zero). Always fails open — never
 * throws — so the caller can fall through with stale credentials.
 */
function triggerCliRefresh(): Promise<boolean> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cfg.refresh.command, cfg.refresh.args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      console.warn(`[quota-poller] cannot spawn ${cfg.refresh.command}: ${(e as Error).message}`);
      resolve(false);
      return;
    }
    let stderr = '';
    proc.stderr?.on('data', (c) => {
      stderr += c.toString();
      if (stderr.length > 1000) stderr = stderr.slice(-1000);
    });
    const killTimer = setTimeout(() => {
      console.warn(`[quota-poller] ${cfg.refresh.command} hung past ${cfg.refresh.timeoutMs}ms, killing`);
      try { proc.kill('SIGKILL'); } catch {}
      resolve(false);
    }, cfg.refresh.timeoutMs);
    proc.on('error', (e) => {
      clearTimeout(killTimer);
      console.warn(`[quota-poller] ${cfg.refresh.command} spawn error: ${e.message}`);
      resolve(false);
    });
    proc.on('exit', (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve(true);
      } else {
        const tail = stderr.trim().split('\n').pop()?.slice(0, 200) ?? '';
        console.warn(`[quota-poller] ${cfg.refresh.command} exited ${code}: ${tail}`);
        resolve(false);
      }
    });
  });
}

// The wire format abbreviates window types: `5h`, `7d`, `7d_opus`, `7d_sonnet`.
// (cli.js's `five_hour` / `seven_day` strings are the parsed `rateLimitType`
// enum — internal state, not header names. Confirmed against Clawdmeter's
// daemon which has been polling these in production:
// https://github.com/HermannBjorgvin/Clawdmeter/blob/HEAD/daemon/claude_usage_daemon.py)
type UnifiedWire = '5h' | '7d' | '7d_opus' | '7d_sonnet';

function parseUnifiedWindow(headers: Headers, wire: UnifiedWire): UsageWindow | undefined {
  const u = headers.get(`anthropic-ratelimit-unified-${wire}-utilization`);
  const r = headers.get(`anthropic-ratelimit-unified-${wire}-reset`);
  if (u == null && r == null) return undefined;
  const util = u != null ? Number(u) : NaN;
  const reset = r != null ? Number(r) : NaN;
  if (!Number.isFinite(util) && !Number.isFinite(reset)) return undefined;
  return {
    utilization: Number.isFinite(util) ? util : 0,
    resetsAt: Number.isFinite(reset) ? reset : 0,
  };
}

function parseClassic(headers: Headers, kind: 'input-tokens' | 'output-tokens' | 'tokens' | 'requests'): ClassicRateLimit | undefined {
  const limit = headers.get(`anthropic-ratelimit-${kind}-limit`);
  const remaining = headers.get(`anthropic-ratelimit-${kind}-remaining`);
  const reset = headers.get(`anthropic-ratelimit-${kind}-reset`);
  if (limit == null && remaining == null && reset == null) return undefined;
  // Classic resets are ISO timestamps — convert to unix seconds for the wire format.
  const resetsAt = reset ? Math.floor(new Date(reset).getTime() / 1000) : 0;
  return {
    limit: limit ? Number(limit) : 0,
    remaining: remaining ? Number(remaining) : 0,
    resetsAt,
  };
}

function parseSnapshot(headers: Headers, mode: UsageAuthMode): UsageSnapshot {
  const snap: UsageSnapshot = { fetchedAt: Date.now(), auth: mode };
  const unified = {
    five_hour: parseUnifiedWindow(headers, '5h'),
    seven_day: parseUnifiedWindow(headers, '7d'),
    seven_day_opus: parseUnifiedWindow(headers, '7d_opus'),
    seven_day_sonnet: parseUnifiedWindow(headers, '7d_sonnet'),
  };
  if (Object.values(unified).some(Boolean)) snap.unified = unified;

  const classic = {
    inputTokens: parseClassic(headers, 'input-tokens'),
    outputTokens: parseClassic(headers, 'output-tokens'),
    tokens: parseClassic(headers, 'tokens'),
    requests: parseClassic(headers, 'requests'),
  };
  if (Object.values(classic).some(Boolean)) snap.classic = classic;
  return snap;
}

export class QuotaPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private auth: ResolvedAuth = { mode: 'none', headers: {}, tag: 'unresolved' };
  private last: UsageSnapshot = { fetchedAt: 0, auth: 'none' };
  private inFlight: Promise<void> | null = null;

  start() {
    this.auth = resolveAuth();
    console.log(`[quota-poller] auth resolved via ${this.auth.tag} (mode=${this.auth.mode})`);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), cfg.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): UsageSnapshot {
    return this.last;
  }

  /** External callers (e.g. on-window-focus) can request an immediate refresh. */
  refresh(): Promise<void> {
    return this.poll();
  }

  on(event: 'usage', listener: (snap: UsageSnapshot) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emit(event: 'usage', snap: UsageSnapshot): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doPoll().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async probeOnce(auth: ResolvedAuth): Promise<UsageSnapshot> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), cfg.probe.timeoutMs);
    try {
      const res = await fetch(cfg.probe.url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': cfg.probe.anthropicVersion,
          'user-agent': cfg.probe.userAgent,
          ...auth.headers,
        },
        body: JSON.stringify({
          model: cfg.probe.model,
          max_tokens: cfg.probe.maxTokens,
          messages: [{ role: 'user', content: '.' }],
        }),
      });
      const snap = parseSnapshot(res.headers, auth.mode);
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 200); } catch {}
        snap.error = `HTTP ${res.status}${body ? ` — ${body}` : ''}`;
      }
      return snap;
    } catch (e) {
      return {
        fetchedAt: Date.now(),
        auth: auth.mode,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      clearTimeout(to);
    }
  }

  /**
   * If we hold a keychain OAuth token within `bufferSeconds` of its expiry
   * (or already past), invoke the Claude Code CLI to refresh it in-place
   * and re-read the new value. Idempotent / safe to call before every poll.
   */
  private async ensureFreshAuth(): Promise<void> {
    if (this.auth.mode !== 'oauth' || this.auth.tag !== 'keychain') return;
    const expiresAt = this.auth.expiresAt;
    if (!expiresAt) return; // unknown expiry — can't decide, let the probe judge
    const secondsLeft = (expiresAt - Date.now()) / 1000;
    if (secondsLeft > cfg.refresh.bufferSeconds) return;
    console.log(
      `[quota-poller] OAuth token expires in ${Math.round(secondsLeft)}s; refreshing via \`${cfg.refresh.command} ${cfg.refresh.args.join(' ')}\``,
    );
    const ok = await triggerCliRefresh();
    if (!ok) return; // stale auth — probe will 401, runtime fallback handles it
    const reread = readKeychainOauth();
    if (!reread) return;
    if (reread.expiresAt && expiresAt && reread.expiresAt <= expiresAt) {
      console.warn('[quota-poller] CLI exited cleanly but keychain expiry did not advance');
      return;
    }
    const newLeftH = reread.expiresAt
      ? ((reread.expiresAt - Date.now()) / 3_600_000).toFixed(1)
      : '?';
    console.log(`[quota-poller] keychain refreshed — new expiry in ${newLeftH}h`);
    this.auth = makeOauthAuth(reread, 'keychain');
  }

  private async doPoll(): Promise<void> {
    if (this.auth.mode === 'none') {
      this.last = { fetchedAt: Date.now(), auth: 'none', error: 'no credentials' };
      this.emit('usage', this.last);
      return;
    }

    await this.ensureFreshAuth();
    let snap = await this.probeOnce(this.auth);

    // Runtime safety net: if OAuth is still failing (refresh token also
    // expired, CLI missing, etc.), demote to API key once and reprobe so
    // the chip keeps the per-minute bars working. Carry the OAuth error
    // forward as a user-facing hint — "API key auth" alone would obscure
    // that the real problem is a stale OAuth session.
    if (snap.error && this.auth.mode === 'oauth') {
      const oauthErr = snap.error;
      const fallback = resolveApiKey(loadEnvFromDotEnv());
      if (fallback.mode === 'api_key') {
        console.warn(
          `[quota-poller] oauth probe failed (${oauthErr}); demoting to ${fallback.tag}`,
        );
        this.auth = fallback;
        snap = await this.probeOnce(this.auth);
        if (!snap.error) {
          snap.error = is401(oauthErr)
            ? 'Claude Code OAuth expired — run `claude auth login` to refresh'
            : `oauth refresh failed: ${oauthErr.slice(0, 80)}`;
        }
      }
    }

    this.last = snap;
    this.emit('usage', snap);
  }
}

function is401(msg: string): boolean {
  return /HTTP 401|authentication_error|Invalid authentication/i.test(msg);
}
