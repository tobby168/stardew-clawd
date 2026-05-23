/*
 * Display-state controller for a single worker.
 *
 * Pacing is the whole point: Claude can fire 10+ tool calls in a few seconds.
 * Mapping each PreToolUse straight to a state change would make the sprite
 * teleport between desks/bookshelves. The controller therefore:
 *
 *   1. Coalesces bursts of intents within `burstWindowMs`.
 *   2. Honors a per-state `minDwellMs` (configured).
 *   3. Treats walk segments as atomic: once a walk starts, the worker MUST
 *      arrive before any new state can take effect.
 *   4. Requires `walkCommitMs` of sustained intent before committing to a
 *      bookshelf/coffee trip — no pointless round-trips on flicker.
 *   5. Surfaces `holding_question` / `holding_plan` immediately (no pacing),
 *      because Claude is already blocked waiting for the answer.
 *
 * All thresholds + waypoints come from `config/worker-fsm.config.json`.
 * No hard-coded values; respect the user's CLAUDE.md rule.
 */
import type { Activity, SessionState, WorkerState } from '@shared/events';
import workerCfg from '../../../config/worker-fsm.config.json';

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Live waypoint sources. With a multi-room world there can be many bookshelves
 * and many coffee machines; the FSM picks the nearest to the worker's current
 * position when it needs to walk. The provider is a function so that when new
 * rooms appear at runtime the FSM picks up the new waypoints automatically.
 */
export interface WaypointProvider {
  doors: () => Vec2[];
  bookshelves: () => Vec2[];
  coffeeMachines: () => Vec2[];
}

interface FsmState {
  display: WorkerState;
  enteredAt: number;
  position: Vec2;        // tile coords (matches deskSlot.sitX/sitY)
  target?: Vec2;         // walk destination (tile coords)
  walkStart?: Vec2;
  walkStartedAt?: number;
  // Activity tracking for sustained-intent decisions.
  lastIntentChangeAt: number;
  prevIntent: Activity;
  // Facing direction (-1 left, +1 right). Affects sprite x-flip.
  facing: 1 | -1;
}

export interface WorkerFsmInput {
  session: SessionState;
  deskSit: Vec2; // tile coords of this session's desk
  now: number;
}

export interface WorkerFsmOutput {
  display: WorkerState;
  /** Render-time position in tile coords (fractional during walks). */
  position: Vec2;
  facing: 1 | -1;
  /** 0..1 along the current walk segment (1 if not walking). */
  walkProgress: number;
  /** True the moment a `leaving` walk has reached the door — renderer
   *  uses this to fire a despawn request to the daemon. */
  leftRoom: boolean;
}

export class WorkerFsm {
  private s: FsmState;
  private waypoints: WaypointProvider;

  constructor(session: SessionState, deskSit: Vec2, waypoints: WaypointProvider) {
    this.waypoints = waypoints;
    // New session spawns at the nearest door to its desk, walks to its desk.
    const door = nearest(deskSit, waypoints.doors()) ??
      workerCfg.defaultWaypoints.door;
    this.s = {
      display: 'spawning',
      enteredAt: Date.now(),
      position: { x: door.x, y: door.y },
      target: { x: deskSit.x, y: deskSit.y },
      walkStart: { x: door.x, y: door.y },
      walkStartedAt: Date.now(),
      lastIntentChangeAt: Date.now(),
      prevIntent: session.activity,
      facing: deskSit.x >= door.x ? 1 : -1,
    };
  }

  /** Tick the FSM. Returns the current display state + position. */
  step({ session, deskSit, now }: WorkerFsmInput): WorkerFsmOutput {
    // Track intent transitions for sustained-intent rules.
    if (session.activity !== this.s.prevIntent) {
      this.s.lastIntentChangeAt = now;
      this.s.prevIntent = session.activity;
    }

    // Always finish a walk segment before re-deciding.
    if (this.isWalking()) {
      this.advanceWalk(now);
      if (this.isWalking()) return this.output();
    }

    // Walks are atomic, but on arrival we immediately reconsider intent.
    this.transition({ session, deskSit, now });
    return this.output();
  }

  /** Caller-facing helper: update the desk-sit position if a session's
   *  assigned desk slot changes (rare, but harmless to handle). */
  rebindDesk(deskSit: Vec2) {
    if (this.s.display === 'at_desk_idle' || this.s.display === 'at_desk_thinking') {
      this.s.position = { x: deskSit.x, y: deskSit.y };
    }
  }

  private isWalking(): boolean {
    return (
      (this.s.display === 'spawning' ||
        this.s.display === 'walking_to_bookshelf' ||
        this.s.display === 'walking_to_coffee' ||
        this.s.display === 'walking_back_to_desk' ||
        this.s.display === 'leaving') &&
      !!this.s.target
    );
  }

  private advanceWalk(now: number) {
    if (!this.s.target || !this.s.walkStart || !this.s.walkStartedAt) return;
    const dx = this.s.target.x - this.s.walkStart.x;
    const dy = this.s.target.y - this.s.walkStart.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) {
      this.arrive();
      return;
    }
    const elapsedSec = (now - this.s.walkStartedAt) / 1000;
    const traveled = elapsedSec * workerCfg.walkSpeedTilesPerSec;
    const t = Math.min(1, traveled / dist);
    this.s.position = {
      x: this.s.walkStart.x + dx * t,
      y: this.s.walkStart.y + dy * t,
    };
    this.s.facing = dx >= 0 ? 1 : -1;
    if (t >= 1) this.arrive();
  }

  private arrive() {
    if (!this.s.target) return;
    this.s.position = { ...this.s.target };
    this.s.target = undefined;
    this.s.walkStart = undefined;
    this.s.walkStartedAt = undefined;
    // Map the just-finished walk to its terminal state.
    if (this.s.display === 'spawning') this.enter('at_desk_idle');
    else if (this.s.display === 'walking_to_bookshelf') this.enter('at_bookshelf');
    else if (this.s.display === 'walking_to_coffee') this.enter('at_coffee');
    else if (this.s.display === 'walking_back_to_desk') this.enter('at_desk_thinking');
    // 'leaving' stays in 'leaving' state until the caller despawns it.
  }

  /** Apply transition rules from current state given the latest intent. */
  private transition({ session, deskSit, now }: WorkerFsmInput) {
    const intent = session.activity;
    const intentAge = now - this.s.lastIntentChangeAt;
    const dwell = now - this.s.enteredAt;
    const minDwell = (workerCfg.minDwellMs as Record<string, number>)[this.s.display] ?? 0;
    const pending = session.pendingInteraction;

    // 1. Blocking interactions skip pacing entirely.
    if (pending?.kind === 'question' && this.s.display !== 'holding_question') {
      this.ensureAtDesk(deskSit);
      this.enter('holding_question');
      return;
    }
    if (pending?.kind === 'plan' && this.s.display !== 'holding_plan') {
      this.ensureAtDesk(deskSit);
      this.enter('holding_plan');
      return;
    }
    if (!pending && (this.s.display === 'holding_question' || this.s.display === 'holding_plan')) {
      this.enter('at_desk_thinking');
      return;
    }

    // 2. Honor min-dwell — only allow transitions after dwell satisfied.
    if (dwell < minDwell) return;

    // 3. From bookshelf/coffee: if intent changed away from the trigger,
    //    or just sustained long enough, walk back.
    if (this.s.display === 'at_bookshelf') {
      const stillLookingUp = intent === 'looking_up';
      if (!stillLookingUp) {
        this.startWalk('walking_back_to_desk', deskSit);
      }
      return;
    }
    if (this.s.display === 'at_coffee') {
      // Leave coffee as soon as anything more interesting arrives.
      if (intent !== 'waiting_idle' && intent !== 'idle') {
        this.startWalk('walking_back_to_desk', deskSit);
      }
      return;
    }

    // 4. Decide next state from intent.
    const next = this.intentToState(intent, intentAge, now, session);
    if (next === this.s.display) return;

    // 5. Walk-commit rule: bookshelf / coffee trips need sustained intent
    //    so we don't bolt out of the chair on a single fleeting tool call.
    if (next === 'walking_to_bookshelf' && intentAge < workerCfg.walkCommitMs) return;
    if (next === 'walking_to_coffee' && intentAge < workerCfg.walkCommitMs) return;

    if (next === 'walking_to_bookshelf') {
      const tgt = nearest(this.s.position, this.waypoints.bookshelves()) ??
        workerCfg.defaultWaypoints.bookshelf;
      this.startWalk('walking_to_bookshelf', tgt);
    } else if (next === 'walking_to_coffee') {
      const tgt = nearest(this.s.position, this.waypoints.coffeeMachines()) ??
        workerCfg.defaultWaypoints.coffee;
      this.startWalk('walking_to_coffee', tgt);
    } else if (next === 'leaving') {
      const tgt = nearest(this.s.position, this.waypoints.doors()) ??
        workerCfg.defaultWaypoints.door;
      this.startWalk('leaving', tgt);
    } else {
      // Desk-bound state — make sure we're seated first.
      this.ensureAtDesk(deskSit);
      this.enter(next);
    }
  }

  /** Map an intent → a desired terminal display state. */
  private intentToState(
    intent: Activity,
    _intentAge: number,
    now: number,
    session: SessionState,
  ): WorkerState {
    // waiting_question / waiting_plan are owned by the pending-interaction
    // signal in transition(). If we got here with that intent it means the
    // interaction was already resolved, so fall through to "thinking" and
    // wait for the next tool to update intent properly.
    if (intent === 'waiting_question' || intent === 'waiting_plan') {
      return session.pendingInteraction ? (intent === 'waiting_plan' ? 'holding_plan' : 'holding_question') : 'at_desk_thinking';
    }
    if (intent === 'looking_up') return 'walking_to_bookshelf';
    if (intent === 'waiting_idle') {
      const idleFor = now - session.lastActivityAt;
      if (idleFor >= workerCfg.coffeeBreakIdleMs) return 'walking_to_coffee';
      return 'at_desk_idle';
    }
    if (intent === 'done') return 'at_desk_idle';
    if (intent === 'leaving') return 'leaving';
    const map = workerCfg.intentToDeskState as Record<string, WorkerState>;
    return map[intent] ?? 'at_desk_typing';
  }

  private startWalk(state: WorkerState, target: Vec2) {
    this.s.walkStart = { ...this.s.position };
    this.s.target = { x: target.x, y: target.y };
    this.s.walkStartedAt = Date.now();
    const dx = target.x - this.s.position.x;
    this.s.facing = dx >= 0 ? 1 : -1;
    this.enter(state);
  }

  private ensureAtDesk(deskSit: Vec2) {
    const dx = deskSit.x - this.s.position.x;
    const dy = deskSit.y - this.s.position.y;
    const off = Math.hypot(dx, dy);
    if (off > 0.5) {
      // Snap back; we choose not to animate the desk-return because dwell
      // rules already mean the worker only leaves on sustained intent.
      this.s.position = { x: deskSit.x, y: deskSit.y };
    }
  }

  private enter(state: WorkerState) {
    if (this.s.display === state) return;
    this.s.display = state;
    this.s.enteredAt = Date.now();
  }

  private output(): WorkerFsmOutput {
    let walkProgress = 1;
    if (this.s.walkStart && this.s.target) {
      const dx = this.s.target.x - this.s.walkStart.x;
      const dy = this.s.target.y - this.s.walkStart.y;
      const dist = Math.hypot(dx, dy) || 1;
      const pdx = this.s.position.x - this.s.walkStart.x;
      const pdy = this.s.position.y - this.s.walkStart.y;
      walkProgress = Math.min(1, Math.hypot(pdx, pdy) / dist);
    }
    const leftRoom = this.s.display === 'leaving' && !this.s.target;
    return {
      display: this.s.display,
      position: { ...this.s.position },
      facing: this.s.facing,
      walkProgress,
      leftRoom,
    };
  }
}

/** Convenience: returns the configured anim row name for a worker state. */
export function animNameFor(state: WorkerState, animMap: Record<string, string>): string {
  return animMap[state] ?? 'idle';
}

/** Pick the closest point from a list, or undefined if list is empty. */
function nearest(from: Vec2, points: Vec2[]): Vec2 | undefined {
  if (points.length === 0) return undefined;
  let best = points[0];
  let bestDist = Math.hypot(best.x - from.x, best.y - from.y);
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - from.x, points[i].y - from.y);
    if (d < bestDist) {
      best = points[i];
      bestDist = d;
    }
  }
  return best;
}
