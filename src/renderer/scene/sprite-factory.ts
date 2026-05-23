/*
 * Procedurally generates pixel-art sprite sheets at runtime by drawing onto an
 * offscreen <canvas> at native pixel resolution (16x16 tiles, 16x24 characters),
 * then turning the canvas into a PixiJS Texture. This keeps the aesthetic
 * cohesive and removes external asset dependencies.
 *
 * Aesthetic targets Stardew Valley's grammar:
 *   - 16x16 base tile, 16x24 character sprites (chibi proportions)
 *   - warm/saturated palette (browns, ochres, soft greens, cream highlights)
 *   - non-black outlines (dark brown/maroon blended with adjacent colors)
 *   - top-left light source, consistent across every prop
 *   - integer-scale, nearest-neighbor render (handled by PixiJS at draw time)
 *   - hard-cut frame animation at 8 fps; no tweening
 *
 * Every visual change should hold this bar — don't add an element unless it
 * has shading, an outline that matches the lighting, and a reason to exist
 * in the scene.
 */
import 'pixi.js/unsafe-eval';
import { Texture, Rectangle, type TextureSource } from 'pixi.js';
import type { Palette, SceneOutfit } from './palette';

interface Px {
  ctx: CanvasRenderingContext2D;
  put(x: number, y: number, color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
}

function newPx(w: number, h: number): Px & { canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  ctx.imageSmoothingEnabled = false;
  const put = (x: number, y: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  };
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  return { canvas, ctx, put, rect };
}

/**
 * Build a pixel-art Texture from a canvas with `scaleMode='nearest'`
 * forced on the underlying source. Critical when the camera zooms with a
 * fractional scale — without this Pixi defaults to linear filtering and
 * sprites turn blurry between integer zoom levels.
 */
function makeTex(canvas: HTMLCanvasElement): Texture {
  const tex = Texture.from(canvas as unknown as TextureSource);
  // Set on the underlying TextureSource so all sub-textures inherit it.
  // Pixi v8 exposes scaleMode on TextureSource ('nearest' | 'linear').
  (tex.source as unknown as { scaleMode: string }).scaleMode = 'nearest';
  return tex;
}

// Scene palette is now passed in per-call. Drawing functions accept `palette: Palette`
// as their first argument; every color reference reads from that object. See
// `palette.ts` for the interface and `config/scenes/*.config.json` for the
// per-scene color values.

/* ---------------- Office background ---------------- */
/**
 * Multi-room layout: each room contributes its own footprint along the
 * x-axis, and decorations are placed at room-local pixels offset by the
 * room's originTileX. Rows are uniform across rooms.
 *
 * `rooms` items match the shape produced by `expandWorld()` in shared/config.
 */
export interface BgRoom {
  originTileX: number;
  cols: number;
  rows: number;
  decorations: Array<{ type: string; x: number; y: number; variant?: string }>;
}

export function makeOfficeBackground(
  palette: Palette,
  rooms: BgRoom[],
  themeKind: SceneOutfit['kind'] = 'cozy',
): Texture {
  if (rooms.length === 0) {
    // Empty world — return a 1x1 transparent texture as a safe placeholder.
    const p = newPx(1, 1);
    return Texture.from(p.canvas as unknown as TextureSource);
  }
  const totalCols = Math.max(
    ...rooms.map((r) => r.originTileX + r.cols),
  );
  const rows = Math.max(...rooms.map((r) => r.rows));
  const w = totalCols * 16;
  const h = rows * 16;
  const p = newPx(w, h);
  const WALL_ROWS = 3; // top 3 tiles are wall

  // Dispatch floor + wall on themeKind. Each drawer paints the floor band
  // (y >= WALL_ROWS) and the wall band (y < WALL_ROWS) using palette colors,
  // so the scene's visual identity comes from pattern + palette together.
  drawFloor(palette, p, w, totalCols, rows, WALL_ROWS, themeKind);
  drawWall(palette, p, w, totalCols, themeKind);

  // ---- Per-room decorations ----
  for (const room of rooms) {
    const ox = room.originTileX * 16;
    for (const dec of room.decorations) {
      const x = ox + dec.x;
      const y = dec.y;
      switch (dec.type) {
        case 'window':
          drawWindow(palette, p, x, y);
          break;
        case 'picture':
          drawPicture(palette, p, x, y);
          break;
        case 'sconce':
          drawSconce(palette, p, x, y);
          break;
        case 'rug':
          drawRug(palette, p, x, y);
          break;
        case 'bookshelf':
        case 'wiki-shelf':
        case 'library-shelf':
        case 'reference-archive':
          // Bookshelf-equivalent walk targets. Each scene's palette gives
          // the shelf the right colors.
          drawBookshelf(palette, p, x, y);
          break;
        case 'chalkboard':
          drawChalkboard(palette, p, x, y);
          break;
        case 'blueprint-table':
          drawBlueprintTable(palette, p, x, y);
          break;
        case 'fume-hood':
          drawFumeHood(palette, p, x, y);
          break;
        case 'scaffolding':
          drawScaffolding(palette, p, x, y);
          break;
        case 'lockers':
          drawLockers(palette, p, x, y);
          break;
        case 'whiteboard':
          drawWhiteboard(palette, p, x, y);
          break;
        case 'filing-cabinet':
          drawFilingCabinet(palette, p, x, y);
          break;
        case 'world-map':
          drawWorldMap(palette, p, x, y);
          break;
        case 'periodic-table':
          drawPeriodicTable(palette, p, x, y);
          break;
        case 'eye-wash':
          drawEyeWash(palette, p, x, y);
          break;
        case 'water-cooler':
          drawWaterCooler(palette, p, x, y);
          break;
        case 'beaker-rack':
          drawBeakerRack(palette, p, x, y);
          break;
        case 'coffee-machine':
        case 'espresso-bar':
        case 'cafeteria-counter':
          // Remaining coffee-equivalent walk targets share the coffee
          // machine drawer (palette + mug prop convey scene differences).
          drawCoffeeMachine(palette, p, x, y);
          break;
        case 'plant':
          drawPlant(palette, p, x, y, (dec.variant as 'leafy' | 'spike') ?? 'leafy');
          break;
        default:
          // Unknown decoration — silently skip; helps if config adds types
          // before sprite-factory has a matching helper.
          break;
      }
    }
  }

  return makeTex(p.canvas);
}

/* ---------------- Per-theme floor + wall drawers ---------------- */
/**
 * Floor: paints the band from y = WALL_ROWS*16 to y = rows*16 with a
 * pattern matched to the scene's theme. Each theme has its own surface
 * grammar (wood planks for cozy, white tile grid for lab, etc.) so the
 * scenes read as different workplaces even before the decorations land.
 *
 * All coordinates are in baked-canvas pixels; the caller's `p` is the
 * working pixel buffer.
 */
function drawFloor(
  palette: Palette,
  p: Px,
  w: number,
  totalCols: number,
  rows: number,
  wallRows: number,
  themeKind: SceneOutfit['kind'],
) {
  switch (themeKind) {
    case 'lab':
      drawFloorLabTile(palette, p, w, totalCols, rows, wallRows);
      break;
    case 'school':
      drawFloorSchoolLinoleum(palette, p, w, totalCols, rows, wallRows);
      break;
    case 'construction':
      drawFloorConcreteSlab(palette, p, w, totalCols, rows, wallRows);
      break;
    case 'modern':
      drawFloorPolishedConcrete(palette, p, w, totalCols, rows, wallRows);
      break;
    case 'cozy':
    default:
      drawFloorWoodPlanks(palette, p, w, totalCols, rows, wallRows);
      break;
  }
}

function drawWall(
  palette: Palette,
  p: Px,
  w: number,
  totalCols: number,
  themeKind: SceneOutfit['kind'],
) {
  switch (themeKind) {
    case 'lab':
      drawWallLabPanels(palette, p, w, totalCols);
      break;
    case 'school':
      drawWallSchoolWainscoting(palette, p, w, totalCols);
      break;
    case 'construction':
      drawWallConstructionStuds(palette, p, w, totalCols);
      break;
    case 'modern':
      drawWallModernGlass(palette, p, w, totalCols);
      break;
    case 'cozy':
    default:
      drawWallWoodPanels(palette, p, w, totalCols);
      break;
  }
}

/** Original wood-plank floor (cozy-office baseline). */
function drawFloorWoodPlanks(
  palette: Palette,
  p: Px,
  w: number,
  totalCols: number,
  rows: number,
  wallRows: number,
) {
  const ctx = p.ctx;
  function baseColorForFloor(x: number, y: number): string {
    const rowOffset = (y % 2) * 32;
    const plankIndex = Math.floor((x + rowOffset) / 64);
    return plankIndex % 2 === 0 ? palette.floorPlank2 : palette.floorPlank1;
  }
  for (let y = wallRows; y < rows; y++) {
    const rowOffset = (y % 2) * 32;
    for (let x = 0; x < totalCols; x++) {
      const px = x * 16;
      const py = y * 16;
      const plankIndex = Math.floor((px + rowOffset) / 64);
      const base = plankIndex % 2 === 0 ? palette.floorPlank1 : palette.floorPlank2;
      p.rect(px, py, 16, 16, base);
    }
    p.rect(0, y * 16, w, 1, palette.floorShadow);
    for (let pi = 0; pi * 64 - rowOffset < w + 64; pi++) {
      const seamX = pi * 64 - rowOffset;
      if (seamX >= 0 && seamX < w) {
        p.rect(seamX, y * 16, 1, 16, palette.floorPlankSeam);
      }
    }
    for (let x = 0; x < w; x += 7) {
      const gy = y * 16 + ((x * 3) % 13);
      if (gy >= y * 16 + 2 && gy < y * 16 + 14) {
        ctx.fillStyle = baseColorForFloor(x, y);
        ctx.fillRect(x, gy, 4, 1);
      }
    }
    for (let x = 0; x < totalCols; x++) {
      if (((x * 31 + y * 17) & 31) === 0) {
        const kx = x * 16 + 7;
        const ky = y * 16 + 7;
        p.rect(kx, ky, 2, 2, palette.floorPlankKnot);
        p.put(kx + 1, ky - 1, palette.floorPlankKnot);
        p.put(kx, ky + 2, palette.floorPlankKnot);
      }
    }
  }
}

/**
 * Lab floor: 16x16 white ceramic tiles with grout lines. Subtle pixel
 * speckle inside each tile keeps it from looking too sterile / flat.
 * Stardew-grammar: never pure white — the base is `floorPlank1` (set to
 * a near-white in the lab palette), grout is `floorPlankSeam`.
 */
function drawFloorLabTile(
  palette: Palette,
  p: Px,
  w: number,
  totalCols: number,
  rows: number,
  wallRows: number,
) {
  for (let y = wallRows; y < rows; y++) {
    for (let x = 0; x < totalCols; x++) {
      const px = x * 16;
      const py = y * 16;
      // Alternate slight tone variation between adjacent tiles so the grid
      // reads but stays cohesive.
      const alt = ((x + y) & 1) === 0;
      const base = alt ? palette.floorPlank1 : palette.floorPlank2;
      p.rect(px, py, 16, 16, base);
      // Soft top-left highlight on each tile
      p.rect(px + 1, py + 1, 14, 1, palette.floorScuff);
      p.rect(px + 1, py + 1, 1, 14, palette.floorScuff);
      // Subtle bottom-right shade
      p.rect(px + 1, py + 14, 14, 1, palette.floorPlankKnot);
      p.rect(px + 14, py + 1, 1, 14, palette.floorPlankKnot);
      // Speckle (deterministic pseudo-noise)
      const hash = (x * 911 + y * 277) & 7;
      if (hash === 0) p.put(px + 5, py + 9, palette.floorPlankKnot);
      if (hash === 3) p.put(px + 11, py + 4, palette.floorPlankKnot);
    }
    // Grout lines: a 1-px dark seam at the bottom of every tile row.
    p.rect(0, y * 16 + 15, w, 1, palette.floorPlankSeam);
  }
  // Vertical grout lines (every 16 px)
  for (let x = 0; x <= totalCols; x++) {
    const px = x * 16;
    p.rect(px, wallRows * 16, 1, (rows - wallRows) * 16, palette.floorPlankSeam);
  }
}

/** Original wood-panel wall (cozy-office baseline). */
function drawWallWoodPanels(palette: Palette, p: Px, w: number, totalCols: number) {
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 0, 16, 32, palette.wallTop);
    p.rect(px, 0, 16, 2, palette.wallTopHighlight);
    p.rect(px, 0, 1, 32, palette.wallTopShade);
    if (x % 2 === 0) p.rect(px + 8, 4, 1, 24, palette.wallTopShade);
  }
  p.rect(0, 32, w, 2, palette.wallTrim);
  p.rect(0, 31, w, 1, palette.wallTopHighlight);
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 34, 16, 12, palette.wallLower);
    if (x % 3 === 0) p.rect(px, 34, 1, 12, palette.wallLowerShade);
  }
  p.rect(0, 46, w, 2, palette.baseboard);
  p.rect(0, 48, w, 1, palette.floorShadow);
}

/**
 * Lab wall: stainless-steel lower wainscoting + light blue painted upper
 * wall with a single horizontal accent stripe. Reads as a clean/clinical
 * laboratory finish at a glance.
 */
function drawWallLabPanels(palette: Palette, p: Px, w: number, totalCols: number) {
  // Upper wall: light blue painted finish (palette.wallTop)
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 0, 16, 32, palette.wallTop);
    // Top highlight band
    p.rect(px, 0, 16, 2, palette.wallTopHighlight);
    // Ceiling shadow (subtle, near top)
    p.rect(px, 2, 16, 1, palette.wallTopShade);
  }
  // Horizontal accent stripe (one tile down from top of wall band)
  p.rect(0, 14, w, 2, palette.accent);
  p.rect(0, 14, w, 1, palette.accentHi);

  // Trim between upper wall and stainless lower wainscoting
  p.rect(0, 32, w, 1, palette.wallTrim);
  p.rect(0, 33, w, 1, palette.wallTopHighlight);

  // Lower wainscoting: stainless-steel panels (palette.wallLower).
  // Brushed-metal grain = thin horizontal lines + subtle vertical seams
  // every 2 tiles.
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 34, 16, 12, palette.wallLower);
    // Brushed grain
    p.rect(px, 36, 16, 1, palette.wallLowerShade);
    p.rect(px, 40, 16, 1, palette.wallLowerShade);
    // Vertical seam every 2 tiles for paneling effect
    if (x % 2 === 0) {
      p.rect(px, 34, 1, 12, palette.wallTopShade);
    }
  }
  // Baseboard
  p.rect(0, 46, w, 2, palette.baseboard);
  p.rect(0, 48, w, 1, palette.floorShadow);
}

/**
 * School floor: classic linoleum 32x16 tiles laid in a two-tone alternating
 * pattern (warm honey + cream), with a thin 1-px scuff highlight on each tile
 * and a darker tile seam between them. Stardew classrooms in pixel art
 * usually go for this large-tile, low-detail look — busy floors fight the
 * student desks and chalkboards.
 */
function drawFloorSchoolLinoleum(
  palette: Palette,
  p: Px,
  w: number,
  totalCols: number,
  rows: number,
  wallRows: number,
) {
  // Tiles are 32 wide × 16 high so they read clearly without checkerboarding
  // every tile. Two tones alternate row-by-row + column-by-column.
  for (let y = wallRows; y < rows; y++) {
    const rowShift = (y & 1) === 0 ? 0 : 16; // brick-stagger so seams break
    for (let x = 0; x < totalCols; x++) {
      const px = x * 16;
      const py = y * 16;
      const tileIdx = Math.floor((px + rowShift) / 32);
      const base = (tileIdx + y) & 1 ? palette.floorPlank1 : palette.floorPlank2;
      p.rect(px, py, 16, 16, base);
      // Subtle scuff highlight near top of tile
      p.rect(px + 1, py + 1, 14, 1, palette.floorScuff);
      // Soft bottom shade
      p.rect(px, py + 15, 16, 1, palette.floorShadow);
    }
    // Vertical tile seams every 32 px, staggered by row
    for (let pi = 0; pi * 32 + rowShift < w; pi++) {
      const seamX = pi * 32 + rowShift;
      p.rect(seamX, y * 16, 1, 16, palette.floorPlankSeam);
    }
    // Speckle (pseudo-random freckles)
    for (let x = 0; x < w; x += 11) {
      const fx = x + ((y * 7) % 9);
      const fy = y * 16 + ((x * 5) % 14) + 1;
      if (((x + y) & 3) === 0) p.put(fx, fy, palette.floorPlankKnot);
    }
  }
}

/**
 * School wall: chalkboard-green wainscoting on the bottom half (12 px),
 * cream-painted upper wall, and a wood chair rail trim between them.
 * Hints at "classroom" without committing to any one feature wall.
 */
function drawWallSchoolWainscoting(palette: Palette, p: Px, w: number, totalCols: number) {
  // Upper wall: cream paint (palette.wallLower as the bright cream)
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 0, 16, 32, palette.wallLower);
    // Top ceiling shadow
    p.rect(px, 0, 16, 2, palette.wallLowerShade);
  }
  // Decorative chair-rail above wainscoting: dark trim band
  p.rect(0, 30, w, 2, palette.wallTrim);
  p.rect(0, 29, w, 1, palette.wallTopHighlight);
  p.rect(0, 32, w, 1, palette.wallLowerShade);

  // Lower wainscoting: chalkboard-green panels (palette.wallTop)
  // with vertical wood batten strips every 2 tiles to suggest panel seams.
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 33, 16, 13, palette.wallTop);
    // Top highlight along the wainscoting cap
    p.rect(px, 33, 16, 1, palette.wallTopHighlight);
    // Vertical seam every 2 tiles
    if (x % 2 === 0) {
      p.rect(px, 33, 1, 13, palette.wallTopShade);
    }
  }
  // Baseboard (dark trim)
  p.rect(0, 46, w, 2, palette.baseboard);
  p.rect(0, 48, w, 1, palette.floorShadow);
}

/**
 * Construction floor: poured-concrete slab. Mostly uniform tone with
 * deterministic crack patterns, scuff marks, and small debris specks.
 * No tile grid — concrete reads as one continuous surface punctuated by
 * a couple of expansion-joint seams running vertically.
 */
function drawFloorConcreteSlab(
  palette: Palette,
  p: Px,
  w: number,
  totalCols: number,
  rows: number,
  wallRows: number,
) {
  // Base slab fill with subtle 2-tone speckle
  for (let y = wallRows; y < rows; y++) {
    for (let x = 0; x < totalCols; x++) {
      const px = x * 16;
      const py = y * 16;
      // Alternating shade chunks at 2-tile granularity for non-flat look
      const chunk = (Math.floor(x / 2) + Math.floor(y / 2)) & 1;
      p.rect(px, py, 16, 16, chunk ? palette.floorPlank1 : palette.floorPlank2);
      // Light scuff in the center
      const hash = (x * 941 + y * 311) & 15;
      if (hash === 0) p.rect(px + 4, py + 6, 5, 1, palette.floorScuff);
      if (hash === 7) p.put(px + 12, py + 3, palette.floorScuff);
    }
  }
  // Expansion joints (vertical) every 6 tiles — a darker 1-px seam
  for (let jx = 96; jx < w; jx += 96) {
    p.rect(jx, wallRows * 16, 1, (rows - wallRows) * 16, palette.floorPlankSeam);
    p.rect(jx + 1, wallRows * 16, 1, (rows - wallRows) * 16, palette.floorShadow);
  }
  // Random hairline cracks (deterministic placement)
  const cracks: Array<[number, number, number, number]> = [
    [40, 8, 18, 1], [120, 11, 12, 1], [200, 9, 14, 1], [280, 12, 10, 1],
    [60, 13, 8, 1], [180, 14, 9, 1], [310, 10, 15, 1],
  ];
  for (const [cx, cy, cw, ch] of cracks) {
    const px = cx;
    const py = (wallRows + cy) * 1; // already in pixel y
    if (py < rows * 16) p.rect(px, py, cw, ch, palette.floorPlankSeam);
  }
  // Debris specks (small darker dots)
  for (let i = 0; i < 40; i++) {
    const px = ((i * 73) % w);
    const py = wallRows * 16 + ((i * 53) % ((rows - wallRows) * 16 - 2)) + 1;
    p.put(px, py, palette.floorPlankKnot);
  }
}

/**
 * Construction wall: exposed 2x4 stud framing on top of plywood/OSB
 * sheathing. Vertical wood beams every 32 px reveal the bones of the
 * building; the band above is rough plywood with a hi-vis safety-orange
 * caution tape stripe near the top.
 */
function drawWallConstructionStuds(palette: Palette, p: Px, w: number, totalCols: number) {
  // Plywood/OSB backing across the full upper wall
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 0, 16, 32, palette.wallLower);
    // Horizontal grain bands every 8 px
    p.rect(px, 4, 16, 1, palette.wallLowerShade);
    p.rect(px, 12, 16, 1, palette.wallLowerShade);
    p.rect(px, 20, 16, 1, palette.wallLowerShade);
    p.rect(px, 28, 16, 1, palette.wallLowerShade);
  }
  // Safety-orange caution tape band near top (with black diagonal hash)
  for (let x = 0; x < w; x++) {
    const blackHash = ((x + Math.floor(x / 4)) % 8) < 4;
    p.put(x, 6, blackHash ? palette.outline : palette.accent);
    p.put(x, 7, blackHash ? palette.outline : palette.accent);
    p.put(x, 8, blackHash ? palette.outline : palette.accent);
  }
  // Highlight just above the tape
  p.rect(0, 5, w, 1, palette.accentHi);

  // Exposed vertical 2x4 studs every 32 px (2-tile spacing)
  for (let sx = 0; sx < w; sx += 32) {
    // Stud body (3 px wide)
    p.rect(sx + 6, 0, 3, 32, palette.wallTop);
    // Lit edge
    p.put(sx + 6, 0, palette.wallTopHighlight);
    p.rect(sx + 6, 0, 1, 32, palette.wallTopHighlight);
    // Dark edge
    p.rect(sx + 8, 0, 1, 32, palette.wallTopShade);
    // A nail / knot at irregular heights
    const knotY = 6 + ((sx / 32) % 4) * 4;
    p.put(sx + 7, knotY, palette.wallTopShade);
  }
  // Header beam horizontally crossing the top of the studs
  p.rect(0, 0, w, 3, palette.wallTop);
  p.rect(0, 0, w, 1, palette.wallTopHighlight);
  p.rect(0, 2, w, 1, palette.wallTopShade);

  // Bottom plate (horizontal 2x4 along the floor)
  p.rect(0, 30, w, 4, palette.wallTop);
  p.rect(0, 30, w, 1, palette.wallTopHighlight);
  p.rect(0, 33, w, 1, palette.wallTopShade);

  // Trim between bottom plate and lower wall
  p.rect(0, 34, w, 1, palette.wallLowerShade);

  // Lower section: another stretch of plywood backing
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 35, 16, 11, palette.wallLower);
    if (x % 2 === 0) p.rect(px, 35, 1, 11, palette.wallLowerShade);
  }
  // Baseboard / floor trim (dark)
  p.rect(0, 46, w, 2, palette.baseboard);
  p.rect(0, 48, w, 1, palette.floorShadow);
}

/**
 * Modern office floor: large polished concrete slabs (64x64) with high-
 * gloss horizontal reflection bands suggesting overhead light. The
 * surface is largely uniform — what makes it read as "modern" vs.
 * "construction concrete" is the polish: clean seams, bright reflection
 * highlights, no debris.
 */
function drawFloorPolishedConcrete(
  palette: Palette,
  p: Px,
  w: number,
  totalCols: number,
  rows: number,
  wallRows: number,
) {
  // Base slab fill
  for (let y = wallRows; y < rows; y++) {
    const py = y * 16;
    // Slab tone alternates by 4-tile bands for subtle pour-line variation
    for (let x = 0; x < totalCols; x++) {
      const px = x * 16;
      const band = Math.floor(x / 4) & 1;
      p.rect(px, py, 16, 16, band ? palette.floorPlank1 : palette.floorPlank2);
    }
  }
  // Polished-concrete slab seams (cross grid at 64x64)
  for (let sx = 64; sx < w; sx += 64) {
    p.rect(sx, wallRows * 16, 1, (rows - wallRows) * 16, palette.floorPlankSeam);
  }
  for (let sy = wallRows * 16 + 64; sy < rows * 16; sy += 64) {
    p.rect(0, sy, w, 1, palette.floorPlankSeam);
  }
  // Bright reflection band per slab (one horizontal lighter streak)
  for (let sy = wallRows * 16; sy < rows * 16; sy += 64) {
    const bandY = sy + 32;
    p.rect(0, bandY, w, 1, palette.floorScuff);
    p.rect(0, bandY + 1, w, 1, palette.floorScuff);
  }
  // Subtle vertical highlight near each seam (reflection echo)
  for (let sx = 0; sx < w; sx += 64) {
    p.rect(sx + 4, wallRows * 16, 1, (rows - wallRows) * 16, palette.floorScuff);
  }
  // Sparse subtle aggregate specks
  for (let i = 0; i < 30; i++) {
    const px = ((i * 91) % w);
    const py = wallRows * 16 + ((i * 47) % ((rows - wallRows) * 16 - 2)) + 1;
    p.put(px, py, palette.floorPlankKnot);
  }
}

/**
 * Modern office wall: glass-curtain wall partition. Dark mullion frames
 * divide tinted-blue glass panels at the upper wall; a slim teal accent
 * stripe at the base of the glass; and a clean light-grey kicker (lower
 * wall) finishes the look. The glass shows a faint horizontal reflection
 * line + scattered highlight dots to suggest sheen without obscuring
 * what's behind.
 */
function drawWallModernGlass(palette: Palette, p: Px, w: number, totalCols: number) {
  // Tinted glass panels: 32-px-wide bays separated by 2-px mullions.
  // Glass uses a light sky-blue (palette.sky) mixed with palette.wallLowerShade
  // to suggest tint without competing with the actual window decorations.
  const glassFill = palette.sky;
  const glassEdge = palette.wallLowerShade;

  // Header mullion (top)
  p.rect(0, 0, w, 3, palette.wallTop);
  p.rect(0, 0, w, 1, palette.wallTopHighlight);
  p.rect(0, 2, w, 1, palette.wallTopShade);

  // Glass panels (rows 3..27, 24 px tall)
  for (let x = 0; x < w; x++) {
    p.put(x, 3, glassEdge);
  }
  for (let y = 4; y < 28; y++) {
    for (let x = 0; x < w; x++) {
      p.put(x, y, glassFill);
    }
  }
  // Mullion bars: vertical dark divider every 32 px (2 tiles)
  for (let mx = 0; mx <= w; mx += 32) {
    p.rect(mx, 3, 2, 25, palette.wallTop);
    p.put(mx, 3, palette.wallTopHighlight);
    p.put(mx + 1, 3, palette.wallTopHighlight);
  }
  // Reflection line in glass: one slim horizontal slash across each bay
  for (let bx = 0; bx < w; bx += 32) {
    const lineY = 9 + (Math.floor(bx / 32) % 3) * 2;
    p.rect(bx + 4, lineY, 18, 1, palette.cloud);
  }
  // Specular highlight dots scattered across the glass
  for (let i = 0; i < 25; i++) {
    const hx = (i * 71) % w;
    const hy = 5 + ((i * 31) % 20);
    p.put(hx, hy, palette.skyHi);
  }
  // Bottom mullion under the glass
  p.rect(0, 28, w, 2, palette.wallTop);
  p.rect(0, 28, w, 1, palette.wallTopHighlight);

  // Slim teal accent stripe just under glass
  p.rect(0, 30, w, 1, palette.accent);
  p.rect(0, 31, w, 1, palette.accentShade);

  // Lower wall: clean light-grey kicker (palette.wallLower)
  for (let x = 0; x < totalCols; x++) {
    const px = x * 16;
    p.rect(px, 32, 16, 14, palette.wallLower);
    // Subtle vertical grain every 4 tiles
    if (x % 4 === 0) p.rect(px, 32, 1, 14, palette.wallLowerShade);
  }
  // Top edge highlight of kicker
  p.rect(0, 32, w, 1, palette.floorScuff);

  // Baseboard
  p.rect(0, 46, w, 2, palette.baseboard);
  p.rect(0, 48, w, 1, palette.floorShadow);
}

// Window dimensions + placement, exported so Office.tsx can overlay a live
// sky sprite (clouds vs moon) at the same interior coordinates the baked
// background uses. Keep these in sync with drawWindow().
export const WINDOW = {
  W: 64,
  H: 26,
  innerInset: 2,
  y: 4,
} as const;

export function windowOriginX(cols: number): number {
  return (Math.floor(cols / 2) - 2) * 16;
}

function drawWindow(palette: Palette, p: Px, x: number, y: number) {
  const W = WINDOW.W; // 4 tiles wide
  const H = WINDOW.H;
  // Frame
  p.rect(x, y, W, H, palette.windowFrame);
  // Sky background
  p.rect(x + 2, y + 2, W - 4, H - 4, palette.sky);
  // Lighter band toward top of sky
  p.rect(x + 2, y + 2, W - 4, 4, palette.skyHi);
  // Clouds
  p.rect(x + 8, y + 6, 8, 2, palette.cloud);
  p.rect(x + 10, y + 5, 4, 1, palette.cloud);
  p.rect(x + 36, y + 8, 10, 2, palette.cloud);
  p.rect(x + 40, y + 7, 6, 1, palette.cloud);
  p.rect(x + 28, y + 14, 4, 1, palette.cloud);
  // Cross-mullion
  p.rect(x + W / 2 - 1, y + 1, 2, H - 2, palette.windowFrame);
  p.rect(x + 1, y + H / 2 - 1, W - 2, 2, palette.windowFrame);
  // Inner shade line
  p.rect(x + 2, y + 2, W - 4, 1, palette.windowFrameShade);
  // Curtains (cream, gathered)
  for (let i = 0; i < 4; i++) {
    const cx = x - 4 + i * 2;
    p.rect(cx, y - 1, 2, H + 4, palette.curtain);
    p.rect(cx + 1, y - 1, 1, H + 4, palette.curtainShade);
  }
  for (let i = 0; i < 4; i++) {
    const cx = x + W + i * 2;
    p.rect(cx, y - 1, 2, H + 4, palette.curtain);
    p.rect(cx + 1, y - 1, 1, H + 4, palette.curtainShade);
  }
}

/**
 * Sky overlay shown through the window. The office background bakes a daytime
 * sky into the texture; this overlay sits on top of just the window interior
 * (including a re-drawn cross-mullion) and swaps between day and night.
 *
 * Texture is interior-sized only — caller positions it at
 * (windowOriginX(cols) + innerInset, WINDOW.y + innerInset).
 */
export function makeSkyTexture(palette: Palette, mode: 'day' | 'night'): Texture {
  const W = WINDOW.W - WINDOW.innerInset * 2; // 60
  const H = WINDOW.H - WINDOW.innerInset * 2; // 22
  const p = newPx(W, H);

  if (mode === 'day') {
    // Sky base + lighter top band
    p.rect(0, 0, W, H, palette.sky);
    p.rect(0, 0, W, 4, palette.skyHi);
    // Clouds (same positions as the baked window for continuity)
    p.rect(6, 4, 8, 2, palette.cloud);
    p.rect(8, 3, 4, 1, palette.cloud);
    p.rect(34, 6, 10, 2, palette.cloud);
    p.rect(38, 5, 6, 1, palette.cloud);
    p.rect(26, 12, 4, 1, palette.cloud);
  } else {
    // Night base + slightly lighter band near the horizon (top of window)
    p.rect(0, 0, W, H, palette.skyNight);
    p.rect(0, 0, W, 3, palette.skyNightHi);
    // Stars sprinkled across, denser in the upper half
    const stars: Array<[number, number]> = [
      [3, 2], [9, 5], [16, 1], [22, 3], [29, 7], [33, 2], [41, 4],
      [48, 1], [55, 6], [58, 3], [5, 15], [19, 14], [30, 17], [50, 13],
      [56, 18],
    ];
    for (const [sx, sy] of stars) p.put(sx, sy, palette.star);
    // Moon: 6x6 disc with a 1-px highlight & shade for volume
    const mx = 40;
    const my = 9;
    p.rect(mx, my, 6, 6, palette.moon);
    p.rect(mx + 1, my, 4, 1, palette.moonHi);
    p.put(mx, my + 1, palette.moonHi);
    p.put(mx + 5, my + 4, palette.moonShade);
    p.rect(mx + 2, my + 5, 4, 1, palette.moonShade);
  }

  // Cross-mullion — baked back in so the overlay looks like real panes,
  // not a sticker pasted over the window. Matches drawWindow().
  p.rect(W / 2 - 1, 0, 2, H, palette.windowFrame);
  p.rect(0, H / 2 - 1, W, 2, palette.windowFrame);

  return makeTex(p.canvas);
}

/** Pick which sky to show based on the local wall clock. */
export function currentSkyMode(d: Date = new Date()): 'day' | 'night' {
  const h = d.getHours();
  return h >= 6 && h < 18 ? 'day' : 'night';
}

function drawPicture(palette: Palette, p: Px, x: number, y: number) {
  // Outer frame
  p.rect(x, y, 10, 8, palette.windowFrame);
  // Inner canvas
  p.rect(x + 1, y + 1, 8, 6, '#d0a878');
  // Tiny scene — sun + horizon
  p.rect(x + 1, y + 4, 8, 3, '#3a8a3a');
  p.put(x + 7, y + 2, '#ffe0a0');
  p.rect(x + 6, y + 2, 3, 1, '#ffd070');
  // Frame inner shadow
  p.rect(x + 1, y + 7, 8, 1, palette.windowFrameShade);
}

function drawSconce(palette: Palette, p: Px, x: number, y: number) {
  // Wall mount
  p.rect(x, y, 2, 4, palette.windowFrame);
  // Bulb (yellow glow)
  p.put(x + 1, y - 1, '#ffe080');
  p.put(x, y, '#ffd060');
  p.put(x + 1, y, '#fff080');
  p.put(x + 2, y, '#ffd060');
  // Light cast on wall (subtle)
  p.put(x - 1, y + 2, '#705030');
  p.put(x + 3, y + 2, '#705030');
}

function drawRug(palette: Palette, p: Px, x: number, y: number) {
  const W = 56;
  const H = 32;
  // Base
  p.rect(x, y, W, H, palette.rugBase);
  // Border (1-px frame)
  p.rect(x, y, W, 1, palette.rugBorder);
  p.rect(x, y + H - 1, W, 1, palette.rugBorder);
  p.rect(x, y, 1, H, palette.rugBorder);
  p.rect(x + W - 1, y, 1, H, palette.rugBorder);
  // Inner stripe (2-px inset)
  p.rect(x + 2, y + 2, W - 4, 1, palette.rugStripe);
  p.rect(x + 2, y + H - 3, W - 4, 1, palette.rugStripe);
  // Diamond pattern in center
  const cx = x + W / 2;
  const cy = y + H / 2;
  for (let i = 0; i < 4; i++) {
    p.rect(cx - i - 1, cy - 4 + i, 2, 1, palette.rugDiamond);
    p.rect(cx + i, cy - 4 + i, 2, 1, palette.rugDiamond);
    p.rect(cx - i - 1, cy + 3 - i, 2, 1, palette.rugDiamond);
    p.rect(cx + i, cy + 3 - i, 2, 1, palette.rugDiamond);
  }
  // Fringe at top and bottom
  for (let i = 0; i < W; i += 2) {
    p.put(x + i, y - 1, palette.rugBorder);
    p.put(x + i, y + H, palette.rugBorder);
  }
}

function drawBookshelf(palette: Palette, p: Px, x: number, y: number) {
  const W = 24;
  const H = 26;
  // Body
  p.rect(x, y, W, H, palette.bookshelfBody);
  // Side and top trim
  p.rect(x, y, W, 2, palette.bookshelfShade);
  p.rect(x, y + H - 2, W, 2, palette.bookshelfShade);
  p.rect(x, y, 2, H, palette.bookshelfShade);
  p.rect(x + W - 2, y, 2, H, palette.bookshelfShade);
  // Shelves (3)
  for (let s = 0; s < 3; s++) {
    const shelfY = y + 4 + s * 7;
    p.rect(x + 2, shelfY + 6, W - 4, 1, palette.bookshelfShade);
    // Books on the shelf
    const colors = [palette.book1, palette.book2, palette.book3, palette.book4, palette.book5];
    let bx = x + 3;
    for (let i = 0; i < 5; i++) {
      const c = colors[(i + s) % colors.length];
      const bh = 5 + ((i * 7 + s) % 2);
      const bw = 2 + ((i + s) % 2);
      p.rect(bx, shelfY + (6 - bh), bw, bh, c);
      // Spine highlight
      p.rect(bx, shelfY + (6 - bh), 1, 1, '#ffffff');
      bx += bw + 1;
      if (bx > x + W - 4) break;
    }
  }
  // Floor shadow
  p.rect(x - 1, y + H, W + 2, 1, palette.floorShadow);
}

function drawPlant(palette: Palette, p: Px, x: number, y: number, variant: 'leafy' | 'spike') {
  // Pot
  p.rect(x + 4, y + 11, 8, 5, palette.plantPot);
  p.rect(x + 4, y + 11, 8, 1, palette.plantPotHi);
  p.rect(x + 4, y + 15, 8, 1, palette.plantPotShade);
  // Soil line
  p.rect(x + 5, y + 12, 6, 1, palette.plantPotShade);
  if (variant === 'leafy') {
    // Wide leafy fern
    p.rect(x + 3, y + 4, 10, 7, palette.plantLeaf);
    p.rect(x + 4, y + 3, 8, 1, palette.plantLeaf);
    p.put(x + 5, y + 2, palette.plantLeaf);
    p.put(x + 7, y + 1, palette.plantLeaf);
    p.put(x + 9, y + 2, palette.plantLeaf);
    // shading
    p.rect(x + 3, y + 4, 1, 6, palette.plantLeafDark);
    p.rect(x + 12, y + 4, 1, 6, palette.plantLeafDark);
    p.put(x + 6, y + 6, palette.plantLeafDark);
    p.put(x + 9, y + 5, palette.plantLeafDark);
    // tiny berry
    p.put(x + 7, y + 5, palette.plantFruit);
    // highlights
    p.put(x + 6, y + 3, palette.plantLeafHi);
    p.put(x + 10, y + 4, palette.plantLeafHi);
  } else {
    // Tall spike/cactus-like
    p.rect(x + 6, y + 2, 4, 9, palette.plantLeaf);
    p.rect(x + 6, y + 2, 1, 9, palette.plantLeafDark);
    p.rect(x + 9, y + 2, 1, 9, palette.plantLeafDark);
    // arms
    p.rect(x + 4, y + 6, 2, 4, palette.plantLeaf);
    p.put(x + 4, y + 5, palette.plantLeaf);
    p.rect(x + 10, y + 5, 2, 4, palette.plantLeaf);
    p.put(x + 11, y + 4, palette.plantLeaf);
    // spikes
    p.put(x + 7, y + 4, palette.plantLeafHi);
    p.put(x + 8, y + 7, palette.plantLeafHi);
    p.put(x + 7, y + 9, palette.plantLeafHi);
    // bloom on top
    p.put(x + 7, y + 1, palette.plantFruit);
    p.put(x + 8, y + 1, palette.plantFruit);
  }
}

function drawCoffeeMachine(palette: Palette, p: Px, x: number, y: number) {
  // Drop shadow on floor below
  p.rect(x - 1, y + 13, 14, 1, palette.floorShadow);
  // Body
  p.rect(x, y, 12, 13, palette.coffeeBody);
  // Top highlight
  p.rect(x, y, 12, 1, palette.coffeeBodyHi);
  // Display screen
  p.rect(x + 2, y + 2, 8, 2, palette.coffeeRed);
  p.put(x + 3, y + 2, '#ffd070');
  p.put(x + 5, y + 2, '#ffd070');
  // Spout
  p.rect(x + 5, y + 5, 2, 3, palette.coffeeSpout);
  // Cup catch
  p.rect(x + 3, y + 9, 6, 1, palette.coffeeBodyHi);
  p.rect(x + 3, y + 10, 6, 2, palette.coffeeBody);
  // Coffee bean accent
  p.put(x + 4, y + 6, palette.coffeeBeans);
  p.put(x + 7, y + 6, palette.coffeeBeans);
}

/* ---------------- Scene-specific decoration drawers ---------------- */

/**
 * Chalkboard (school) — large green wall-mounted board with a wood frame
 * and white chalk writing. Sized to read as a feature wall element.
 */
function drawChalkboard(palette: Palette, p: Px, x: number, y: number) {
  const W = 48;
  const H = 26;
  // Wood frame
  p.rect(x, y, W, H, palette.bookshelfBody);
  p.rect(x, y, W, 1, palette.bookshelfShade);
  p.rect(x, y + H - 1, W, 1, palette.bookshelfShade);
  p.rect(x, y, 1, H, palette.bookshelfShade);
  p.rect(x + W - 1, y, 1, H, palette.bookshelfShade);
  // Inner highlight (frame inset)
  p.rect(x + 1, y + 1, W - 2, 1, '#7a4a25');
  // Slate surface (deep chalkboard green)
  p.rect(x + 2, y + 2, W - 4, H - 6, palette.wallTop);
  // Subtle gradient — slightly lighter near the top
  p.rect(x + 2, y + 2, W - 4, 2, palette.wallTopHighlight);
  // Chalk writing — horizontal scribble lines (faux equations)
  p.rect(x + 5, y + 6, 8, 1, palette.speechBg);
  p.put(x + 13, y + 6, palette.speechBg);
  p.rect(x + 5, y + 9, 6, 1, palette.speechBg);
  p.rect(x + 12, y + 9, 4, 1, palette.speechBg);
  p.rect(x + 5, y + 12, 12, 1, palette.speechBg);
  p.rect(x + 20, y + 6, 10, 1, palette.speechBg);
  p.put(x + 31, y + 6, palette.speechBg);
  p.rect(x + 20, y + 9, 6, 1, palette.speechBg);
  p.put(x + 28, y + 9, palette.speechBg);
  p.rect(x + 30, y + 9, 5, 1, palette.speechBg);
  p.rect(x + 20, y + 12, 14, 1, palette.speechBg);
  // Chalk tray (bottom shelf with chalk pieces + eraser)
  p.rect(x + 1, y + H - 5, W - 2, 3, palette.bookshelfShade);
  p.rect(x + 1, y + H - 5, W - 2, 1, '#7a4a25');
  // Chalk pieces — white sticks
  p.rect(x + 4, y + H - 4, 4, 1, palette.speechBg);
  p.rect(x + 14, y + H - 4, 3, 1, palette.speechBg);
  p.rect(x + 28, y + H - 4, 5, 1, palette.speechBg);
  // Eraser (felt)
  p.rect(x + 38, y + H - 4, 6, 2, palette.book2);
  p.rect(x + 38, y + H - 4, 6, 1, palette.book3);
  // Drop shadow
  p.rect(x - 1, y + H, W + 2, 1, palette.floorShadow);
}

/**
 * Blueprint table (construction) — wooden drafting table at an angle, with
 * a roll of blueprints unfurled on top. The "bookshelf-equivalent" walk
 * target for the construction scene's looking_up action.
 */
function drawBlueprintTable(palette: Palette, p: Px, x: number, y: number) {
  const W = 28;
  const H = 22;
  // Floor shadow
  p.rect(x, y + H, W, 1, palette.floorShadow);
  // Front legs
  p.rect(x + 2, y + 10, 2, H - 10, palette.desk);
  p.rect(x + W - 4, y + 10, 2, H - 10, palette.desk);
  p.put(x + 2, y + 10, palette.deskShade);
  p.put(x + W - 4, y + 10, palette.deskShade);
  // Tabletop — slightly tilted (drafting angle suggested by 2-pixel ramp)
  p.rect(x + 1, y + 8, W - 2, 3, palette.deskTop);
  p.rect(x + 1, y + 8, W - 2, 1, palette.deskTopHi);
  p.rect(x + 1, y + 10, W - 2, 1, palette.deskShade);
  // Unrolled blueprint (cyan/blue with white grid lines + red ink)
  p.rect(x + 4, y + 3, W - 8, 6, palette.monitorScreen);
  // Highlight along top of paper
  p.rect(x + 4, y + 3, W - 8, 1, palette.monitorScreenLit);
  // White grid lines
  for (let gx = x + 6; gx < x + W - 4; gx += 4) {
    p.rect(gx, y + 4, 1, 4, palette.cloud);
  }
  for (let gy = y + 5; gy < y + 9; gy += 2) {
    p.rect(x + 5, gy, W - 10, 1, palette.cloud);
  }
  // Red drafted ink (key marks)
  p.put(x + 8, y + 5, palette.accent);
  p.rect(x + 12, y + 6, 4, 1, palette.accent);
  p.put(x + 18, y + 7, palette.accent);
  // Curled corners of paper
  p.put(x + 4, y + 3, palette.paperShade);
  p.put(x + W - 5, y + 3, palette.paperShade);
  // Roll of blueprints to the side
  p.rect(x + W - 4, y + 6, 3, 2, palette.monitorScreen);
  p.rect(x + W - 4, y + 6, 3, 1, palette.monitorScreenLit);
}

/**
 * Fume hood (lab) — stainless-steel ventilation enclosure with a sash that
 * slides up. Inside: a flask + apparatus. Pure decoration — workers don't
 * walk to it (the lab bench is the primary workstation).
 */
function drawFumeHood(palette: Palette, p: Px, x: number, y: number) {
  const W = 28;
  const H = 30;
  // Floor shadow
  p.rect(x, y + H, W, 1, palette.floorShadow);
  // Stainless steel cabinet body
  p.rect(x, y, W, H, palette.wallLower);
  // Top hood with vent grille (darker)
  p.rect(x, y, W, 4, palette.coffeeBody);
  // Vent slats
  for (let vx = x + 2; vx < x + W - 2; vx += 3) {
    p.rect(vx, y + 1, 1, 2, palette.coffeeBodyHi);
  }
  // Sash window frame
  p.rect(x + 1, y + 4, W - 2, 1, palette.outline);
  p.rect(x + 1, y + 4, 1, H - 12, palette.outline);
  p.rect(x + W - 2, y + 4, 1, H - 12, palette.outline);
  p.rect(x + 1, y + H - 8, W - 2, 1, palette.outline);
  // Glass interior (subtle tint)
  p.rect(x + 2, y + 5, W - 4, H - 13, palette.sky);
  // Reflection slash on glass
  p.rect(x + 4, y + 7, 8, 1, palette.cloud);
  // Apparatus inside: ring stand + flask
  // Stand base
  p.rect(x + 6, y + H - 11, 8, 1, palette.outline);
  // Vertical rod
  p.rect(x + 9, y + 8, 1, H - 19, palette.outline);
  // Ring at top of rod
  p.rect(x + 7, y + 9, 5, 1, palette.outline);
  // Flask sitting on the ring (round-bottom, teal liquid)
  p.rect(x + 7, y + 10, 5, 4, palette.accent);
  p.rect(x + 8, y + 9, 3, 1, palette.cloud);
  p.put(x + 9, y + 8, palette.cloud);
  // Lower cabinet section (storage)
  p.rect(x + 1, y + H - 7, W - 2, 6, palette.desk);
  p.rect(x + 1, y + H - 7, W - 2, 1, palette.deskTopHi);
  // Cabinet door split
  p.rect(x + W / 2, y + H - 7, 1, 6, palette.deskShade);
  // Door handles
  p.put(x + 6, y + H - 4, palette.coffeeBodyHi);
  p.put(x + W - 7, y + H - 4, palette.coffeeBodyHi);
  // Hood label
  p.rect(x + 8, y + 1, 4, 2, palette.accent);
}

/**
 * Scaffolding (construction) — vertical poles + horizontal cross-bars
 * forming a 2D pixel-art rendering of a scaffold tower. Has a wooden
 * platform plank near the top. Pure decoration.
 */
function drawScaffolding(palette: Palette, p: Px, x: number, y: number) {
  const W = 32;
  const H = 36;
  // Floor shadow
  p.rect(x, y + H, W, 1, palette.floorShadow);
  // Vertical poles (3 of them, evenly spaced)
  const poleXs = [x + 2, x + W / 2 - 1, x + W - 3];
  for (const px of poleXs) {
    p.rect(px, y, 2, H, palette.coffeeBody);
    // Lit edge on left
    p.rect(px, y, 1, H, palette.coffeeBodyHi);
  }
  // Horizontal cross-bars (4 levels)
  const barYs = [y + 4, y + 14, y + 24, y + H - 2];
  for (const by of barYs) {
    p.rect(x + 2, by, W - 4, 2, palette.coffeeBody);
    p.rect(x + 2, by, W - 4, 1, palette.coffeeBodyHi);
  }
  // Wooden platform plank at the second-highest cross-bar level
  p.rect(x + 3, y + 13, W - 6, 2, palette.deskTop);
  p.rect(x + 3, y + 13, W - 6, 1, palette.deskTopHi);
  p.rect(x + 3, y + 14, W - 6, 1, palette.deskShade);
  // Diagonal brace (lower-left)
  for (let i = 0; i < 10; i++) {
    p.put(x + 3 + i, y + 24 - i, palette.coffeeBody);
  }
  // Diagonal brace (lower-right, mirrored)
  for (let i = 0; i < 10; i++) {
    p.put(x + W - 4 - i, y + 24 - i, palette.coffeeBody);
  }
  // Yellow caution stripe on top of platform (safety paint)
  p.rect(x + 4, y + 13, W - 8, 1, palette.accent);
  // Hard hat hung on the top bar (small orange dome)
  p.rect(x + W / 2 - 2, y + 1, 4, 2, palette.accent);
  p.put(x + W / 2 - 3, y + 2, palette.accentShade);
  p.put(x + W / 2 + 2, y + 2, palette.accentShade);
}

/**
 * Lockers (school) — three vertical lockers in a row. Each has a door
 * vent + handle. Common school hallway feature.
 */
function drawLockers(palette: Palette, p: Px, x: number, y: number) {
  const lockerW = 10;
  const H = 28;
  const count = 3;
  for (let i = 0; i < count; i++) {
    const lx = x + i * lockerW;
    // Locker body (metal blue or grey — uses bookshelfBody as the metal tone)
    p.rect(lx, y, lockerW, H, palette.bookshelfBody);
    // Door frame
    p.rect(lx, y, 1, H, palette.bookshelfShade);
    p.rect(lx + lockerW - 1, y, 1, H, palette.bookshelfShade);
    p.rect(lx, y, lockerW, 1, palette.bookshelfShade);
    p.rect(lx, y + H - 1, lockerW, 1, palette.bookshelfShade);
    // Top highlight
    p.rect(lx + 1, y + 1, lockerW - 2, 1, '#7a4a25');
    // Vents at the top of each door (4 horizontal slits)
    for (let v = 0; v < 4; v++) {
      p.rect(lx + 2, y + 3 + v * 2, lockerW - 4, 1, palette.bookshelfShade);
    }
    // Number plate (small white rectangle with a digit)
    p.rect(lx + 3, y + 13, lockerW - 6, 3, palette.paper);
    p.put(lx + 4, y + 14, palette.outline);
    p.put(lx + lockerW - 5, y + 14, palette.outline);
    // Combination dial
    p.rect(lx + lockerW / 2 - 1, y + 19, 2, 2, palette.outline);
    p.put(lx + lockerW / 2, y + 19, palette.cloud);
    // Door handle
    p.rect(lx + 2, y + H - 6, 2, 2, palette.coffeeBodyHi);
  }
  // Drop shadow
  p.rect(x, y + H, lockerW * count, 1, palette.floorShadow);
}

/**
 * Whiteboard (modern) — large rectangular white board with a slim dark
 * frame, marker-stroke scribbles, and a tray of dry-erase markers at the
 * bottom. Reads as the "modern office" answer to a chalkboard.
 */
function drawWhiteboard(palette: Palette, p: Px, x: number, y: number) {
  const W = 44;
  const H = 24;
  // Frame
  p.rect(x, y, W, H, palette.monitorFrame);
  // Inner highlight
  p.rect(x + 1, y + 1, W - 2, 1, palette.monitorFrameHi);
  // White surface
  p.rect(x + 2, y + 2, W - 4, H - 7, palette.cloud);
  // Marker doodles — colored lines
  p.rect(x + 5, y + 5, 8, 1, palette.accent);
  p.put(x + 13, y + 4, palette.accent);
  p.put(x + 14, y + 5, palette.accent);
  p.rect(x + 5, y + 8, 12, 1, '#1a4a7a'); // blue line
  p.put(x + 18, y + 7, '#1a4a7a');
  p.rect(x + 5, y + 11, 6, 1, palette.outline); // black line
  p.rect(x + 22, y + 5, 10, 1, '#1a4a7a');
  p.rect(x + 22, y + 8, 7, 1, palette.accent);
  p.rect(x + 22, y + 11, 12, 1, palette.outline);
  // A small box diagram
  p.rect(x + 36, y + 5, 6, 5, palette.cloud);
  p.rect(x + 36, y + 5, 6, 1, palette.outline);
  p.rect(x + 36, y + 9, 6, 1, palette.outline);
  p.rect(x + 36, y + 5, 1, 5, palette.outline);
  p.rect(x + 41, y + 5, 1, 5, palette.outline);
  // Marker tray
  p.rect(x + 1, y + H - 5, W - 2, 3, palette.wallLowerShade);
  p.rect(x + 1, y + H - 5, W - 2, 1, palette.monitorFrameHi);
  // Markers (3 colored caps)
  p.rect(x + 5, y + H - 4, 5, 1, palette.accent); // red
  p.put(x + 10, y + H - 4, palette.outline);
  p.rect(x + 16, y + H - 4, 5, 1, '#1a4a7a'); // blue
  p.put(x + 21, y + H - 4, palette.outline);
  p.rect(x + 27, y + H - 4, 5, 1, palette.outline); // black
  // Drop shadow
  p.rect(x - 1, y + H, W + 2, 1, palette.floorShadow);
}

/**
 * Filing cabinet (modern) — vertical steel cabinet with 3-4 drawers,
 * each with a recessed handle and a small label slot.
 */
function drawFilingCabinet(palette: Palette, p: Px, x: number, y: number) {
  const W = 20;
  const H = 32;
  // Cabinet body — grey/silver
  p.rect(x, y, W, H, palette.bookshelfBody);
  // Top + side highlight
  p.rect(x, y, W, 1, palette.wallLowerShade);
  p.rect(x, y, 1, H, palette.wallLowerShade);
  // Bottom + right shade
  p.rect(x, y + H - 1, W, 1, palette.bookshelfShade);
  p.rect(x + W - 1, y, 1, H, palette.bookshelfShade);
  // 4 drawers
  for (let d = 0; d < 4; d++) {
    const dy = y + 2 + d * 7;
    // Drawer face
    p.rect(x + 2, dy, W - 4, 6, palette.wallLowerShade);
    // Top edge highlight
    p.rect(x + 2, dy, W - 4, 1, palette.wallLower);
    // Bottom seam
    p.rect(x + 2, dy + 6, W - 4, 1, palette.bookshelfShade);
    // Label slot
    p.rect(x + 4, dy + 1, W - 8, 2, palette.paper);
    p.rect(x + 5, dy + 2, W - 10, 1, palette.outline);
    // Drawer handle (slim horizontal pull)
    p.rect(x + (W - 6) / 2 + 2, dy + 4, 4, 1, palette.outline);
  }
  // Drop shadow
  p.rect(x, y + H, W + 1, 1, palette.floorShadow);
}

/**
 * World map (school) — wall-mounted map showing rough continents in
 * green on a blue ocean, with a thin wood frame. Stardew-classroom feature.
 */
function drawWorldMap(palette: Palette, p: Px, x: number, y: number) {
  const W = 36;
  const H = 22;
  // Frame
  p.rect(x, y, W, H, palette.bookshelfBody);
  p.rect(x + 1, y + 1, W - 2, H - 2, palette.bookshelfShade);
  // Ocean background
  p.rect(x + 2, y + 2, W - 4, H - 4, palette.sky);
  // Land masses — pixel-art continents (loose silhouettes)
  // Top-left: North America-ish
  p.rect(x + 4, y + 4, 5, 4, palette.plantLeaf);
  p.put(x + 3, y + 5, palette.plantLeaf);
  p.put(x + 9, y + 5, palette.plantLeaf);
  // Below it: South America-ish
  p.rect(x + 7, y + 9, 3, 4, palette.plantLeaf);
  p.put(x + 7, y + 13, palette.plantLeaf);
  // Eurasia (long horizontal mass)
  p.rect(x + 14, y + 4, 14, 4, palette.plantLeaf);
  p.rect(x + 16, y + 8, 8, 2, palette.plantLeaf);
  p.put(x + 28, y + 4, palette.plantLeaf);
  // Africa (cone shape)
  p.rect(x + 17, y + 10, 4, 5, palette.plantLeaf);
  p.put(x + 18, y + 15, palette.plantLeaf);
  // Australia
  p.rect(x + 26, y + 13, 4, 3, palette.plantLeaf);
  // Latitude lines (cream)
  p.rect(x + 2, y + 9, W - 4, 1, palette.paper);
  // Equator
  p.rect(x + 2, y + (H >> 1), W - 4, 1, palette.accent);
  // Tack at top
  p.put(x + W / 2, y + 1, palette.accent);
  // Drop shadow
  p.rect(x, y + H, W, 1, palette.floorShadow);
}

/**
 * Periodic table poster (lab) — laminated wall poster showing a
 * stylized grid of element boxes. Just dense enough to read as "science
 * classroom" at thumbnail scale.
 */
function drawPeriodicTable(palette: Palette, p: Px, x: number, y: number) {
  const W = 38;
  const H = 22;
  // Frame
  p.rect(x, y, W, H, palette.outline);
  p.rect(x + 1, y + 1, W - 2, H - 2, palette.cloud);
  // Title bar
  p.rect(x + 2, y + 2, W - 4, 2, palette.accentShade);
  // Tiny "PERIODIC TABLE" pseudo-text — alternating pixels suggest a title
  for (let tx = x + 4; tx < x + W - 4; tx += 2) {
    p.put(tx, y + 2, palette.cloud);
  }
  // Grid of element boxes — 9 cols × 5 rows of 3x3 cells
  const cols = 9;
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bx = x + 3 + c * 3.5;
      const by = y + 6 + r * 3;
      // Skip a few to suggest the natural gaps in the table
      if (r === 0 && c > 0 && c < 8) continue;
      if (r === 1 && c > 1 && c < 6) continue;
      // Color-code rows by group
      const tone = [
        palette.accentHi,
        palette.accent,
        palette.plantLeaf,
        palette.sky,
        palette.book4,
      ][r];
      p.rect(Math.floor(bx), Math.floor(by), 3, 2, tone);
      // Tiny dot for the element symbol
      p.put(Math.floor(bx) + 1, Math.floor(by), palette.outline);
    }
  }
  // Drop shadow
  p.rect(x, y + H, W, 1, palette.floorShadow);
}

/**
 * Safety eye-wash station (lab) — bright yellow wall-mounted unit with
 * twin nozzles and the universal "EMERGENCY EYE WASH" sign. Tiny but
 * iconic — pure decoration.
 */
function drawEyeWash(palette: Palette, p: Px, x: number, y: number) {
  const W = 16;
  const H = 20;
  // Mounting plate (yellow)
  p.rect(x, y, W, H, palette.accent);
  // Border
  p.rect(x, y, W, 1, palette.accentShade);
  p.rect(x, y + H - 1, W, 1, palette.accentShade);
  p.rect(x, y, 1, H, palette.accentShade);
  p.rect(x + W - 1, y, 1, H, palette.accentShade);
  // Top highlight
  p.rect(x + 1, y + 1, W - 2, 1, palette.accentHi);
  // Eye-wash bowl/cup base (stainless)
  p.rect(x + 2, y + 6, W - 4, 4, palette.wallLower);
  p.rect(x + 2, y + 6, W - 4, 1, palette.cloud);
  // Twin nozzles aiming upward into the bowl
  p.rect(x + 4, y + 4, 2, 2, palette.outline);
  p.rect(x + W - 6, y + 4, 2, 2, palette.outline);
  p.put(x + 4, y + 3, palette.accentHi);
  p.put(x + W - 5, y + 3, palette.accentHi);
  // "EW" label band at the bottom
  p.rect(x + 1, y + 12, W - 2, 4, palette.outline);
  // Faux text (alternating pixels)
  for (let tx = x + 3; tx < x + W - 3; tx += 2) {
    p.put(tx, y + 14, palette.accentHi);
  }
  // Drop shadow
  p.rect(x, y + H, W, 1, palette.floorShadow);
}

/**
 * Water cooler (construction) — tall blue 5-gallon jug on a white
 * dispenser base with a blue tap, plus a small paper-cup dispenser on
 * the side. Coffee-equivalent walk target for construction sites.
 */
function drawWaterCooler(palette: Palette, p: Px, x: number, y: number) {
  const W = 14;
  const H = 22;
  // Drop shadow
  p.rect(x - 1, y + H, W + 2, 1, palette.floorShadow);
  // Dispenser base (white)
  p.rect(x, y + 9, W, 12, palette.cloud);
  p.rect(x, y + 9, W, 1, palette.wallLower);
  p.rect(x, y + 20, W, 1, palette.wallLowerShade);
  // Side highlights/shadows
  p.rect(x, y + 9, 1, 12, palette.wallLowerShade);
  p.rect(x + W - 1, y + 9, 1, 12, palette.outline);
  // Tap (blue handle + spout)
  p.rect(x + W / 2 - 1, y + 14, 2, 2, palette.monitorScreen);
  p.put(x + W / 2 - 2, y + 14, palette.outline);
  p.put(x + W / 2 + 1, y + 14, palette.outline);
  // Drip pan
  p.rect(x + 2, y + 18, W - 4, 1, palette.outline);
  // Water jug (translucent blue, neck on top)
  p.rect(x + 2, y + 2, W - 4, 8, palette.sky);
  p.rect(x + 2, y + 2, W - 4, 1, palette.cloud);
  // Water level highlight
  p.rect(x + 3, y + 3, W - 7, 1, palette.skyHi);
  // Jug neck
  p.rect(x + (W - 4) / 2, y + 1, 4, 2, palette.cloud);
  p.rect(x + (W - 6) / 2 + 1, y, 4, 1, palette.outline);
  // Air bubble in jug
  p.put(x + W / 2, y + 5, palette.cloud);
  // Paper-cup dispenser stuck to the side
  p.rect(x + W, y + 11, 2, 7, palette.cloud);
  p.rect(x + W, y + 11, 2, 1, palette.outline);
  p.put(x + W, y + 13, palette.outline);
  p.put(x + W + 1, y + 14, palette.outline);
}

/**
 * Beaker rack (lab) — a wire rack with 6 round-bottom beakers in two
 * rows, each holding different-colored solutions. Coffee-equivalent
 * walk target for the lab (the "break beaker" station).
 */
function drawBeakerRack(palette: Palette, p: Px, x: number, y: number) {
  const W = 24;
  const H = 18;
  // Drop shadow
  p.rect(x - 1, y + H, W + 2, 1, palette.floorShadow);
  // Rack frame (3 horizontal wire bars at top/middle/bottom)
  p.rect(x, y, W, 1, palette.outline);
  p.rect(x, y + H / 2 - 1, W, 1, palette.outline);
  p.rect(x, y + H - 1, W, 1, palette.outline);
  // Side verticals
  p.rect(x, y, 1, H, palette.outline);
  p.rect(x + W - 1, y, 1, H, palette.outline);
  // 3 beakers top row (different colored solutions)
  const colors = [palette.accent, palette.plantLeaf, palette.book2];
  for (let i = 0; i < 3; i++) {
    const bx = x + 2 + i * 7;
    const by = y + 1;
    // Beaker outline (cylinder shape)
    p.rect(bx, by, 5, 6, palette.cloud);
    p.put(bx, by, palette.outline);
    p.put(bx + 4, by, palette.outline);
    p.rect(bx, by + 6, 5, 1, palette.outline);
    // Liquid inside
    p.rect(bx + 1, by + 2, 3, 4, colors[i]);
    // Surface highlight
    p.put(bx + 1, by + 2, palette.cloud);
  }
  // 3 smaller test tubes bottom row
  const colors2 = [palette.book4, palette.book5, palette.accentHi];
  for (let i = 0; i < 3; i++) {
    const bx = x + 3 + i * 7;
    const by = y + H / 2;
    // Tube outline
    p.rect(bx, by, 3, 7, palette.cloud);
    p.put(bx, by, palette.outline);
    p.put(bx + 2, by, palette.outline);
    p.rect(bx, by + 7, 3, 1, palette.outline);
    // Solution
    p.rect(bx + 1, by + 3, 1, 4, colors2[i]);
    // Surface highlight on rim
    p.put(bx + 1, by + 1, palette.cloud);
  }
}

/* ---------------- Desk / workstation per theme ---------------- */
/**
 * Workstation sprite — 28×26 baked texture. Width/height is identical across
 * themes so the worker placement math (sitX/sitY) and walk targets don't
 * need scene-awareness. Each theme paints the same footprint with a wildly
 * different workstation: a coding desk + monitor in cozy, an L-desk + thin
 * monitor in modern, a wood student desk + notebook in school, a white lab
 * bench + beakers in lab, a sawhorse + plank workbench in construction.
 */
export function makeDeskTexture(
  palette: Palette,
  themeKind: SceneOutfit['kind'] = 'cozy',
  typing = false,
): Texture {
  const w = 28;
  const h = 26;
  const p = newPx(w, h);
  switch (themeKind) {
    case 'modern':
      drawDeskModern(palette, p, typing);
      break;
    case 'school':
      drawDeskSchool(palette, p);
      break;
    case 'lab':
      drawDeskLab(palette, p);
      break;
    case 'construction':
      drawDeskConstruction(palette, p);
      break;
    case 'cozy':
    default:
      drawDeskCozy(palette, p, typing);
      break;
  }
  return makeTex(p.canvas);
}

/** Cozy office: warm wood desk + CRT-ish monitor + keyboard + mug + paper. */
function drawDeskCozy(palette: Palette, p: Px, typing: boolean) {
  // Floor shadow
  p.rect(2, 24, 24, 2, palette.floorShadow);
  // Desk top
  p.rect(2, 14, 24, 4, palette.deskTop);
  p.rect(2, 14, 24, 1, palette.deskTopHi);
  p.rect(2, 17, 24, 1, palette.deskShade);
  // Desk skirt
  p.rect(2, 18, 24, 6, palette.desk);
  p.rect(2, 18, 1, 6, palette.deskShade);
  p.rect(25, 18, 1, 6, palette.deskShade);
  p.rect(5, 20, 8, 1, palette.deskShade);
  p.rect(15, 20, 8, 1, palette.deskShade);
  // Keyboard
  p.rect(7, 13, 14, 2, palette.keyboard);
  for (let kx = 8; kx < 21; kx += 2) p.put(kx, 13, palette.keyboardKey);
  // Mug
  p.rect(3, 11, 3, 3, palette.mug);
  p.rect(3, 11, 3, 1, palette.mugShade);
  p.put(6, 12, palette.mug);
  // Paper stack
  p.rect(22, 12, 4, 2, palette.paper);
  p.rect(22, 13, 4, 1, palette.paperShade);
  // Monitor
  p.rect(12, 11, 4, 2, palette.monitorFrameHi);
  p.rect(11, 12, 6, 1, palette.monitorFrame);
  p.rect(6, 2, 16, 9, palette.monitorFrame);
  p.rect(6, 2, 16, 1, palette.monitorFrameHi);
  const screen = typing ? palette.monitorScreenLit : palette.monitorScreen;
  p.rect(7, 3, 14, 7, screen);
  p.rect(8, 4, 5, 1, palette.monitorScreenText);
  p.rect(8, 6, 8, 1, palette.monitorScreenText);
  p.rect(8, 8, 6, 1, palette.monitorScreenText);
  p.rect(7, 3, 14, 1, palette.monitorScreenLit);
  p.put(20, 10, '#5fff80');
}

/**
 * Modern: light-grey L-desk + slim flat-panel monitor on an arm, a closed
 * laptop, a thermos. No bulky CRT — reads as 2020s corporate.
 */
function drawDeskModern(palette: Palette, p: Px, typing: boolean) {
  // Floor shadow
  p.rect(2, 24, 24, 2, palette.floorShadow);
  // Desk top (light grey, polished)
  p.rect(2, 14, 24, 3, palette.deskTop);
  p.rect(2, 14, 24, 1, palette.deskTopHi);
  p.rect(2, 16, 24, 1, palette.deskShade);
  // Slim metal trestle legs (instead of a closed skirt)
  p.rect(4, 17, 1, 7, palette.deskShade);
  p.rect(23, 17, 1, 7, palette.deskShade);
  p.rect(4, 23, 20, 1, palette.deskShade);
  // Cross brace (subtle)
  p.rect(13, 20, 2, 1, palette.deskShade);
  // Slim flat-panel monitor on an arm
  // Arm
  p.rect(13, 11, 2, 3, palette.monitorFrame);
  p.put(13, 10, palette.monitorFrame);
  // Bezel
  p.rect(7, 2, 14, 8, palette.monitorFrame);
  p.rect(7, 2, 14, 1, palette.monitorFrameHi);
  // Screen — much thinner bezel than cozy
  const screen = typing ? palette.monitorScreenLit : palette.monitorScreen;
  p.rect(8, 3, 12, 6, screen);
  // Window-chrome bar at top of screen (suggests an IDE/browser)
  p.rect(8, 3, 12, 1, palette.monitorFrameHi);
  p.put(9, 3, palette.coffeeRed);
  p.put(10, 3, palette.accent);
  p.put(11, 3, palette.accentHi);
  // Code-like lines (denser than cozy)
  p.rect(9, 5, 8, 1, palette.monitorScreenText);
  p.rect(9, 7, 5, 1, palette.monitorScreenText);
  p.rect(9, 8, 7, 1, palette.accentHi);
  // Closed laptop to the left of monitor
  p.rect(3, 13, 7, 1, palette.monitorFrame);
  p.rect(3, 12, 7, 1, palette.monitorFrameHi);
  p.put(6, 12, palette.accent); // small Apple-ish logo
  // Thermos / takeaway cup on the right
  p.rect(22, 10, 3, 4, palette.mug);
  p.rect(22, 10, 3, 1, palette.mugShade);
  p.put(22, 10, palette.cloud);
  // Power LED
  p.put(19, 9, '#5fff80');
}

/**
 * School: small wooden student desk with attached chair-back ridge. Open
 * notebook + apple sit on top. No monitor — this is an old-school desk.
 */
function drawDeskSchool(palette: Palette, p: Px) {
  // Floor shadow
  p.rect(2, 24, 24, 2, palette.floorShadow);
  // Desk top (light honey wood)
  p.rect(4, 14, 20, 4, palette.deskTop);
  p.rect(4, 14, 20, 1, palette.deskTopHi);
  p.rect(4, 17, 20, 1, palette.deskShade);
  // Open notebook with red margin
  p.rect(8, 12, 8, 2, palette.paper);
  p.rect(8, 13, 8, 1, palette.paperShade);
  p.put(9, 12, palette.accent); // red margin
  // Pencil / chalk
  p.rect(11, 11, 4, 1, palette.accentHi);
  p.put(15, 11, palette.outline); // pencil tip
  // Apple on the right (teacher's apple)
  p.rect(20, 11, 3, 3, palette.accent);
  p.rect(20, 11, 3, 1, palette.accentShade);
  p.put(21, 10, palette.plantLeaf); // leaf
  // Stack of books on the left
  p.rect(5, 12, 3, 1, palette.book1);
  p.rect(5, 11, 3, 1, palette.book2);
  p.put(7, 11, palette.book3);
  // Desk legs (wood)
  p.rect(5, 18, 2, 6, palette.desk);
  p.rect(21, 18, 2, 6, palette.desk);
  p.put(5, 18, palette.deskShade);
  p.put(22, 18, palette.deskShade);
  // Chair-back ridge sticking up behind the desk
  p.rect(13, 18, 2, 6, palette.desk);
  p.put(13, 18, palette.deskShade);
  // Side support bar
  p.rect(6, 22, 16, 1, palette.deskShade);
}

/**
 * Lab: white-topped lab bench with raised back-splash. Bunsen burner + a
 * tall flask + a stack of round beakers sit on top. Reads as "lab station"
 * at a glance.
 */
function drawDeskLab(palette: Palette, p: Px) {
  // Floor shadow
  p.rect(2, 24, 24, 2, palette.floorShadow);
  // Back-splash (vertical lip at the back of the bench)
  p.rect(2, 8, 24, 3, palette.deskShade);
  p.rect(2, 8, 24, 1, palette.deskTopHi);
  // Bench top (white laminate)
  p.rect(2, 11, 24, 4, palette.deskTop);
  p.rect(2, 11, 24, 1, palette.deskTopHi);
  p.rect(2, 14, 24, 1, palette.deskShade);
  // Cabinet skirt with two doors
  p.rect(2, 15, 24, 9, palette.desk);
  p.rect(2, 15, 1, 9, palette.deskShade);
  p.rect(25, 15, 1, 9, palette.deskShade);
  p.rect(13, 16, 1, 7, palette.deskShade); // door divider
  // Small handles on doors
  p.put(7, 18, palette.monitorFrameHi);
  p.put(19, 18, palette.monitorFrameHi);
  // Bunsen burner — small base + tube + faint blue flame
  p.rect(4, 8, 3, 3, palette.monitorFrame);
  p.put(5, 7, palette.monitorFrame);
  p.put(5, 6, palette.accent); // flame
  p.put(5, 5, palette.accentHi);
  // Tall flask in center (Erlenmeyer-ish)
  p.rect(12, 5, 4, 6, palette.accent);
  p.rect(12, 5, 4, 1, palette.accentShade); // shade at top
  p.rect(13, 4, 2, 1, palette.monitorFrame); // narrow neck
  p.put(14, 3, palette.monitorFrame); // stopper
  // Round flask (boiling flask) on right
  p.rect(19, 7, 4, 4, palette.accentHi);
  p.put(20, 6, palette.monitorFrame);
  p.put(21, 6, palette.monitorFrame);
  // Stack of small beakers/test tubes on left
  p.rect(7, 8, 2, 3, palette.cloud);
  p.put(7, 8, palette.accent); // colored liquid in one
  // Notebook on right
  p.rect(2, 12, 3, 2, palette.paper);
}

/**
 * Construction: sawhorse + plank workbench. Cross-braced sawhorse legs at
 * each end, a plywood plank top with visible nails, a hammer + nail pile
 * + a wrapped blueprint on top.
 */
function drawDeskConstruction(palette: Palette, p: Px) {
  // Floor shadow
  p.rect(2, 24, 24, 2, palette.floorShadow);
  // Plank top
  p.rect(2, 13, 24, 4, palette.deskTop);
  p.rect(2, 13, 24, 1, palette.deskTopHi);
  p.rect(2, 16, 24, 1, palette.deskShade);
  // Plank grain lines
  p.rect(3, 15, 22, 1, palette.deskShade);
  // Nails along plank edges
  p.put(5, 13, palette.outline);
  p.put(11, 13, palette.outline);
  p.put(17, 13, palette.outline);
  p.put(23, 13, palette.outline);
  // Left sawhorse (A-frame legs)
  p.rect(4, 17, 1, 7, palette.desk);
  p.rect(8, 17, 1, 7, palette.desk);
  p.rect(4, 17, 5, 1, palette.deskShade); // crossbar
  p.rect(5, 20, 3, 1, palette.deskShade);
  // Right sawhorse
  p.rect(19, 17, 1, 7, palette.desk);
  p.rect(23, 17, 1, 7, palette.desk);
  p.rect(19, 17, 5, 1, palette.deskShade);
  p.rect(20, 20, 3, 1, palette.deskShade);
  // Hammer on top of the plank
  p.rect(5, 11, 1, 2, palette.outline); // handle
  p.rect(4, 11, 3, 1, palette.outline); // head
  p.put(7, 11, palette.outline); // head tip
  // Nail pile (small cluster)
  p.put(10, 12, palette.monitorFrameHi);
  p.put(11, 12, palette.monitorFrameHi);
  p.put(12, 12, palette.monitorFrameHi);
  p.put(11, 11, palette.monitorFrameHi);
  // Rolled blueprint (cyan with brown band)
  p.rect(15, 10, 6, 3, palette.accentHi); // wait — accentHi is light yellow.
  // Blueprints are classically blue — use monitorScreen as the blueprint blue
  p.rect(15, 10, 6, 3, palette.monitorScreen);
  p.rect(15, 10, 6, 1, palette.monitorScreenLit);
  p.rect(15, 11, 1, 2, palette.outline);
  p.rect(20, 11, 1, 2, palette.outline);
  // Yellow caution stripe edge on the plank
  p.rect(2, 17, 24, 1, palette.accent);
}

/* ---------------- Worker character sprite sheet ----------------
 * Sheet layout: 7 rows (animation states) × 4 columns (frames).
 * Each frame is 16x24. Stardew-style chibi: big head, short body.
 * Three character variants differ in hair color + pants accent;
 * SHIRT is white, recolored per session via PixiJS sprite tint.
 */
export const FRAME_W = 16;
export const FRAME_H = 24;
export const SHEET_COLS = 4;
// Sheet rows: 0=idle 1=typing 2=bash 3=reading 4=writing 5=looking_up
// 6=waiting_approval 7=walking 8=drinking 9=thinking 10=holding_sign
export const SHEET_ROWS = 11;

export interface CharacterStyle {
  hair: string;
  hairShade: string;
  hairHi?: string;
  pants: string;
  pantsShade: string;
  skin: string;
  skinShade: string;
  skinHi?: string;
  hairStyle: 'short' | 'bob' | 'curly';
}

export const CHARACTER_STYLES: Record<string, CharacterStyle> = {
  brunette: {
    hair: '#3a2818',
    hairShade: '#1a1008',
    hairHi: '#5a4030',
    pants: '#3a4a6a',
    pantsShade: '#1f2840',
    skin: '#f0c898',
    skinShade: '#c08068',
    skinHi: '#ffe0c0',
    hairStyle: 'short',
  },
  ginger: {
    hair: '#c8541f',
    hairShade: '#7a2d10',
    hairHi: '#e88040',
    pants: '#5a3a20',
    pantsShade: '#3a2410',
    skin: '#f0c898',
    skinShade: '#c08068',
    skinHi: '#ffe0c0',
    hairStyle: 'curly',
  },
  blonde: {
    hair: '#e6c878',
    hairShade: '#a08840',
    hairHi: '#fff0a0',
    pants: '#2a5a3a',
    pantsShade: '#163020',
    skin: '#e8c098',
    skinShade: '#b08068',
    skinHi: '#fad8a8',
    hairStyle: 'bob',
  },
};

type Variant =
  | 'still'
  | 'bob'
  | 'arms_up'
  | 'arms_down'
  | 'look_l'
  | 'look_r'
  | 'wave'
  | 'walk_step_l'      // leg-forward, slight body tilt left
  | 'walk_step_r'      // leg-forward, slight body tilt right
  | 'sip_low'          // arms down, mug at chest
  | 'sip_high'         // mug at lips
  | 'think_a'          // hand-on-chin, head slight tilt
  | 'think_b'          // hand at side, head bob
  | 'sign_up'          // both arms up, holding bar
  | 'sign_up_bob';     // sign-up with bob

export function makeWorkerSheet(
  palette: Palette,
  style: CharacterStyle = CHARACTER_STYLES.brunette,
  outfit?: SceneOutfit,
): Texture {
  const w = FRAME_W * SHEET_COLS;
  const h = FRAME_H * SHEET_ROWS;
  const p = newPx(w, h);

  const draw = (ox: number, oy: number, v: Variant, row: number) => {
    const bob = (v === 'bob' || v === 'sign_up_bob' || v === 'walk_step_l' || v === 'think_b')
      ? 1
      : 0;
    const y = oy + bob;

    // Drop shadow at feet (ellipse)
    p.rect(ox + 4, oy + 21, 8, 1, palette.shadow);
    p.rect(ox + 5, oy + 22, 6, 1, palette.shadow);

    // ----- Head (12x9, centered) -----
    drawHairBack(p, ox + 3, y + 1, style);
    p.rect(ox + 4, y + 2, 8, 7, style.skin);
    p.rect(ox + 4, y + 8, 8, 1, style.skinShade);
    if (style.skinHi) {
      p.put(ox + 5, y + 6, style.skinHi);
      p.put(ox + 10, y + 6, style.skinHi);
    }
    drawHairFront(p, ox + 3, y + 1, style);
    // Scene-specific headwear (hardhat / lab goggles / school cap / business
    // headset) drawn over the hair. The body silhouette is untouched so the
    // FSM positioning / walk math doesn't need scene-awareness.
    if (outfit) drawHeadwear(palette, p, ox, y, outfit);
    const eyeY = y + 5;
    let elx = ox + 6, erx = ox + 9;
    if (v === 'look_l') { elx = ox + 5; erx = ox + 8; }
    if (v === 'look_r') { elx = ox + 7; erx = ox + 10; }
    if (v === 'think_a' || v === 'think_b') { elx = ox + 6; erx = ox + 9; } // straight ahead, focused
    p.put(elx, eyeY, '#ffffff');
    p.put(erx, eyeY, '#ffffff');
    p.put(elx, eyeY, palette.outline);
    p.put(erx, eyeY, palette.outline);
    // Mouth — small smile (or flat line for sip / sign)
    if (v === 'sip_high') {
      p.put(ox + 7, y + 7, palette.outline);
      p.put(ox + 8, y + 7, palette.outline);
    } else {
      p.put(ox + 7, y + 7, '#a05030');
      p.put(ox + 8, y + 7, '#a05030');
    }
    // Neck shadow
    p.rect(ox + 7, y + 9, 2, 1, style.skinShade);

    // ----- Body / shirt -----
    p.rect(ox + 4, y + 10, 8, 1, palette.shirtShade);
    p.rect(ox + 4, y + 11, 8, 5, palette.shirt);
    p.rect(ox + 4, y + 11, 1, 5, palette.shirtShade);
    p.rect(ox + 11, y + 11, 1, 5, palette.shirtShade);
    p.rect(ox + 5, y + 11, 6, 1, palette.shirtHi);
    // Scene-specific torso overlay (lab coat panel, hi-vis vest stripes,
    // school uniform collar, business tie). Drawn over the base shirt so
    // every scene gets a distinctive silhouette without changing the
    // 16x24 rig used by the walk/sit math.
    if (outfit) drawTorsoOverlay(palette, p, ox, y, outfit);

    // ----- Arms (variant-specific) -----
    if (v === 'arms_up' || v === 'wave') {
      p.rect(ox + 3, y + 11, 1, 3, palette.shirt);
      p.rect(ox + 12, y + 9, 1, 4, palette.shirt);
      p.put(ox + 12, y + 8, style.skin);
      p.put(ox + 3, y + 14, style.skin);
      p.put(ox + 12, y + 14, style.skin);
    } else if (v === 'arms_down') {
      p.rect(ox + 3, y + 12, 1, 4, palette.shirt);
      p.rect(ox + 12, y + 12, 1, 4, palette.shirt);
      p.put(ox + 3, y + 14, style.skin);
      p.put(ox + 12, y + 14, style.skin);
    } else if (v === 'walk_step_l' || v === 'walk_step_r') {
      // Mid-stride: one arm swings forward, the other back. Slight body tilt
      // implied by the bob; sprite still faces forward (left/right is done
      // via horizontal flip in the renderer).
      const fwdHi = v === 'walk_step_l' ? ox + 3 : ox + 12;
      const fwdLo = v === 'walk_step_l' ? ox + 12 : ox + 3;
      p.rect(fwdHi, y + 11, 1, 3, palette.shirt);
      p.rect(fwdLo, y + 13, 1, 3, palette.shirt);
      p.put(fwdHi, y + 14, style.skin);
      p.put(fwdLo, y + 16, style.skin);
    } else if (v === 'sip_low') {
      // Both forearms forward, hands curl around an invisible mug at chest
      p.rect(ox + 3, y + 12, 1, 3, palette.shirt);
      p.rect(ox + 12, y + 12, 1, 3, palette.shirt);
      p.put(ox + 4, y + 14, style.skin);
      p.put(ox + 11, y + 14, style.skin);
      // Mug between hands (small cup, dark red)
      p.rect(ox + 6, y + 13, 4, 3, palette.mug);
      p.rect(ox + 6, y + 13, 4, 1, palette.mugShade);
      p.put(ox + 10, y + 14, palette.mug); // handle
      // Steam
      p.put(ox + 7, y + 11, '#ffffff');
      p.put(ox + 8, y + 10, '#ffffff');
    } else if (v === 'sip_high') {
      // Hands raised so the mug is at lips
      p.rect(ox + 4, y + 9, 1, 3, palette.shirt);
      p.rect(ox + 11, y + 9, 1, 3, palette.shirt);
      p.put(ox + 5, y + 9, style.skin);
      p.put(ox + 10, y + 9, style.skin);
      // Mug at face
      p.rect(ox + 6, y + 7, 4, 3, palette.mug);
      p.rect(ox + 6, y + 7, 4, 1, palette.mugShade);
      p.put(ox + 10, y + 8, palette.mug);
      // Steam (extra puff)
      p.put(ox + 7, y + 5, '#ffffff');
      p.put(ox + 8, y + 4, '#ffffff');
      p.put(ox + 6, y + 3, '#ffffff');
    } else if (v === 'think_a' || v === 'think_b') {
      // One hand resting at chin (right side)
      p.rect(ox + 3, y + 12, 1, 4, palette.shirt);
      p.put(ox + 3, y + 14, style.skin);
      // Right arm bent up to chin
      p.rect(ox + 12, y + 11, 1, 2, palette.shirt);
      p.put(ox + 11, y + 9, style.skin);
      p.put(ox + 11, y + 10, style.skin);
    } else if (v === 'sign_up' || v === 'sign_up_bob') {
      // Both arms raised, palms forward, holding a horizontal bar (the sign
      // overlay sprite is rendered above their head separately).
      p.rect(ox + 3, y + 8, 1, 5, palette.shirt);
      p.rect(ox + 12, y + 8, 1, 5, palette.shirt);
      p.put(ox + 3, y + 7, style.skin);
      p.put(ox + 12, y + 7, style.skin);
      // Faint hand-grip dots
      p.put(ox + 3, y + 8, palette.outlineSoft);
      p.put(ox + 12, y + 8, palette.outlineSoft);
    } else {
      // 'still', 'bob', 'look_l', 'look_r' — sitting arms forward at desk.
      p.rect(ox + 3, y + 12, 1, 3, palette.shirt);
      p.rect(ox + 12, y + 12, 1, 3, palette.shirt);
      p.put(ox + 3, y + 14, style.skin);
      p.put(ox + 12, y + 14, style.skin);
    }

    // Scene-specific hand prop drawn AFTER arms so it sits in the worker's
    // hand. Routed by (row, variant) so each action gets a contextual prop:
    // pipette in lab's typing row, chalk in school's, hammer in
    // construction's, etc. Pure additive — no FSM changes.
    if (outfit) drawActionProp(palette, p, ox, y, v, row, outfit);

    // ----- Pants / legs -----
    if (v === 'walk_step_l' || v === 'walk_step_r') {
      // Mid-stride: shift one leg forward, one back. The "back" leg stays
      // mostly vertical; the "forward" leg crosses slightly inward.
      const fwdX = v === 'walk_step_l' ? ox + 4 : ox + 9;
      const backX = v === 'walk_step_l' ? ox + 9 : ox + 4;
      p.rect(ox + 5, y + 16, 6, 4, style.pants);
      p.rect(fwdX, y + 16, 3, 4, style.pants);
      p.rect(fwdX, y + 16, 1, 4, style.pantsShade);
      p.rect(backX, y + 16, 3, 4, style.pants);
      p.rect(backX + 2, y + 16, 1, 4, style.pantsShade);
      // Shoes — forward shoe slightly forward of the body
      p.rect(fwdX - 1, y + 20, 3, 1, palette.shoe);
      p.rect(backX + 1, y + 20, 3, 1, palette.shoe);
    } else {
      p.rect(ox + 5, y + 16, 6, 4, style.pants);
      p.rect(ox + 5, y + 16, 1, 4, style.pantsShade);
      p.rect(ox + 7, y + 16, 1, 4, style.pantsShade);
      p.rect(ox + 10, y + 16, 1, 4, style.pantsShade);
      p.rect(ox + 4, y + 20, 3, 1, palette.shoe);
      p.rect(ox + 9, y + 20, 3, 1, palette.shoe);
    }
  };

  const variants: Variant[][] = [
    ['still', 'bob', 'still', 'bob'],                              // 0 idle
    ['arms_down', 'arms_up', 'arms_down', 'arms_up'],              // 1 typing
    ['still', 'arms_up', 'still', 'arms_down'],                    // 2 bash
    ['look_l', 'look_l', 'look_r', 'look_r'],                      // 3 reading
    ['arms_down', 'arms_up', 'arms_down', 'arms_up'],              // 4 writing
    ['look_r', 'still', 'look_l', 'still'],                        // 5 looking_up
    ['wave', 'wave', 'bob', 'wave'],                               // 6 waiting_approval
    ['walk_step_l', 'still', 'walk_step_r', 'still'],              // 7 walking
    ['sip_low', 'sip_high', 'sip_low', 'sip_low'],                 // 8 drinking
    ['think_a', 'think_b', 'think_a', 'think_b'],                  // 9 thinking
    ['sign_up', 'sign_up_bob', 'sign_up', 'sign_up_bob'],          // 10 holding_sign
  ];

  for (let r = 0; r < SHEET_ROWS; r++) {
    for (let c = 0; c < SHEET_COLS; c++) {
      draw(c * FRAME_W, r * FRAME_H, variants[r][c], r);
    }
  }

  return makeTex(p.canvas);
}

function drawHairBack(p: Px, x: number, y: number, s: CharacterStyle) {
  // Back-of-head silhouette behind the face.
  p.rect(x + 1, y, 10, 4, s.hair);
  p.rect(x + 1, y, 1, 6, s.hair);
  p.rect(x + 10, y, 1, 6, s.hair);
  p.rect(x, y + 1, 1, 5, s.hairShade);
  p.rect(x + 11, y + 1, 1, 5, s.hairShade);
}

function drawHairFront(p: Px, x: number, y: number, s: CharacterStyle) {
  // Forehead-side bangs / fringe depending on style.
  if (s.hairStyle === 'short') {
    p.rect(x + 1, y, 10, 2, s.hair);
    p.put(x + 3, y + 2, s.hair);
    p.put(x + 8, y + 2, s.hair);
    if (s.hairHi) p.put(x + 5, y, s.hairHi);
  } else if (s.hairStyle === 'bob') {
    p.rect(x + 1, y, 10, 3, s.hair);
    p.rect(x + 1, y + 3, 1, 4, s.hair);
    p.rect(x + 10, y + 3, 1, 4, s.hair);
    if (s.hairHi) {
      p.rect(x + 4, y, 4, 1, s.hairHi);
    }
  } else {
    // curly
    p.rect(x + 1, y, 10, 2, s.hair);
    // bumps for curls
    p.put(x + 1, y - 1, s.hair);
    p.put(x + 4, y - 1, s.hair);
    p.put(x + 7, y - 1, s.hair);
    p.put(x + 10, y - 1, s.hair);
    p.put(x + 3, y + 2, s.hair);
    p.put(x + 8, y + 2, s.hair);
    if (s.hairHi) {
      p.put(x + 5, y, s.hairHi);
      p.put(x + 6, y - 1, s.hairHi);
    }
  }
}

export function frameRect(row: number, col: number): Rectangle {
  return new Rectangle(col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H);
}

/**
 * Scene-specific headwear, drawn over the hair. `y` is the head's top
 * (already includes the per-frame bob offset).
 *
 * The 16x24 silhouette is preserved — headwear only paints into the top
 * 4-5 rows of the head area, which the walk/sit math doesn't read.
 */
function drawHeadwear(palette: Palette, p: Px, ox: number, y: number, outfit: SceneOutfit) {
  switch (outfit.kind) {
    case 'modern': {
      // Slim wireless headset (band across the head + a small earpiece).
      // Subtle so the modern-office worker reads as "on a call" at a glance.
      p.rect(ox + 4, y, 8, 1, palette.outline);
      p.put(ox + 3, y + 2, palette.outline);
      p.put(ox + 3, y + 3, palette.outline);
      p.put(ox + 12, y + 2, palette.accent); // mic dot
      break;
    }
    case 'school': {
      // School cap — flat-top with a small bill.
      p.rect(ox + 3, y - 1, 10, 2, palette.accent);
      p.rect(ox + 3, y - 1, 10, 1, palette.accentHi);
      p.rect(ox + 3, y + 1, 10, 1, palette.accentShade);
      // Bill jutting forward over the brow
      p.rect(ox + 4, y + 2, 9, 1, palette.outline);
      break;
    }
    case 'lab': {
      // Lab-tech: safety goggles pushed up on the forehead.
      p.rect(ox + 4, y + 1, 8, 1, palette.outline);
      p.rect(ox + 5, y + 2, 2, 1, palette.accent);
      p.rect(ox + 9, y + 2, 2, 1, palette.accent);
      p.put(ox + 7, y + 2, palette.outline); // strap notch
      p.put(ox + 8, y + 2, palette.outline);
      break;
    }
    case 'construction': {
      // Hardhat — rounded crown + brim, in the scene's safety-orange accent.
      p.rect(ox + 3, y, 10, 1, palette.accent);
      p.rect(ox + 4, y - 1, 8, 1, palette.accentHi);
      p.rect(ox + 3, y + 1, 10, 2, palette.accent);
      p.rect(ox + 2, y + 3, 12, 1, palette.accentShade); // brim
      // 1-px crown highlight
      p.put(ox + 5, y - 1, palette.accentHi);
      break;
    }
    case 'cozy':
    default:
      // No headwear; the brunette/ginger/blonde hair carries the look.
      break;
  }
}

/**
 * Scene-specific torso overlay drawn on top of the base shirt. Adds a small
 * but recognizable per-scene marker (tie, lab-coat lapel, hi-vis stripe,
 * school-uniform collar) inside the existing 8-pixel-wide chest.
 */
function drawTorsoOverlay(palette: Palette, p: Px, ox: number, y: number, outfit: SceneOutfit) {
  switch (outfit.kind) {
    case 'modern': {
      // Skinny vertical tie running down the chest.
      p.rect(ox + 7, y + 10, 2, 5, palette.accent);
      p.put(ox + 7, y + 10, palette.accentHi);
      break;
    }
    case 'school': {
      // V-collar uniform (two diagonals meeting at the neck).
      p.put(ox + 5, y + 11, palette.accent);
      p.put(ox + 6, y + 12, palette.accent);
      p.put(ox + 10, y + 11, palette.accent);
      p.put(ox + 9, y + 12, palette.accent);
      p.put(ox + 7, y + 13, palette.accent);
      p.put(ox + 8, y + 13, palette.accent);
      break;
    }
    case 'lab': {
      // Lab-coat lapel (two vertical white strips with darker outline) — the
      // base shirt color already reads as a white coat thanks to the palette.
      p.rect(ox + 5, y + 11, 1, 5, palette.outlineSoft);
      p.rect(ox + 10, y + 11, 1, 5, palette.outlineSoft);
      // Pocket pen-cap (accent-colored)
      p.put(ox + 5, y + 13, palette.accent);
      break;
    }
    case 'construction': {
      // Hi-vis vest horizontal reflective stripes across the chest.
      p.rect(ox + 4, y + 13, 8, 1, palette.accentHi);
      // Open vest "V" implied by darker shoulders
      p.put(ox + 4, y + 11, palette.accentShade);
      p.put(ox + 11, y + 11, palette.accentShade);
      break;
    }
    case 'cozy':
    default:
      // Plain shirt — tinted per session by PixiJS.
      break;
  }
}

/**
 * Scene-specific action prop drawn in/near the worker's hand. Routed by
 * (row, variant) so each scene's worker holds something contextual during
 * each action: a pipette while typing in lab, a hammer in construction,
 * chalk in school, etc.
 *
 * Hand positions (after arms_up / arms_down drawing):
 *   arms_up:   right hand at (ox+12, y+8), left at (ox+3, y+14)
 *   arms_down: hands at (ox+3, y+14) and (ox+12, y+14)
 *
 * Row indices (must match the variants table in makeWorkerSheet):
 *   0=idle 1=typing 2=bash 3=reading 4=writing 5=looking_up
 *   6=waiting_approval 7=walking 8=drinking 9=thinking 10=holding_sign
 *
 * This iteration only paints props for the typing row (1). Subsequent
 * iterations add bash/writing/reading/etc props.
 */
function drawActionProp(
  palette: Palette,
  p: Px,
  ox: number,
  y: number,
  v: Variant,
  row: number,
  outfit: SceneOutfit,
) {
  // Variant → hand position helper.
  const handUp = v === 'arms_up' || v === 'wave';
  // Right-hand position used by most props (more visible side)
  const rhx = ox + 12;
  const rhy = handUp ? y + 8 : y + 14;

  // TYPING row (1)
  if (row === 1) {
    switch (outfit.kind) {
      case 'lab': {
        // Pipette — vertical white wand with teal bulb at top + tip droplet
        p.put(rhx + 1, rhy - 3, palette.accent);
        p.put(rhx + 1, rhy - 2, palette.accent);
        p.put(rhx + 1, rhy - 1, palette.cloud);
        p.put(rhx + 1, rhy, palette.cloud);
        p.put(rhx + 1, rhy + 1, palette.outline);
        if (handUp) p.put(rhx + 1, rhy + 3, palette.accent);
        break;
      }
      case 'school': {
        // Chalk in hand
        p.put(rhx + 1, rhy, palette.cloud);
        p.put(rhx + 2, rhy, palette.cloud);
        if (handUp) p.put(rhx + 3, rhy - 1, palette.cloud);
        break;
      }
      case 'construction': {
        // Hammer — vertical handle + horizontal head + spark on up-stroke
        p.rect(rhx + 1, rhy + 1, 1, 3, palette.desk);
        p.put(rhx + 1, rhy + 4, palette.deskShade);
        p.rect(rhx, rhy, 3, 2, palette.outline);
        p.put(rhx + 2, rhy + 1, palette.wallLowerShade);
        if (handUp) {
          p.put(rhx - 1, rhy + 4, palette.accentHi);
          p.put(rhx + 3, rhy + 4, palette.accentHi);
        }
        break;
      }
      case 'modern': {
        // Faint laptop key glow on the desk surface
        if (!handUp) {
          p.put(ox + 7, y + 13, palette.accentHi);
          p.put(ox + 8, y + 13, palette.accentHi);
        }
        break;
      }
      case 'cozy':
      default:
        break;
    }
  }

  // BASH row (2) — variants: still, arms_up, still, arms_down
  // Bash = running a shell command. Per scene: drilling (construction),
  // centrifuge/shaking (lab), grading (school), terminal cursor (modern).
  if (row === 2) {
    switch (outfit.kind) {
      case 'lab': {
        // Centrifuge / vial shaking — small spinning flask in the hand
        // with motion ticks. Different rotation on up vs down.
        if (handUp) {
          // Tall flask raised, vibration ticks around it
          p.rect(rhx, rhy - 2, 3, 4, palette.accent);
          p.put(rhx + 1, rhy - 3, palette.cloud);
          p.put(rhx - 1, rhy - 1, palette.accentHi);
          p.put(rhx + 3, rhy - 1, palette.accentHi);
          p.put(rhx - 1, rhy + 1, palette.accentHi);
          p.put(rhx + 3, rhy + 1, palette.accentHi);
        } else if (v === 'arms_down') {
          // Flask resting in hand, smaller
          p.rect(rhx, rhy - 1, 3, 3, palette.accent);
          p.put(rhx + 1, rhy - 2, palette.cloud);
        } else {
          // Idle 'still' — small flask on desk + clipboard
          p.rect(ox + 10, y + 13, 3, 1, palette.accent);
          p.put(ox + 11, y + 12, palette.cloud);
        }
        break;
      }
      case 'school': {
        // Red-pen grading — short red marker in hand, paper-mark dots
        // appear under it on the down-stroke.
        if (handUp) {
          p.rect(rhx, rhy - 1, 2, 2, palette.accent);
          p.put(rhx, rhy - 2, palette.cloud); // pen cap
        } else if (v === 'arms_down') {
          p.rect(rhx, rhy, 2, 2, palette.accent);
          // Grading checkmark on desk surface
          p.put(ox + 11, y + 13, palette.accent);
          p.put(ox + 12, y + 12, palette.accent);
        } else {
          // still — pen visible at desk
          p.rect(ox + 10, y + 13, 2, 1, palette.accent);
        }
        break;
      }
      case 'construction': {
        // Power drill / cordless driver — held forward + drill chuck +
        // sawdust puffs. Reads as "boring a hole".
        if (handUp) {
          // Drill body raised, motion lines
          p.rect(rhx - 1, rhy - 1, 4, 3, palette.outline);
          p.rect(rhx - 1, rhy - 1, 1, 3, palette.accent); // orange grip
          p.put(rhx + 3, rhy, palette.wallLowerShade);    // chuck
          // Sawdust puff
          p.put(rhx + 4, rhy - 1, palette.accentHi);
          p.put(rhx + 4, rhy + 1, palette.accentHi);
        } else if (v === 'arms_down') {
          // Drill at desk-level
          p.rect(rhx - 1, rhy, 4, 2, palette.outline);
          p.rect(rhx - 1, rhy, 1, 2, palette.accent);
          p.put(rhx + 3, rhy, palette.wallLowerShade);
        } else {
          // still — drill resting on desk
          p.rect(ox + 10, y + 13, 4, 2, palette.outline);
        }
        break;
      }
      case 'modern': {
        // Terminal cursor blink on the desk — small bright pixel pulses
        if (handUp) {
          p.put(ox + 7, y + 12, palette.accentHi);
          p.put(ox + 8, y + 12, palette.accentHi);
        } else if (v === 'arms_down') {
          p.put(ox + 7, y + 13, palette.accent);
        }
        break;
      }
      case 'cozy':
      default:
        break;
    }
  }

  // READING row (3) — eyes shift L/R while arms stay in still position.
  // Worker has a held document/book in front of them at desk height. The
  // eyes' L/R shift suggests scanning the page.
  if (row === 3) {
    // Held-in-hands position (between both hands at y+13)
    const bx = ox + 5;
    const by = y + 12;
    switch (outfit.kind) {
      case 'lab': {
        // Lab notebook with teal-tabbed pages
        p.rect(bx, by, 6, 3, palette.cloud);
        p.rect(bx, by, 6, 1, palette.outline);
        p.rect(bx, by + 2, 6, 1, palette.accentShade);
        p.put(bx + 5, by + 1, palette.accent); // tab
        // Faint text lines
        p.put(bx + 1, by + 1, palette.outline);
        p.put(bx + 3, by + 1, palette.outline);
        break;
      }
      case 'school': {
        // Textbook — colorful spine + pages
        p.rect(bx, by, 6, 3, palette.accent);
        p.rect(bx, by, 6, 1, palette.accentShade);
        p.rect(bx + 1, by + 1, 5, 1, palette.cloud);
        // Page edge
        p.put(bx, by + 1, palette.paper);
        p.put(bx, by + 2, palette.paper);
        break;
      }
      case 'construction': {
        // Blueprint sheet — cyan with white grid lines
        p.rect(bx, by, 6, 3, palette.monitorScreen);
        p.rect(bx, by, 6, 1, palette.monitorScreenLit);
        // Grid
        p.put(bx + 2, by + 1, palette.cloud);
        p.put(bx + 4, by + 1, palette.cloud);
        p.put(bx + 2, by + 2, palette.cloud);
        p.put(bx + 4, by + 2, palette.cloud);
        break;
      }
      case 'modern': {
        // Tablet — dark slab with bright accent stripe (current line)
        p.rect(bx, by, 6, 3, palette.outline);
        p.rect(bx + 1, by + 1, 4, 1, palette.accent);
        p.put(bx + 5, by + 1, palette.accentHi);
        break;
      }
      case 'cozy':
      default:
        break;
    }
  }

  // WRITING row (4) — alternates arms_down / arms_up. Fired by Write/Edit
  // tools. Reads as "longer-form authoring": notebook + pen, clipboard,
  // pencil sketches.
  if (row === 4) {
    switch (outfit.kind) {
      case 'lab': {
        // Clipboard + pen — record results in lab notebook. Pen tip moves
        // between up and down strokes.
        if (handUp) {
          // Lift pen
          p.put(rhx + 1, rhy - 1, palette.accent);
          p.put(rhx + 1, rhy, palette.outline);
        } else {
          // Pen down, marking the page
          p.put(rhx + 1, rhy, palette.outline);
          p.put(rhx, rhy + 1, palette.accent);
        }
        // Clipboard on the desk
        p.rect(ox + 8, y + 13, 5, 3, palette.cloud);
        p.rect(ox + 8, y + 13, 5, 1, palette.outline);
        // Pen line on the clipboard
        p.put(ox + 9, y + 14, palette.outline);
        p.put(ox + 10, y + 14, palette.outline);
        break;
      }
      case 'school': {
        // Pencil with eraser top — long pencil held in the right hand
        if (handUp) {
          p.put(rhx + 1, rhy - 2, palette.accent); // pink eraser top
          p.put(rhx + 1, rhy - 1, palette.deskTopHi); // wood pencil
          p.put(rhx + 1, rhy, palette.deskTopHi);
          p.put(rhx + 1, rhy + 1, palette.outline); // graphite tip
        } else {
          p.put(rhx + 1, rhy, palette.accent);
          p.put(rhx + 1, rhy + 1, palette.deskTopHi);
          p.put(rhx + 1, rhy + 2, palette.outline);
        }
        // Notebook page on desk
        p.rect(ox + 9, y + 13, 5, 3, palette.paper);
        p.rect(ox + 9, y + 14, 5, 1, palette.paperShade);
        break;
      }
      case 'construction': {
        // Carpenter pencil + blueprint corner. Heavy flat pencil.
        if (handUp) {
          p.rect(rhx, rhy - 1, 2, 1, palette.deskShade); // pencil
          p.put(rhx, rhy, palette.outline);
        } else {
          p.rect(rhx, rhy, 2, 1, palette.deskShade);
          p.put(rhx, rhy + 1, palette.outline);
        }
        // Blueprint corner on desk
        p.rect(ox + 8, y + 13, 6, 3, palette.monitorScreen);
        p.rect(ox + 8, y + 13, 6, 1, palette.monitorScreenLit);
        // Sketch line
        p.rect(ox + 9, y + 14, 4, 1, palette.cloud);
        break;
      }
      case 'modern': {
        // Tablet with stylus — small black slab on desk + a 1-px stylus
        // tip near the hand.
        if (handUp) {
          p.put(rhx + 1, rhy - 1, palette.outline);
          p.put(rhx + 1, rhy, palette.accent);
        } else {
          p.put(rhx + 1, rhy, palette.outline);
        }
        // Tablet
        p.rect(ox + 8, y + 13, 6, 3, palette.outline);
        p.rect(ox + 9, y + 14, 4, 1, palette.accent);
        break;
      }
      case 'cozy':
      default:
        break;
    }
  }

  // LOOKING_UP row (5) — variants look_r / still / look_l / still. Worker
  // is searching reference material (fires on WebFetch / WebSearch). Hand
  // pose is "still" — both forearms forward at desk height. We add a small
  // reference object IN HAND between the two hands.
  if (row === 5) {
    const bx = ox + 5;
    const by = y + 12;
    switch (outfit.kind) {
      case 'lab': {
        // Magnifying glass tilted over the desk surface
        // Lens (round outline)
        p.put(bx + 1, by, palette.outline);
        p.put(bx + 2, by, palette.outline);
        p.put(bx + 3, by, palette.outline);
        p.put(bx, by + 1, palette.outline);
        p.put(bx + 4, by + 1, palette.outline);
        p.put(bx + 1, by + 2, palette.outline);
        p.put(bx + 2, by + 2, palette.outline);
        p.put(bx + 3, by + 2, palette.outline);
        // Glass tint
        p.put(bx + 2, by + 1, palette.accentHi);
        // Handle
        p.put(bx + 5, by + 2, palette.desk);
        p.put(bx + 6, by + 3, palette.desk);
        break;
      }
      case 'school': {
        // Open book lying flat on desk — two pages with a spine and text
        p.rect(bx, by, 6, 3, palette.paper);
        p.rect(bx + 3, by, 1, 3, palette.paperShade); // spine
        p.put(bx + 1, by + 1, palette.outline);
        p.put(bx + 2, by + 1, palette.outline);
        p.put(bx + 4, by + 1, palette.outline);
        p.put(bx + 5, by + 1, palette.outline);
        break;
      }
      case 'construction': {
        // Walkie-talkie + tape measure — handheld device on the desk
        p.rect(bx, by, 3, 3, palette.outline);
        p.put(bx + 1, by, palette.accent); // antenna stub
        p.put(bx + 1, by + 1, palette.accentHi); // LED
        // Tape measure
        p.rect(bx + 4, by + 1, 3, 2, palette.accent);
        p.put(bx + 4, by + 1, palette.accentShade);
        p.put(bx + 6, by + 2, palette.cloud); // tape lock
        break;
      }
      case 'modern': {
        // Tablet glowing with browser/search UI
        p.rect(bx, by, 7, 3, palette.outline);
        p.rect(bx + 1, by + 1, 5, 1, palette.accent);
        p.put(bx + 6, by + 1, palette.accentHi);
        // URL bar dot
        p.put(bx + 1, by + 2, palette.cloud);
        break;
      }
      case 'cozy':
      default:
        break;
    }
  }

  // HOLDING_SIGN row (10) — both arms raised holding a horizontal bar
  // above the head (sign_up / sign_up_bob). The actual sign GLYPH is
  // drawn separately as an emote overlay above the worker. Here we paint
  // a scene-specific accent on the held bar itself.
  if (row === 10) {
    // The arms_section draws hands at (ox+3, y+7) and (ox+12, y+7).
    // We paint a held BAR between them at y+7 with scene-specific tone.
    switch (outfit.kind) {
      case 'lab': {
        // Safety-yellow caution bar across the held position
        p.rect(ox + 4, y + 7, 8, 1, palette.accent);
        p.put(ox + 4, y + 6, palette.accentHi);
        p.put(ox + 11, y + 6, palette.accentHi);
        break;
      }
      case 'school': {
        // Slim wooden pointer / ruler
        p.rect(ox + 4, y + 7, 8, 1, palette.deskTopHi);
        p.put(ox + 4, y + 7, palette.outline);
        p.put(ox + 11, y + 7, palette.outline);
        break;
      }
      case 'construction': {
        // Heavy plank bar — wider and orange-tipped
        p.rect(ox + 4, y + 7, 8, 1, palette.desk);
        p.rect(ox + 4, y + 6, 8, 1, palette.deskTopHi);
        p.put(ox + 4, y + 7, palette.accent); // safety-orange tip
        p.put(ox + 11, y + 7, palette.accent);
        break;
      }
      case 'modern': {
        // Sleek black tablet held overhead — slim teal accent stripe
        p.rect(ox + 4, y + 6, 8, 2, palette.outline);
        p.rect(ox + 4, y + 7, 8, 1, palette.accent);
        p.put(ox + 11, y + 7, palette.accentHi);
        break;
      }
      case 'cozy':
      default:
        break;
    }
  }

  // THINKING row (9) — variants think_a / think_b. Worker's right arm is
  // bent up to chin (right hand at ~ox+11, y+9-10). Add a small held
  // object suggesting what they're contemplating with: a pencil, a vial,
  // a clipboard tip, etc.
  if (row === 9) {
    const cx = ox + 11; // near chin
    const cy = y + 9;
    switch (outfit.kind) {
      case 'lab': {
        // Small flask raised near face — examining sample
        p.put(cx, cy, palette.accent);
        p.put(cx - 1, cy, palette.accent);
        p.put(cx - 1, cy + 1, palette.cloud); // neck highlight
        break;
      }
      case 'school': {
        // Pencil tap — tip near the chin
        p.put(cx, cy, palette.deskTopHi);
        p.put(cx, cy - 1, palette.outline); // graphite tip
        break;
      }
      case 'construction': {
        // Tape measure / clipboard corner — held near chin
        p.put(cx, cy, palette.accent);
        p.put(cx, cy + 1, palette.outline);
        break;
      }
      case 'modern': {
        // Pen tap — accent dot at the chin
        p.put(cx, cy, palette.accent);
        break;
      }
      case 'cozy':
      default:
        break;
    }
  }
}

/* ---------------- Emote sheet ----------------
 * Frames (16×16 each, laid out horizontally):
 *   0 — '!' bubble (urgent)
 *   1 — '...' bubble (thinking)
 *   2 — heart
 *   3 — '?' signboard (held by holding_sign worker)
 *   4 — scroll/plan (held by holding_sign worker)
 *   5 — thought bubble (drifts above worker between tools)
 *   6 — coffee cup steam (above worker walking_to_coffee / brief)
 *   7 — '+' helper pop (subagent spawn/finish)
 *
 * NOTE: ID numbers here MUST stay in sync with sprite-factory.EMOTE_FRAMES
 * and Office.tsx's overlay selection.
 */
export const EMOTE_FRAMES = {
  exclaim: 0,
  ellipsis: 1,
  heart: 2,
  signQuestion: 3,
  signPlan: 4,
  thought: 5,
  coffeeSteam: 6,
  helperPop: 7,
} as const;
export const EMOTE_COUNT = 8;
export function makeEmoteSheet(palette: Palette): Texture {
  const w = 16 * EMOTE_COUNT;
  const h = 16;
  const p = newPx(w, h);

  const drawBubble = (ox: number, glyph: '!' | '...' | '♥') => {
    // Bubble shadow (drop)
    p.rect(ox + 3, 12, 10, 1, palette.shadow);
    // Outline
    p.rect(ox + 2, 1, 12, 11, palette.emoteOutline);
    p.rect(ox + 3, 0, 10, 1, palette.emoteOutline);
    p.rect(ox + 3, 12, 10, 1, palette.emoteOutline);
    // Fill
    p.rect(ox + 3, 1, 10, 11, palette.speechBg);
    // Inner shade ring
    p.rect(ox + 3, 11, 10, 1, palette.speechShade);
    // Tail (pointing down-left)
    p.rect(ox + 5, 13, 3, 1, palette.emoteOutline);
    p.put(ox + 6, 14, palette.emoteOutline);
    p.put(ox + 6, 13, palette.speechBg);
    if (glyph === '!') {
      p.rect(ox + 7, 3, 2, 5, palette.emoteOutline);
      p.rect(ox + 7, 9, 2, 1, palette.emoteOutline);
    } else if (glyph === '...') {
      p.rect(ox + 5, 7, 1, 1, palette.emoteOutline);
      p.rect(ox + 7, 7, 1, 1, palette.emoteOutline);
      p.rect(ox + 9, 7, 1, 1, palette.emoteOutline);
      p.rect(ox + 5, 8, 1, 1, palette.speechShade);
      p.rect(ox + 7, 8, 1, 1, palette.speechShade);
      p.rect(ox + 9, 8, 1, 1, palette.speechShade);
    } else {
      // heart
      p.put(ox + 6, 3, '#e02828');
      p.put(ox + 9, 3, '#e02828');
      p.rect(ox + 5, 4, 6, 2, '#e02828');
      p.rect(ox + 6, 6, 4, 1, '#e02828');
      p.rect(ox + 7, 7, 2, 1, '#e02828');
      p.put(ox + 6, 4, '#ff8080');
    }
  };

  drawBubble(0, '!');
  drawBubble(16, '...');
  drawBubble(32, '♥');

  // Frame 3 — wooden signboard with a '?' carved in.
  drawSignboard(palette, p, 48, '?');
  // Frame 4 — rolled scroll with horizontal "plan" lines.
  drawScroll(palette, p, 64);
  // Frame 5 — thought bubble (a cloud with smaller orbs trailing down-left).
  drawThoughtBubble(palette, p, 80);
  // Frame 6 — coffee steam wisp (used briefly during walking_to_coffee).
  drawCoffeeSteamIcon(palette, p, 96);
  // Frame 7 — "+1 helper" puff burst.
  drawHelperPop(palette, p, 112);

  return makeTex(p.canvas);
}

function drawSignboard(palette: Palette, p: Px, ox: number, glyph: '?' | 'plan') {
  // Soft drop shadow
  p.rect(ox + 2, 14, 12, 1, palette.shadow);
  // Outer dark frame
  p.rect(ox + 1, 2, 14, 11, palette.windowFrameShade);
  // Wood body
  p.rect(ox + 2, 3, 12, 9, palette.bookshelfBody);
  // Inner highlight band (top)
  p.rect(ox + 2, 3, 12, 1, '#7a4a25');
  // Inner shadow (bottom)
  p.rect(ox + 2, 11, 12, 1, palette.bookshelfShade);
  // Nail heads (4 corners)
  p.put(ox + 3, 4, '#1a1008');
  p.put(ox + 12, 4, '#1a1008');
  p.put(ox + 3, 10, '#1a1008');
  p.put(ox + 12, 10, '#1a1008');
  if (glyph === '?') {
    // Carved '?' — light cream pixels
    p.rect(ox + 7, 5, 2, 1, palette.speechBg);
    p.put(ox + 9, 6, palette.speechBg);
    p.put(ox + 8, 7, palette.speechBg);
    p.put(ox + 8, 9, palette.speechBg);
  }
}

function drawScroll(palette: Palette, p: Px, ox: number) {
  // Drop shadow
  p.rect(ox + 2, 14, 12, 1, palette.shadow);
  // Outline
  p.rect(ox + 2, 3, 12, 10, palette.windowFrameShade);
  // Parchment body
  p.rect(ox + 3, 4, 10, 8, palette.paper);
  // Top and bottom curl (rolled scroll)
  p.rect(ox + 2, 3, 12, 1, '#a08a5a');
  p.rect(ox + 2, 12, 12, 1, '#a08a5a');
  p.rect(ox + 1, 4, 1, 8, '#a08a5a');
  p.rect(ox + 14, 4, 1, 8, '#a08a5a');
  // Plan lines
  p.rect(ox + 4, 6, 7, 1, '#6a4a20');
  p.rect(ox + 4, 8, 5, 1, '#6a4a20');
  p.rect(ox + 4, 10, 6, 1, '#6a4a20');
  // Wax seal dot
  p.put(ox + 11, 10, '#a82020');
  p.put(ox + 11, 9, '#c84040');
}

function drawThoughtBubble(palette: Palette, p: Px, ox: number) {
  // Drop shadow
  p.rect(ox + 4, 14, 8, 1, palette.shadow);
  // Cloud-y bubble: rounded rect built from a 3-row stack
  p.rect(ox + 4, 3, 8, 1, palette.emoteOutline);
  p.rect(ox + 3, 4, 10, 1, palette.emoteOutline);
  p.rect(ox + 2, 5, 12, 5, palette.emoteOutline);
  p.rect(ox + 3, 10, 10, 1, palette.emoteOutline);
  p.rect(ox + 4, 11, 8, 1, palette.emoteOutline);
  // Fill
  p.rect(ox + 4, 4, 8, 1, palette.speechBg);
  p.rect(ox + 3, 5, 10, 5, palette.speechBg);
  p.rect(ox + 4, 10, 8, 1, palette.speechBg);
  // Inner shade ring
  p.rect(ox + 3, 9, 10, 1, palette.speechShade);
  // Tail (trailing small orbs going down-left)
  p.put(ox + 5, 12, palette.emoteOutline);
  p.put(ox + 5, 12, palette.speechBg);
  p.put(ox + 4, 13, palette.emoteOutline);
  // Ellipsis inside the bubble
  p.put(ox + 5, 7, palette.emoteOutline);
  p.put(ox + 7, 7, palette.emoteOutline);
  p.put(ox + 9, 7, palette.emoteOutline);
}

function drawCoffeeSteamIcon(palette: Palette, p: Px, ox: number) {
  // Soft mug at bottom
  p.rect(ox + 5, 10, 6, 4, palette.mug);
  p.rect(ox + 5, 10, 6, 1, palette.mugShade);
  p.put(ox + 11, 11, palette.mug); // handle
  // Steam — three wisps drifting up
  p.put(ox + 6, 8, '#ffffff');
  p.put(ox + 7, 7, '#ffffff');
  p.put(ox + 8, 6, '#ffffff');
  p.put(ox + 9, 5, '#ffffff');
  p.put(ox + 7, 4, '#dfe5f0');
  p.put(ox + 9, 4, '#dfe5f0');
}

function drawHelperPop(palette: Palette, p: Px, ox: number) {
  // Star-burst "+1": 4-point cream star with a plus glyph
  p.put(ox + 7, 4, palette.emoteYellow);
  p.put(ox + 8, 4, palette.emoteYellow);
  p.put(ox + 7, 11, palette.emoteYellow);
  p.put(ox + 8, 11, palette.emoteYellow);
  p.put(ox + 3, 7, palette.emoteYellow);
  p.put(ox + 3, 8, palette.emoteYellow);
  p.put(ox + 12, 7, palette.emoteYellow);
  p.put(ox + 12, 8, palette.emoteYellow);
  p.rect(ox + 5, 5, 6, 6, palette.emoteYellow);
  p.rect(ox + 5, 5, 6, 1, palette.speechShade);
  // '+' glyph in dark
  p.rect(ox + 7, 6, 2, 4, palette.emoteOutline);
  p.rect(ox + 6, 7, 4, 2, palette.emoteOutline);
}

export function emoteFrameRect(idx: number): Rectangle {
  return new Rectangle(idx * 16, 0, 16, 16);
}
