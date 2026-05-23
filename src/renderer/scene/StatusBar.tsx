import { useEffect, useMemo, useState } from 'react';
import type { SessionState, UsageSnapshot, UsageWindow } from '@shared/events';
import statusBarConfig from '../../../config/status-bar.config.json';

interface Props {
  sessions: SessionState[];
  usage: UsageSnapshot | null;
}

const TICK_MS = statusBarConfig.wallClockTickMs;
const MODEL_COLORS = statusBarConfig.modelColors;
const MODEL_INITIALS = statusBarConfig.modelInitials;

// Map a Claude model id (e.g. "claude-opus-4-7", "claude-haiku-4-5-20251001")
// to the family key used by config.modelColors / modelInitials. Unknown ids
// fall back to "unknown" so the chip still renders a neutral dot.
function modelFamily(model: string | undefined): keyof typeof MODEL_INITIALS {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'unknown';
}

function formatClock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const am = h < 12;
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${m.toString().padStart(2, '0')} ${am ? 'am' : 'pm'}`;
}

function formatWeekday(d: Date): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

function formatCountdown(resetsAtUnix: number, now: number): string {
  const secs = Math.max(0, resetsAtUnix - Math.floor(now / 1000));
  if (secs <= 0) return 'now';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}

function formatResetWeekday(resetsAtUnix: number): string {
  if (!resetsAtUnix) return '—';
  return formatWeekday(new Date(resetsAtUnix * 1000));
}

function isDaytime(d: Date): boolean {
  const h = d.getHours();
  return h >= 6 && h < 18;
}

function QuotaBar({
  label,
  window,
  resetFormatter,
  now,
}: {
  label: string;
  window: UsageWindow | undefined;
  resetFormatter: (resetsAt: number, now: number) => string;
  now: number;
}) {
  const known = window && Number.isFinite(window.utilization);
  const pct = known ? Math.min(1, Math.max(0, window!.utilization)) : 0;
  // Color shifts from green → amber → red as the window fills.
  const fillColor =
    pct < 0.5 ? '#7fc28f' : pct < 0.8 ? '#f0c060' : '#c85040';
  return (
    <div className="quota-bar" title={known ? `${Math.round(pct * 100)}% used · resets ${resetFormatter(window!.resetsAt, now)}` : 'no data'}>
      <span className="quota-bar-label">{label}</span>
      <div className="quota-bar-track">
        <div
          className="quota-bar-fill"
          style={{
            width: known ? `${Math.round(pct * 100)}%` : '0%',
            background: fillColor,
          }}
        />
        {!known && <div className="quota-bar-unknown">?</div>}
      </div>
      <span className="quota-bar-meta">
        {known ? resetFormatter(window!.resetsAt, now) : '—'}
      </span>
    </div>
  );
}

export function StatusBar({ sessions, usage }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const date = new Date(now);
  const day = isDaytime(date);

  const counts = useMemo(() => {
    let busy = 0, idle = 0, done = 0;
    for (const s of sessions) {
      if (s.status === 'busy') busy++;
      else if (s.status === 'idle') idle++;
      else if (s.status === 'done') done++;
    }
    return { busy, idle, done, total: sessions.length };
  }, [sessions]);

  // Sort dots so the same set of workers renders stably across re-renders.
  const modelDots = useMemo(() => {
    const order = ['opus', 'sonnet', 'haiku', 'unknown'] as const;
    return [...sessions]
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      .map((s) => modelFamily(s.model))
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }, [sessions]);

  const fiveHour = usage?.unified?.five_hour;
  const sevenDay = usage?.unified?.seven_day;
  const authMode = usage?.auth ?? 'none';
  const stale = usage && usage.fetchedAt > 0 && now - usage.fetchedAt > 10 * 60 * 1000;

  // Subtitle for the chip's auth state: empty when everything is OK with OAuth,
  // otherwise a short hint so the user knows why the bars look the way they do.
  // Order matters — `error` is checked before the generic api_key note so a
  // 401-after-demotion message (e.g. "Claude Code OAuth expired — run `claude
  // auth login`") wins over "API key auth — 5h/weekly bars require Pro/Max".
  let authNote: string | null = null;
  if (authMode === 'none') authNote = 'no auth — set ANTHROPIC_API_KEY or sign into Claude Code';
  else if (usage?.error) authNote = usage.error;
  else if (authMode === 'api_key' && !fiveHour) authNote = 'API key auth — 5h/weekly bars require Pro/Max OAuth';
  else if (stale) authNote = `stale (${Math.round((now - usage!.fetchedAt) / 60000)}m old)`;

  return (
    <div className={`status-bar${day ? ' status-bar-day' : ' status-bar-night'}`}>
      <div className="status-bar-row status-bar-top">
        <span className="status-bar-icon" aria-hidden>
          {day ? '☀' : '☾'}
        </span>
        <span className="status-bar-date">{formatWeekday(date)}</span>
        <span className="status-bar-sep">·</span>
        <span className="status-bar-clock">{formatClock(date)}</span>
      </div>
      <div className="status-bar-row status-bar-mid">
        <QuotaBar label="5h" window={fiveHour} resetFormatter={formatCountdown} now={now} />
        <QuotaBar label="wk" window={sevenDay} resetFormatter={(r) => formatResetWeekday(r)} now={now} />
      </div>
      <div className="status-bar-row status-bar-bot">
        <span className="worker-count" title={`${counts.busy} busy · ${counts.idle} idle · ${counts.done} done`}>
          <span className="worker-busy">⚒ {counts.busy}</span>
          <span className="worker-idle">💤 {counts.idle}</span>
        </span>
        <span className="model-mix" title="active worker models">
          {modelDots.length === 0 ? (
            <span className="model-dot model-dot-empty" aria-hidden>·</span>
          ) : (
            modelDots.map((fam, i) => (
              <span
                key={i}
                className="model-dot"
                style={{ background: MODEL_COLORS[fam] }}
                title={fam}
              >
                {MODEL_INITIALS[fam]}
              </span>
            ))
          )}
        </span>
      </div>
      {authNote && <div className="status-bar-note">{authNote}</div>}
    </div>
  );
}
