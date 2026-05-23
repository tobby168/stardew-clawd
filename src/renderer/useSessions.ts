import { useEffect, useMemo, useRef, useState } from 'react';
import { DaemonClient } from './daemon-client';
import type { ServerEvent, SessionState, TranscriptEntry, UsageSnapshot } from '@shared/events';

let _client: DaemonClient | null = null;
export function getClient(): DaemonClient {
  if (!_client) {
    _client = new DaemonClient();
    _client.connect().catch((e) => console.error('daemon connect failed', e));
  }
  return _client;
}

export function useSessions() {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    const client = getClient();
    const unsub = client.subscribe((e: ServerEvent) => {
      if (e.type === 'usage.updated') return; // handled by useUsage
      setSessions((prev) => applyEvent(prev, e));
    });
    return unsub;
  }, []);

  return useMemo(() => Array.from(sessions.values()), [sessions]);
}

export function useUsage(): UsageSnapshot | null {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  useEffect(() => {
    const client = getClient();
    const unsub = client.subscribe((e: ServerEvent) => {
      if (e.type === 'usage.updated') setUsage(e.usage);
      else if (e.type === 'snapshot' && e.usage) setUsage(e.usage);
    });
    return unsub;
  }, []);
  return usage;
}

function applyEvent(prev: Map<string, SessionState>, e: ServerEvent): Map<string, SessionState> {
  const next = new Map(prev);
  switch (e.type) {
    case 'snapshot':
      next.clear();
      for (const s of e.sessions) next.set(s.sessionId, s);
      return next;
    case 'session.upserted':
      next.set(e.session.sessionId, { ...next.get(e.session.sessionId), ...e.session });
      return next;
    case 'session.activity_changed': {
      const s = next.get(e.sessionId);
      if (s)
        next.set(e.sessionId, {
          ...s,
          activity: e.activity,
          lastTool: e.lastTool ?? s.lastTool,
          lastActivityAt: e.lastActivityAt,
        });
      return next;
    }
    case 'session.status_changed': {
      const s = next.get(e.sessionId);
      if (s) next.set(e.sessionId, { ...s, status: e.status });
      return next;
    }
    case 'session.transcript_appended': {
      const s = next.get(e.sessionId);
      if (s) {
        const transcript = [...s.transcript, e.entry as TranscriptEntry];
        if (transcript.length > 500) transcript.splice(0, transcript.length - 500);
        next.set(e.sessionId, { ...s, transcript });
      }
      return next;
    }
    case 'session.interaction_requested': {
      const s = next.get(e.sessionId);
      if (s) next.set(e.sessionId, { ...s, pendingInteraction: e.interaction });
      return next;
    }
    case 'session.interaction_resolved': {
      const s = next.get(e.sessionId);
      if (s) next.set(e.sessionId, { ...s, pendingInteraction: undefined });
      return next;
    }
    case 'session.removed':
      next.delete(e.sessionId);
      return next;
    default:
      return next;
  }
}
