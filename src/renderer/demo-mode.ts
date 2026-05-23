/*
 * Browser-preview demo mode. When the renderer runs outside Electron (e.g.
 * `npm run preview` via vite directly), there's no daemon to provide live
 * sessions. This module injects synthetic workers + activity cycling so the
 * UI is visibly working: room growth, worker walks, day/night sky, etc.
 *
 * It's opt-in (only activates when window.stardew is absent) and exposes a
 * tiny `window.__office` API so a developer can poke at it from devtools:
 *
 *   __office.spawn(5)              // add 5 workers
 *   __office.despawn(2)            // remove 2 workers
 *   __office.set(12, 'looking_up') // force activity for worker 12
 *   __office.clear()               // remove all
 *
 * Designed to be fully removable: nothing in production depends on it.
 */
import type {
  Activity,
  PendingQuestion,
  ServerEvent,
  SessionState,
} from '@shared/events';
import worldConfig from '../../config/world.config.json';

const ACTIVITIES: Activity[] = [
  'typing', 'writing', 'reading', 'bash', 'thinking',
  'looking_up', 'waiting_idle', 'idle',
];

const TINTS = [0xffffff, 0xffcc8c, 0xcccccc, 0xffd8b3, 0xa8d8ff, 0xe0c0ff];

function totalDesks(): number {
  return worldConfig.rooms.reduce((n, r) => n + r.desks.length, 0);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface DemoController {
  /** Subscribe to synthetic ServerEvents (same contract as DaemonClient). */
  subscribe(l: (e: ServerEvent) => void): () => void;
  /** Despawn a session — called by Office.tsx when a worker walks out. */
  despawn(sessionId: string): void;
  /** Clear a session's pending interaction. Used by demo answerQuestion. */
  resolvePending?(sessionId: string): void;
}

export function startDemo(): DemoController {
  const listeners = new Set<(e: ServerEvent) => void>();
  const sessions = new Map<string, SessionState>();
  const deskTaken = new Set<string>();
  const max = totalDesks();
  let nextId = 1;
  let nextEntryId = 1;

  function emit(e: ServerEvent) {
    for (const l of listeners) l(e);
  }

  function spawnOne(): boolean {
    if (sessions.size >= max) return false;
    // Find the first unoccupied desk in declared order. Same as the daemon's
    // pickSeat — sequential so rooms fill in order.
    let chosenDesk: string | null = null;
    outer: for (const room of worldConfig.rooms) {
      for (const desk of room.desks) {
        if (!deskTaken.has(desk.id)) {
          chosenDesk = desk.id;
          break outer;
        }
      }
    }
    if (!chosenDesk) return false;
    const sessionId = `demo-${nextId++}`;
    const folder = pickRandom([
      'office', 'stardew-clawd', 'apps', 'web', 'claude-skills',
      'agentic-cli', 'orchestrator', 'pipeline', 'experiments',
    ]);
    const state: SessionState = {
      sessionId,
      origin: 'app-spawned',
      cwd: `/Users/demo/${folder}`,
      status: 'busy',
      activity: pickRandom(ACTIVITIES),
      lastActivityAt: Date.now(),
      transcript: [],
      deskId: chosenDesk,
      characterId: 'worker-base',
      tint: pickRandom(TINTS),
      isSubagent: Math.random() < 0.15,
      createdAt: Date.now(),
    };
    sessions.set(sessionId, state);
    deskTaken.add(chosenDesk);
    emit({ type: 'session.upserted', session: state });
    return true;
  }

  function despawnOne(sessionId?: string): boolean {
    let target = sessionId;
    if (!target) {
      // Pick a random session to remove.
      const ids = Array.from(sessions.keys());
      if (ids.length === 0) return false;
      target = ids[Math.floor(Math.random() * ids.length)];
    }
    const s = sessions.get(target);
    if (!s) return false;
    if (s.deskId) deskTaken.delete(s.deskId);
    sessions.delete(target);
    emit({ type: 'session.removed', sessionId: target });
    return true;
  }

  // Inject a synthetic AskUserQuestion with `n` questions on `sessionId` (or
   // the first session). Lets developers / E2E tests exercise the side-panel
   // QuestionForm layout (scroll, sticky ANSWER) without a live daemon.
   function askQuestion(sessionId: string | undefined, n: number): string | null {
    const id = sessionId ?? Array.from(sessions.keys())[0];
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    const count = Math.max(1, Math.floor(n));
    const interaction: PendingQuestion = {
      kind: 'question',
      toolUseId: `demo-tu-${Date.now()}`,
      requestedAt: Date.now(),
      questions: Array.from({ length: count }, (_, i) => ({
        question: `Demo question ${i + 1} — pick one to continue.`,
        header: `Q${i + 1}`,
        multiSelect: i % 3 === 2,
        options: [
          { label: 'Option A', description: 'first choice' },
          { label: 'Option B', description: 'second choice' },
          { label: 'Option C', description: 'third choice' },
        ],
      })),
    };
    s.pendingInteraction = interaction;
    emit({ type: 'session.interaction_requested', sessionId: id, interaction });
    return id;
  }

  function clearAsk(sessionId?: string) {
    const ids = sessionId ? [sessionId] : Array.from(sessions.keys());
    for (const id of ids) {
      const s = sessions.get(id);
      if (!s?.pendingInteraction) continue;
      const toolUseId = s.pendingInteraction.toolUseId;
      s.pendingInteraction = undefined;
      emit({ type: 'session.interaction_resolved', sessionId: id, toolUseId });
    }
  }

  function setActivity(sessionId: string, activity: Activity) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.activity = activity;
    s.lastActivityAt = Date.now();
    emit({
      type: 'session.activity_changed',
      sessionId,
      activity,
      lastActivityAt: s.lastActivityAt,
    });
  }

  // Initial snapshot is empty (renderer expects this on first subscribe).
  // We start spawning AFTER the first subscriber arrives so the UI shows
  // "office is empty" briefly, then workers begin to appear.
  let started = false;
  function maybeStart() {
    if (started) return;
    started = true;
    // Spawn the first worker quickly; subsequent ones at a friendly cadence
    // so room growth is visible.
    spawnOne();
    setInterval(() => {
      if (sessions.size < max) spawnOne();
    }, 2200);
    // Cycle each worker's activity so they walk to bookshelf/coffee/back.
    setInterval(() => {
      const ids = Array.from(sessions.keys());
      if (ids.length === 0) return;
      const id = ids[Math.floor(Math.random() * ids.length)];
      setActivity(id, pickRandom(ACTIVITIES));
    }, 1500);
  }

  // Devtools-friendly handle.
  if (typeof window !== 'undefined') {
    (window as unknown as { __office: unknown }).__office = {
      spawn(n = 1) {
        let added = 0;
        for (let i = 0; i < n; i++) if (spawnOne()) added++;
        return added;
      },
      despawn(n = 1) {
        let removed = 0;
        for (let i = 0; i < n; i++) if (despawnOne()) removed++;
        return removed;
      },
      set(id: number | string, activity: Activity) {
        const sid = typeof id === 'number' ? `demo-${id}` : id;
        setActivity(sid, activity);
      },
      clear() {
        const ids = Array.from(sessions.keys());
        for (const id of ids) despawnOne(id);
      },
      list() {
        return Array.from(sessions.values()).map((s) => ({
          id: s.sessionId, desk: s.deskId, activity: s.activity,
        }));
      },
      ask(n: number = 5, sessionId?: string) {
        return askQuestion(sessionId, n);
      },
      clearAsk(sessionId?: string) {
        clearAsk(sessionId);
      },
      // Inject a synthetic transcript entry for testing the fold UI offline.
      // kind: one of 'user' | 'assistant_text' | 'tool_use' | 'tool_result' | 'system'
      append(sessionId: string | number, kind: string, text: string) {
        const sid = typeof sessionId === 'number' ? `demo-${sessionId}` : sessionId;
        const s = sessions.get(sid);
        if (!s) return false;
        const entry = {
          id: `demo-entry-${nextEntryId++}`,
          ts: Date.now(),
          kind: kind as 'user' | 'assistant_text' | 'tool_use' | 'tool_result' | 'system',
          text,
        };
        // The reducer will append on receipt — don't mutate the underlying
        // array too or it shows up twice (demo `sessions` and React store
        // share transcript references via the initial snapshot).
        emit({ type: 'session.transcript_appended', sessionId: sid, entry });
        return true;
      },
    };
    console.info(
      '[demo] offline mode — workers will appear automatically. Try ' +
      '__office.spawn(5), __office.despawn(2), __office.set(1, "looking_up"), __office.clear(), ' +
      '__office.ask(8) (inject N-question AskUserQuestion), __office.clearAsk().',
    );
  }

  return {
    subscribe(l) {
      listeners.add(l);
      // First subscribe → start the cycle.
      maybeStart();
      // Replay current snapshot so the new subscriber catches up.
      l({ type: 'snapshot', sessions: Array.from(sessions.values()) });
      return () => listeners.delete(l);
    },
    despawn(sessionId) {
      despawnOne(sessionId);
    },
    resolvePending(sessionId) {
      clearAsk(sessionId);
    },
  };
}
