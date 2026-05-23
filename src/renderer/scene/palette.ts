/*
 * Palette interface for scene-specific color theming. Every drawing primitive
 * in sprite-factory.ts now takes a Palette argument; no more module-level
 * `PALETTE` const. Each scene config in `config/scenes/*.config.json`
 * provides a full Palette object.
 *
 * Keep this in sync with `Palette` consumers in sprite-factory.ts — if a key
 * is added here, every scene config MUST provide a value or the validator at
 * the bottom will throw at scene-load time.
 */

export interface Palette {
  // floor — repeating planks/tiles/concrete
  floorPlank1: string;
  floorPlank2: string;
  floorPlankSeam: string;
  floorPlankKnot: string;
  floorScuff: string;
  floorShadow: string;

  // walls
  wallTop: string;
  wallTopShade: string;
  wallTopHighlight: string;
  wallTrim: string;
  wallLower: string;
  wallLowerShade: string;
  baseboard: string;

  // rug / mat
  rugBase: string;
  rugStripe: string;
  rugBorder: string;
  rugDiamond: string;

  // desk / workstation
  desk: string;
  deskTop: string;
  deskTopHi: string;
  deskShade: string;

  // monitor
  monitorFrame: string;
  monitorFrameHi: string;
  monitorScreen: string;
  monitorScreenLit: string;
  monitorScreenText: string;
  monitorScreenDim: string;
  keyboard: string;
  keyboardKey: string;
  mug: string;
  mugShade: string;
  paper: string;
  paperShade: string;

  // plants
  plantPot: string;
  plantPotShade: string;
  plantPotHi: string;
  plantLeaf: string;
  plantLeafDark: string;
  plantLeafHi: string;
  plantFruit: string;

  // shelving / storage (bookshelf in cozy-office; lockers/cabinets in other scenes)
  bookshelfBody: string;
  bookshelfShade: string;
  book1: string;
  book2: string;
  book3: string;
  book4: string;
  book5: string;

  // beverage / break-area appliance (coffee machine, water cooler, beaker rack, etc.)
  coffeeBody: string;
  coffeeBodyHi: string;
  coffeeRed: string;
  coffeeSpout: string;
  coffeeBeans: string;

  // window — day
  windowFrame: string;
  windowFrameShade: string;
  sky: string;
  skyHi: string;
  cloud: string;
  curtain: string;
  curtainShade: string;
  // window — night
  skyNight: string;
  skyNightHi: string;
  moon: string;
  moonShade: string;
  moonHi: string;
  star: string;

  // character base (driven via tint per-session for shirts)
  skin: string;
  skinShade: string;
  skinHi: string;
  hair: string;
  hairShade: string;
  shirt: string;
  shirtShade: string;
  shirtHi: string;
  pants: string;
  pantsShade: string;
  shoe: string;
  shadow: string;

  // outlines (soft-blended)
  outline: string;
  outlineSoft: string;

  // emote bubbles
  emoteYellow: string;
  emoteOutline: string;
  speechBg: string;
  speechShade: string;
  speechBorder: string;

  // scene-specific accent (used by scene-specific decorations: chalk green,
  // beaker glass, safety orange, etc.). Always present; scenes that don't
  // need it can mirror an existing tone.
  accent: string;
  accentShade: string;
  accentHi: string;
}

/**
 * Per-scene "outfit" the worker wears on top of the base body. Keeps the
 * 16x24 silhouette identical so the FSM/positioning code is untouched, but
 * draws scene-specific hat/headwear and prop overrides for select animation
 * rows so a construction-site worker looks like a worker, a lab tech wears
 * a coat + goggles, etc.
 */
export interface SceneOutfit {
  /** Outfit kind — drives which override drawer in sprite-factory runs.    */
  kind: 'cozy' | 'modern' | 'school' | 'lab' | 'construction';
  /** Optional shirt tint baseline (a hex, used as the base "shirt" color
   *  before the per-session tint multiplies). Defaults to palette.shirt. */
  shirtBase?: string;
  /** Prop the worker holds during the 'at_coffee' animation rows
   *  ("coffee mug", "lab beaker", "water cup", etc.). Drives a small
   *  override in sprite-factory's sip_low / sip_high variant drawer. */
  mugProp?: 'mug' | 'beaker' | 'juice-box' | 'water-cup' | 'thermos';
}

/**
 * Per-scene vocabulary mapping. Each canonical `WorkerState` gets a
 * display label (used in panel/tooltip text). The canonical
 * `animations.config.json#workerStateToAnim` mapping is shared across
 * scenes, so row indices are derived from there — only the human-readable
 * label changes per scene.
 *
 * Plus, `waypointTypes` declares which decoration `type` strings in this
 * scene's rooms count as a "bookshelf-equivalent" (looking_up trip) or a
 * "coffee-equivalent" (drinking trip). This lets each scene name its
 * decorations naturally (chalkboard / beaker-rack / scaffolding / etc.)
 * while the canonical FSM still finds them.
 */
export interface SceneVocabulary {
  labels: Partial<Record<string, string>>; // WorkerState → label
  waypointTypes: {
    /** Decoration `type`s that serve as a "bookshelf-equivalent" walk target. */
    bookshelf: string[];
    /** Decoration `type`s that serve as a "coffee-equivalent" walk target. */
    coffee: string[];
  };
}

/** Full per-scene config blob loaded from JSON. */
export interface SceneConfig {
  id: string;
  displayName: string;
  icon: string;
  palette: Palette;
  outfit: SceneOutfit;
  vocabulary: SceneVocabulary;
  wallThickness: number;
  growth: { workersPerRoom: number };
  rooms: Array<{
    id: string;
    theme: string;
    cols: number;
    rows: number;
    door?: { x: number; y: number };
    desks: Array<{ id: string; x: number; y: number; sitX: number; sitY: number }>;
    decorations: Array<{ type: string; x: number; y: number; variant?: string }>;
  }>;
}

/**
 * Validate a loaded scene config — catches missing palette keys when authoring
 * a new scene. Throws on the first missing field so the dev sees a clear
 * error rather than a "color undefined" canvas crash mid-frame.
 */
export function validateSceneConfig(s: unknown, source: string): asserts s is SceneConfig {
  if (!s || typeof s !== 'object') {
    throw new Error(`[scene-config:${source}] expected object, got ${typeof s}`);
  }
  const obj = s as Record<string, unknown>;
  for (const key of ['id', 'displayName', 'icon', 'palette', 'outfit', 'vocabulary', 'rooms']) {
    if (!(key in obj)) throw new Error(`[scene-config:${source}] missing top-level "${key}"`);
  }
  const palette = obj.palette as Record<string, unknown>;
  const requiredPaletteKeys: (keyof Palette)[] = [
    'floorPlank1', 'floorPlank2', 'floorPlankSeam', 'floorPlankKnot', 'floorScuff', 'floorShadow',
    'wallTop', 'wallTopShade', 'wallTopHighlight', 'wallTrim', 'wallLower', 'wallLowerShade', 'baseboard',
    'rugBase', 'rugStripe', 'rugBorder', 'rugDiamond',
    'desk', 'deskTop', 'deskTopHi', 'deskShade',
    'monitorFrame', 'monitorFrameHi', 'monitorScreen', 'monitorScreenLit', 'monitorScreenText',
    'monitorScreenDim', 'keyboard', 'keyboardKey', 'mug', 'mugShade', 'paper', 'paperShade',
    'plantPot', 'plantPotShade', 'plantPotHi', 'plantLeaf', 'plantLeafDark', 'plantLeafHi', 'plantFruit',
    'bookshelfBody', 'bookshelfShade', 'book1', 'book2', 'book3', 'book4', 'book5',
    'coffeeBody', 'coffeeBodyHi', 'coffeeRed', 'coffeeSpout', 'coffeeBeans',
    'windowFrame', 'windowFrameShade', 'sky', 'skyHi', 'cloud', 'curtain', 'curtainShade',
    'skyNight', 'skyNightHi', 'moon', 'moonShade', 'moonHi', 'star',
    'skin', 'skinShade', 'skinHi', 'hair', 'hairShade',
    'shirt', 'shirtShade', 'shirtHi', 'pants', 'pantsShade', 'shoe', 'shadow',
    'outline', 'outlineSoft',
    'emoteYellow', 'emoteOutline', 'speechBg', 'speechShade', 'speechBorder',
    'accent', 'accentShade', 'accentHi',
  ];
  for (const k of requiredPaletteKeys) {
    if (typeof palette[k] !== 'string') {
      throw new Error(`[scene-config:${source}] palette is missing "${k}" (must be a hex/rgba string)`);
    }
  }
}
