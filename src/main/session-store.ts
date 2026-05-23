import { EventEmitter } from 'node:events';
import {
  loadAssetsConfig,
  loadAnimationsConfig,
  loadWorldConfig,
  expandWorld,
  expandedDeskSlots,
} from '@shared/config';
import type {
  Activity,
  PendingInteraction,
  SessionState,
  TranscriptEntry,
  ServerEvent,
} from '@shared/events';

const assets = loadAssetsConfig();
const animations = loadAnimationsConfig();
const worldDesks = expandedDeskSlots(expandWorld(loadWorldConfig()));

// Map a tool name → intent activity; falls back to a configured default.
export function activityForTool(toolName: string): Activity {
  const mapped = animations.toolToActivity[toolName];
  return (mapped ?? animations.fallbackStates.unknown_tool) as Activity;
}

// Pick a desk + character variant + tint for a freshly-discovered session.
// Stable: same sessionId always lands at the same desk (deterministic hash).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickSeat(sessionId: string, taken: Set<string>) {
  // Fill desks IN ORDER (first available). With the multi-room world config,
  // desks are listed room-by-room, so sequential picking makes rooms fill
  // sequentially — the renderer reveals new rooms in lockstep with growth.
  const slots = worldDesks;
  for (const slot of slots) {
    if (!taken.has(slot.id)) return slot;
  }
  // All desks taken — stack on top of a hash-picked slot for stability.
  return slots[hashStr(sessionId) % slots.length];
}

function pickTint(sessionId: string): number {
  const tints = assets.characters[0]?.tints ?? [0xffffff];
  return tints[hashStr(sessionId) % tints.length];
}

export class SessionStore extends EventEmitter {
  private sessions = new Map<string, SessionState>();

  emit<E extends ServerEvent>(_event: 'event', payload: E): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: 'event', listener: (e: ServerEvent) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  snapshot(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  ensure(
    sessionId: string,
    init: { cwd?: string; origin?: SessionState['origin'] } = {},
  ): SessionState {
    let s = this.sessions.get(sessionId);
    if (s) {
      if (init.cwd && !s.cwd) s.cwd = init.cwd;
      if (init.origin === 'app-spawned' && s.origin !== 'app-spawned') {
        s.origin = 'app-spawned';
        this.emit('event', { type: 'session.upserted', session: s });
      }
      return s;
    }
    const takenDesks = new Set(
      Array.from(this.sessions.values())
        .map((x) => x.deskId)
        .filter((d): d is string => !!d),
    );
    const desk = pickSeat(sessionId, takenDesks);
    s = {
      sessionId,
      origin: init.origin ?? 'external',
      cwd: init.cwd ?? '',
      status: 'busy',
      activity: 'idle',
      lastActivityAt: Date.now(),
      transcript: [],
      deskId: desk.id,
      characterId: assets.characters[0]?.id ?? 'worker-base',
      tint: pickTint(sessionId),
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, s);
    this.emit('event', { type: 'session.upserted', session: s });
    return s;
  }

  setStatus(sessionId: string, status: SessionState['status']) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.status === status) return;
    s.status = status;
    this.emit('event', { type: 'session.status_changed', sessionId, status });
  }

  setActivity(sessionId: string, activity: Activity, lastTool?: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const ts = Date.now();
    if (s.activity === activity && s.lastTool === lastTool) {
      // Still bump lastActivityAt — keeps the coffee-break idle timer accurate
      // even when bursts collapse to a single intent on the renderer side.
      s.lastActivityAt = ts;
      return;
    }
    s.activity = activity;
    s.lastActivityAt = ts;
    if (lastTool) s.lastTool = lastTool;
    this.emit('event', {
      type: 'session.activity_changed',
      sessionId,
      activity,
      lastTool: s.lastTool,
      lastActivityAt: ts,
    });
  }

  appendTranscript(sessionId: string, entry: TranscriptEntry) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.transcript.push(entry);
    if (s.transcript.length > 500) s.transcript.splice(0, s.transcript.length - 500);
    this.emit('event', { type: 'session.transcript_appended', sessionId, entry });
  }

  setPendingInteraction(sessionId: string, interaction: PendingInteraction) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.pendingInteraction = interaction;
    this.emit('event', { type: 'session.interaction_requested', sessionId, interaction });
  }

  clearPendingInteraction(sessionId: string, toolUseId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.pendingInteraction?.toolUseId === toolUseId) {
      s.pendingInteraction = undefined;
    }
    this.emit('event', { type: 'session.interaction_resolved', sessionId, toolUseId });
  }

  setModel(sessionId: string, model: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.model === model) return;
    s.model = model;
    this.emit('event', { type: 'session.upserted', session: s });
  }

  markSubagent(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.isSubagent) return;
    s.isSubagent = true;
    this.emit('event', { type: 'session.upserted', session: s });
  }

  remove(sessionId: string) {
    if (this.sessions.delete(sessionId)) {
      this.emit('event', { type: 'session.removed', sessionId });
    }
  }
}
