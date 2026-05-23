import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  daemon: { host: string; httpPort: number; wsPort: number };
  tokenPath: string;
  claude: { binary: string; streamFormat: string; extraArgs: string[] };
  hooks: {
    preToolUseTimeoutSec: number;
    settingsFileLocal: string;
    settingsFileGlobal: string;
    defaultScope: 'local' | 'global';
    markerKey: string;
    events: string[];
    /** Per-event matcher overrides. Falls back to "*" when missing. */
    eventMatchers?: Record<string, string>;
  };
  ui: {
    activityDebounceMs: number;
    renderScale: number;
    animationFps: number;
    transcript: {
      foldToolGroups: boolean;
      tailExternal: boolean;
      tailPollMs: number;
      tailReadFromStart: boolean;
    };
  };
}

export interface StatusBarConfig {
  pollIntervalMs: number;
  wallClockTickMs: number;
  probe: {
    url: string;
    anthropicVersion: string;
    model: string;
    maxTokens: number;
    timeoutMs: number;
    userAgent: string;
  };
  auth: {
    keychainService: string;
    envOauthToken: string;
    envApiKey: string;
  };
  refresh: {
    command: string;
    args: string[];
    timeoutMs: number;
    bufferSeconds: number;
  };
  modelColors: Record<string, string>;
  modelInitials: Record<string, string>;
}

export interface InteractiveToolsConfig {
  intercept: string[];
  /**
   * If false (default), `external` sessions (Claude Code running in the
   * user's terminal) bypass the intercept entirely and let Claude's native
   * TUI handle AskUserQuestion / ExitPlanMode — the user is already at that
   * terminal, no point forcing them over to the Stardew panel. App-spawned
   * (`claude -p`) workers always intercept since they have no native UI.
   */
  interceptExternalSessions: boolean;
  uiTimeoutSec: number;
  questionPromptTemplate: string;
  planAcceptedTemplate: string;
  planRejectedTemplate: string;
}

export interface AssetsConfig {
  tilemap: { tileSize: number; roomCols: number; roomRows: number; background: string };
  characters: Array<{
    id: string;
    sheet: string;
    frameWidth: number;
    frameHeight: number;
    tints: number[];
  }>;
  emotes: {
    sheet: string;
    frameWidth: number;
    frameHeight: number;
    frames: Record<string, number>;
  };
}

/**
 * World config — multi-room layout. Each room has cols/rows and its own
 * desks (room-local tile coords) and decorations (room-local pixels).
 * The room's absolute tile origin is computed at expand time by stacking
 * rooms left-to-right, separated by `wallThickness` tiles.
 */
export interface WorldConfig {
  wallThickness: number;
  growth: { workersPerRoom: number };
  rooms: WorldRoom[];
}

export interface WorldRoom {
  id: string;
  theme: string;
  cols: number;
  rows: number;
  /** Optional spawn/leave door for this room, in room-local tile coords. */
  door?: { x: number; y: number };
  desks: Array<{ id: string; x: number; y: number; sitX: number; sitY: number }>;
  decorations: WorldDecoration[];
}

export interface WorldDecoration {
  type:
    | 'window'
    | 'picture'
    | 'sconce'
    | 'rug'
    | 'bookshelf'
    | 'coffee-machine'
    | 'plant';
  /** Pixel coord within the room (room-local). */
  x: number;
  y: number;
  variant?: string;
}

/** A room with its absolute tile origin and absolute-coord desks resolved. */
export interface ExpandedRoom extends WorldRoom {
  originTileX: number;
  originTileY: number;
  /** Absolute tile coords (originTileX + room-local). */
  absoluteDesks: Array<{
    id: string;
    roomId: string;
    x: number;
    y: number;
    sitX: number;
    sitY: number;
  }>;
  /** Door in absolute tile coords, if defined. */
  absoluteDoor?: { x: number; y: number };
}

export interface CameraConfig {
  minZoom: number;
  maxZoom: number;
  defaultZoom: number;
  /** Upper bound on auto-fit zoom — independent of the slider's maxZoom so
   * the camera can scale up enough to fully cover the viewport even when
   * that requires exceeding the user-facing slider cap. */
  autoFitMaxZoom: number;
  sliderStep: number;
  sliderButtonStep: number;
  dragSensitivity: number;
  centroidLerpSpeed: number;
  edgePaddingTiles: number;
  firstSpawnHardCut: boolean;
  clickDragThresholdPx: number;
  recenterOnPopulationChange: boolean;
  recenterMinIntervalMs: number;
}

export interface AnimationsConfig {
  fps: number;
  states: Record<string, { row: number; frames: number; loop: boolean }>;
  toolToActivity: Record<string, string>;
  workerStateToAnim: Record<string, string>;
  fallbackStates: { thinking: string; unknown_tool: string };
}

export interface WorkerFsmConfig {
  tickMs: number;
  burstWindowMs: number;
  walkCommitMs: number;
  coffeeBreakIdleMs: number;
  walkSpeedTilesPerSec: number;
  minDwellMs: Record<string, number>;
  /**
   * Fallback waypoints when the world's first room has no door/coffee/etc.
   * The renderer derives real waypoints from world.config (per-decoration);
   * these defaults only apply when nothing better is available.
   */
  defaultWaypoints: Record<string, { x: number; y: number }>;
  intentToDeskState: Record<string, string>;
  intentPriority: Record<string, number>;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// Project root resolution works for both dev (electron-vite) and packaged builds.
// We rely on env var APP_CONFIG_DIR for non-Node contexts (hook script).
function findConfigDir(): string {
  if (process.env.STARDEW_OFFICE_CONFIG_DIR) {
    return process.env.STARDEW_OFFICE_CONFIG_DIR;
  }
  // Walk up from cwd to find a `config/app.config.json`.
  let cur = process.cwd();
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(cur, 'config', 'app.config.json'));
      return join(cur, 'config');
    } catch {
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  // Fallback: relative to this module.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', 'config');
  } catch {
    return resolve('config');
  }
}

let _configDir: string | null = null;
function configDir(): string {
  if (!_configDir) _configDir = findConfigDir();
  return _configDir;
}

function loadJson<T>(filename: string): T {
  return JSON.parse(readFileSync(join(configDir(), filename), 'utf-8')) as T;
}

export function loadAppConfig(): AppConfig {
  const raw = loadJson<AppConfig>('app.config.json');
  return {
    ...raw,
    tokenPath: expandHome(raw.tokenPath),
    hooks: {
      ...raw.hooks,
      settingsFileGlobal: expandHome(raw.hooks.settingsFileGlobal),
    },
  };
}

export function loadInteractiveToolsConfig(): InteractiveToolsConfig {
  return loadJson<InteractiveToolsConfig>('interactive-tools.json');
}

export function loadAssetsConfig(): AssetsConfig {
  return loadJson<AssetsConfig>('assets.config.json');
}

export function loadAnimationsConfig(): AnimationsConfig {
  return loadJson<AnimationsConfig>('animations.config.json');
}

export function loadWorkerFsmConfig(): WorkerFsmConfig {
  return loadJson<WorkerFsmConfig>('worker-fsm.config.json');
}

export function loadWorldConfig(): WorldConfig {
  return loadJson<WorldConfig>('world.config.json');
}

export function loadCameraConfig(): CameraConfig {
  return loadJson<CameraConfig>('camera.config.json');
}

/**
 * Expand a WorldConfig into rooms with absolute tile origins + absolute-coord
 * desks. Rooms are placed left-to-right with `wallThickness` tiles between
 * them. Pure function — same input always yields same output.
 */
export function expandWorld(world: WorldConfig): ExpandedRoom[] {
  const out: ExpandedRoom[] = [];
  let cursor = 0;
  for (const r of world.rooms) {
    const originTileX = cursor;
    const absoluteDesks = r.desks.map((d) => ({
      id: d.id,
      roomId: r.id,
      x: originTileX + d.x,
      y: d.y,
      sitX: originTileX + d.sitX,
      sitY: d.sitY,
    }));
    const absoluteDoor = r.door
      ? { x: originTileX + r.door.x, y: r.door.y }
      : undefined;
    out.push({
      ...r,
      originTileX,
      originTileY: 0,
      absoluteDesks,
      absoluteDoor,
    });
    cursor += r.cols + world.wallThickness;
  }
  return out;
}

/**
 * Flatten an expanded world into a desk slot list — same shape the daemon
 * used to read from assets.deskSlots, but now sourced from world.config.
 */
export function expandedDeskSlots(
  rooms: ExpandedRoom[],
): Array<{ id: string; x: number; y: number; sitX: number; sitY: number }> {
  return rooms.flatMap((r) =>
    r.absoluteDesks.map((d) => ({
      id: d.id,
      x: d.x,
      y: d.y,
      sitX: d.sitX,
      sitY: d.sitY,
    })),
  );
}

export function loadStatusBarConfig(): StatusBarConfig {
  return loadJson<StatusBarConfig>('status-bar.config.json');
}

export function configRoot(): string {
  return configDir();
}
