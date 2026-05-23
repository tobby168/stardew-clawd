import { useEffect, useRef } from 'react';
import {
  Application,
  Sprite,
  Texture,
  Container,
  Text,
  Graphics,
  FederatedPointerEvent,
} from 'pixi.js';
import {
  makeOfficeBackground,
  makeDeskTexture,
  makeWorkerSheet,
  makeEmoteSheet,
  makeSkyTexture,
  currentSkyMode,
  WINDOW,
  frameRect,
  emoteFrameRect,
  FRAME_W,
  FRAME_H,
  SHEET_ROWS,
  SHEET_COLS,
  CHARACTER_STYLES,
  EMOTE_FRAMES,
  EMOTE_COUNT,
  type BgRoom,
} from './sprite-factory';
import type { SessionState, WorkerState } from '@shared/events';
import { WorkerFsm, type WaypointProvider, type Vec2 } from './worker-fsm';
import { getClient } from '../useSessions';
import animationsConfig from '../../../config/animations.config.json';
import assetsConfig from '../../../config/assets.config.json';
import cameraConfig from '../../../config/camera.config.json';
import type { SceneConfig } from './palette';

const TILE = assetsConfig.tilemap.tileSize;
const ANIM_FPS = animationsConfig.fps;

const VARIANT_KEYS = Object.keys(CHARACTER_STYLES);

function variantForSessionId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return VARIANT_KEYS[h % VARIANT_KEYS.length];
}

// ----- World expansion (sync with shared/config expandWorld) -----
// Inlined for the renderer to avoid importing node-only modules from
// shared/config (which uses node:fs). Same shape, same logic. Now takes
// the active scene as input so each scene's rooms can be laid out
// independently.
interface ExpandedRoom {
  id: string;
  theme: string;
  cols: number;
  rows: number;
  originTileX: number;
  door?: { x: number; y: number };
  absoluteDoor?: Vec2;
  absoluteDesks: Array<{
    id: string;
    roomId: string;
    x: number;
    y: number;
    sitX: number;
    sitY: number;
  }>;
  decorations: Array<{ type: string; x: number; y: number; variant?: string }>;
}

function expandWorld(scene: SceneConfig): ExpandedRoom[] {
  const out: ExpandedRoom[] = [];
  let cursor = 0;
  const wallThickness = scene.wallThickness ?? 0;
  for (const r of scene.rooms) {
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
      id: r.id,
      theme: r.theme,
      cols: r.cols,
      rows: r.rows,
      originTileX,
      door: r.door,
      absoluteDoor,
      absoluteDesks,
      decorations: r.decorations,
    });
    cursor += r.cols + wallThickness;
  }
  return out;
}

/** Map deskId → absolute desk position within the given expanded scene. */
function findDesk(allRooms: ExpandedRoom[], deskId: string | undefined) {
  if (!deskId) return allRooms[0]?.absoluteDesks[0];
  for (const r of allRooms) {
    const d = r.absoluteDesks.find((dx) => dx.id === deskId);
    if (d) return d;
  }
  return allRooms[0]?.absoluteDesks[0];
}

/** How many rooms should be visible given the active worker count. */
function activeRoomCount(scene: SceneConfig, allRooms: ExpandedRoom[], workerCount: number): number {
  if (workerCount <= 0) return 1; // always show at least the first room
  const perRoom = scene.growth.workersPerRoom;
  const n = Math.ceil(workerCount / perRoom);
  return Math.min(Math.max(1, n), allRooms.length);
}

/**
 * Bake a fresh worker sprite sheet per character variant for the given scene.
 * Each scene's palette + outfit produces visually distinct sheets — same
 * 11×4 frame layout so the existing FSM/animation code is untouched.
 *
 * Returns the same shape as the old static bake: a record of variant id →
 * 11×4 grid of Textures.
 */
function bakeWorkerFrames(scene: SceneConfig): Record<string, Texture[][]> {
  const out: Record<string, Texture[][]> = {};
  for (const variant of VARIANT_KEYS) {
    const sheet = makeWorkerSheet(scene.palette, CHARACTER_STYLES[variant], scene.outfit);
    const frames: Texture[][] = [];
    for (let r = 0; r < SHEET_ROWS; r++) {
      frames[r] = [];
      for (let c = 0; c < SHEET_COLS; c++) {
        frames[r].push(new Texture({ source: sheet.source, frame: frameRect(r, c) }));
      }
    }
    out[variant] = frames;
  }
  return out;
}

// ----- Camera state shared with the zoom slider -----
export interface CameraState {
  scale: number;
  offsetX: number;
  offsetY: number;
  targetScale: number;
  targetOffsetX: number;
  targetOffsetY: number;
  worldWidthPx: number;
  worldHeightPx: number;
  viewportWidthPx: number;
  viewportHeightPx: number;
  /**
   * Set to true once the user manually adjusts zoom (slider/+/−). After that,
   * recenter/resize stops overriding `targetScale` so the user's choice sticks.
   */
  userOverrodeScale: boolean;
}

export function makeCameraState(): CameraState {
  return {
    scale: cameraConfig.defaultZoom,
    offsetX: 0,
    offsetY: 0,
    targetScale: cameraConfig.defaultZoom,
    targetOffsetX: 0,
    targetOffsetY: 0,
    worldWidthPx: 0,
    worldHeightPx: 0,
    viewportWidthPx: 1,
    viewportHeightPx: 1,
    userOverrodeScale: false,
  };
}

interface NameChip {
  /** Screen-space container, parented to uiOverlay (does NOT scale w/ camera). */
  root: Container;
  bg: Graphics;
  text: Text;
  lastText: string;
}

interface SpriteBundle {
  desk: Sprite;
  worker: Sprite;
  overlay: Sprite;
  /** Screen-space name chip (folder + tag). Constant pixel size regardless
   *  of camera zoom, so it stays readable when zoomed out. */
  chip: NameChip;
  workerFrames: Texture[][];
  emoteTextures: Texture[];
  fsm: WorkerFsm;
  animName: string;
  frameIdx: number;
  bobPhase: number;
  despawnRequested?: boolean;
}

interface DragState {
  active: boolean;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
  moved: boolean;
}

interface SceneRefs {
  app: Application | null;
  bundles: Map<string, SpriteBundle>;
  worldContainer: Container | null;
  /** Screen-space overlay container holding all NameChips. Sibling of world
   *  on the stage; never scaled by the camera. */
  uiOverlay: Container | null;
  bgSprite: Sprite | null;
  bgTexture: Texture | null;
  deskTexture: Texture | null;
  workerFramesByVariant: Record<string, Texture[][]> | null;
  emoteTextures: Texture[] | null;
  skyTextures: { day: Texture; night: Texture } | null;
  skySprites: Sprite[];
  motes: Array<{ g: Graphics; vx: number; vy: number; t: number; baseAlpha: number; bounds: { minX: number; maxX: number; minY: number; maxY: number } }>;
  liveSessions: Map<string, SessionState>;
  onSelect: (id: string) => void;
  selectedId: string | null;
  drag: DragState;
  /** Active scene config (palette + rooms + outfit + vocabulary). */
  scene: SceneConfig | null;
  /** Expanded rooms for the active scene (absolute coords, sit positions). */
  allRooms: ExpandedRoom[];
  visibleRoomCount: number;
  /** Mutable list of waypoints, recomputed when visibleRoomCount or scene changes. */
  waypointCache: {
    doors: Vec2[];
    bookshelves: Vec2[];
    coffeeMachines: Vec2[];
  };
  /** Wall-clock ms of the last centroid recentre (rate-limit). */
  lastRecenterAt: number;
  /** Hard-cut the first time we recentre (no swoop on startup). */
  hasCenteredOnce: boolean;
  resizeObserver?: ResizeObserver;
  skyTimer?: ReturnType<typeof setInterval>;
}

/**
 * The big PixiJS scene. Holds:
 *   - The world Container (positioned/scaled by the camera)
 *   - One bg sprite (rebaked when visibleRoomCount changes)
 *   - Per-window sky overlays (day/night)
 *   - Worker bundles (desk + worker + overlay + label)
 *   - Drag-to-pan via stage pointer events
 *
 * The camera state lives on `cameraStateRef` (owned by App) so the floating
 * ZoomSlider can mutate `targetScale` directly. The ticker lerps the live
 * scale/offset toward the targets.
 */
export function Office(props: {
  sessions: SessionState[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  cameraStateRef: React.MutableRefObject<CameraState>;
  /** Active scene config (palette, rooms, outfit, vocabulary). */
  scene: SceneConfig;
  /** Active scene id — used as a stable key for the hot-swap effect. */
  sceneId: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const refs = useRef<SceneRefs>({
    app: null,
    bundles: new Map(),
    worldContainer: null,
    uiOverlay: null,
    bgSprite: null,
    bgTexture: null,
    deskTexture: null,
    workerFramesByVariant: null,
    emoteTextures: null,
    skyTextures: null,
    skySprites: [],
    motes: [],
    liveSessions: new Map(),
    onSelect: props.onSelect,
    selectedId: props.selectedSessionId,
    drag: { active: false, startX: 0, startY: 0, startOffsetX: 0, startOffsetY: 0, moved: false },
    scene: props.scene,
    allRooms: expandWorld(props.scene),
    visibleRoomCount: 1,
    waypointCache: { doors: [], bookshelves: [], coffeeMachines: [] },
    lastRecenterAt: 0,
    hasCenteredOnce: false,
  });
  refs.current.onSelect = props.onSelect;
  refs.current.selectedId = props.selectedSessionId;

  // Dev hook — expose scene refs for inspection / Playwright. Mirrors the
  // existing `window.__camera` exposure in App.tsx.
  if (typeof window !== 'undefined') {
    (window as unknown as { __sceneRefs: () => SceneRefs }).__sceneRefs = () => refs.current;
  }

  // Init PixiJS once.
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    const app = new Application();
    const initPromise = app.init({
      backgroundColor: 0x1a0e08,
      resizeTo: host,
      antialias: false,
      roundPixels: false, // camera scale may be fractional; we round position only.
      preference: 'webgl',
      width: Math.max(host.clientWidth, 1),
      height: Math.max(host.clientHeight, 1),
    });
    initPromise
      .catch((err) => console.error('[office] PixiJS init rejected:', err))
      .then(() => {
        if (cancelled) {
          app.destroy(true);
          return;
        }
        host.appendChild(app.canvas);
        app.canvas.style.imageRendering = 'pixelated';
        refs.current.app = app;

        const world = new Container();
        app.stage.addChild(world);
        refs.current.worldContainer = world;

        // Screen-space UI overlay (name chips). Added AFTER world so it draws
        // on top, and NOT inside world so its children render at constant
        // pixel size regardless of the camera's zoom.
        const uiOverlay = new Container();
        uiOverlay.eventMode = 'none'; // pass pointer events through to world
        app.stage.addChild(uiOverlay);
        refs.current.uiOverlay = uiOverlay;

        // Initial bg + sky + motes use one room. rebakeWorld() expands later
        // as worker count grows.
        const bg = new Sprite();
        world.addChild(bg);
        refs.current.bgSprite = bg;

        // Initial bake uses the scene that was set when the component first
        // mounted. Subsequent scene changes go through the scene-swap effect
        // below, which rebuilds these textures from the new palette/outfit.
        const initialScene = refs.current.scene!;
        const dayTex = makeSkyTexture(initialScene.palette, 'day');
        const nightTex = makeSkyTexture(initialScene.palette, 'night');
        refs.current.skyTextures = { day: dayTex, night: nightTex };

        refs.current.deskTexture = makeDeskTexture(initialScene.palette, initialScene.outfit.kind, false);

        refs.current.workerFramesByVariant = bakeWorkerFrames(initialScene);

        const emoteSheet = makeEmoteSheet(initialScene.palette);
        const emotes: Texture[] = [];
        for (let i = 0; i < EMOTE_COUNT; i++) {
          emotes.push(new Texture({ source: emoteSheet.source, frame: emoteFrameRect(i) }));
        }
        refs.current.emoteTextures = emotes;

        // Set viewport size BEFORE the initial recenter so the auto-fit
        // computes against the real container size (not the 1×1 default).
        props.cameraStateRef.current.viewportWidthPx = app.renderer.width;
        props.cameraStateRef.current.viewportHeightPx = app.renderer.height;
        // Bake initial bg with room 1 only.
        rebakeWorld(refs.current, 1, props.cameraStateRef);
        // Center camera on the first room's centroid (no smooth lerp on startup).
        refs.current.hasCenteredOnce = false;
        recenterOnWorkers(refs.current, props.cameraStateRef, /* hardCut */ true);

        // --- Drag-to-pan on the stage ---
        app.stage.eventMode = 'static';
        app.stage.hitArea = app.screen;
        app.stage.cursor = 'grab';
        app.stage.on('pointerdown', (e: FederatedPointerEvent) => {
          const cam = props.cameraStateRef.current;
          refs.current.drag = {
            active: true,
            startX: e.global.x,
            startY: e.global.y,
            startOffsetX: cam.targetOffsetX,
            startOffsetY: cam.targetOffsetY,
            moved: false,
          };
          app.stage.cursor = 'grabbing';
        });
        const endDrag = () => {
          refs.current.drag.active = false;
          app.stage.cursor = 'grab';
        };
        app.stage.on('pointerup', endDrag);
        app.stage.on('pointerupoutside', endDrag);
        app.stage.on('pointermove', (e: FederatedPointerEvent) => {
          const d = refs.current.drag;
          if (!d.active) return;
          const dxScreen = e.global.x - d.startX;
          const dyScreen = e.global.y - d.startY;
          if (!d.moved && Math.hypot(dxScreen, dyScreen) > cameraConfig.clickDragThresholdPx) {
            d.moved = true;
          }
          const cam = props.cameraStateRef.current;
          cam.targetOffsetX = d.startOffsetX + dxScreen * cameraConfig.dragSensitivity;
          cam.targetOffsetY = d.startOffsetY + dyScreen * cameraConfig.dragSensitivity;
          // Apply during drag without lerping (so it tracks the cursor).
          cam.offsetX = cam.targetOffsetX;
          cam.offsetY = cam.targetOffsetY;
          clampCamera(cam);
        });

        // --- Resize handling: keep camera valid, viewport updated ---
        const onResize = () => {
          const cam = props.cameraStateRef.current;
          const prevW = cam.viewportWidthPx;
          const prevH = cam.viewportHeightPx;
          cam.viewportWidthPx = app.renderer.width;
          cam.viewportHeightPx = app.renderer.height;
          // If the viewport changed significantly, redo the centroid + fit
          // computation so the "fill the area" auto-fit zoom updates.
          const significant = Math.abs(prevW - cam.viewportWidthPx) > 4 ||
                              Math.abs(prevH - cam.viewportHeightPx) > 4;
          if (significant) {
            recenterOnWorkers(refs.current, props.cameraStateRef, /* hardCut */ true);
          } else {
            clampCamera(cam);
          }
        };
        onResize();
        const ro = new ResizeObserver(onResize);
        ro.observe(host);
        app.renderer.on('resize', onResize);
        refs.current.resizeObserver = ro;

        // --- Sky day/night sync (every minute) ---
        const syncSky = () => {
          const tex = currentSkyMode() === 'day'
            ? refs.current.skyTextures!.day
            : refs.current.skyTextures!.night;
          for (const s of refs.current.skySprites) s.texture = tex;
        };
        syncSky();
        refs.current.skyTimer = setInterval(syncSky, 60_000);

        // --- Main ticker ---
        let frameAcc = 0;
        const framePeriod = 1 / ANIM_FPS;
        app.ticker.add((ticker) => {
          const dt = ticker.deltaMS / 16;
          const cam = props.cameraStateRef.current;

          // Camera lerp toward targets (smooth pan/zoom/recenter).
          const k = cameraConfig.centroidLerpSpeed;
          cam.scale += (cam.targetScale - cam.scale) * k * dt;
          cam.offsetX += (cam.targetOffsetX - cam.offsetX) * k * dt;
          cam.offsetY += (cam.targetOffsetY - cam.offsetY) * k * dt;
          if (Math.abs(cam.targetScale - cam.scale) < 0.001) cam.scale = cam.targetScale;
          if (Math.abs(cam.targetOffsetX - cam.offsetX) < 0.5) cam.offsetX = cam.targetOffsetX;
          if (Math.abs(cam.targetOffsetY - cam.offsetY) < 0.5) cam.offsetY = cam.targetOffsetY;
          world.scale.set(cam.scale);
          world.position.set(Math.round(cam.offsetX), Math.round(cam.offsetY));

          // Ambient motes (in world space)
          for (const m of refs.current.motes) {
            m.t += 0.05 * dt;
            m.g.x += m.vx * dt;
            m.g.y += m.vy * dt + Math.sin(m.t) * 0.05;
            if (m.g.x > m.bounds.maxX) m.g.x = m.bounds.minX;
            if (m.g.y < m.bounds.minY) m.g.y = m.bounds.maxY - 1;
            if (m.g.y > m.bounds.maxY) m.g.y = m.bounds.minY + 1;
            m.g.alpha = m.baseAlpha * (0.6 + 0.4 * Math.sin(m.t * 1.7));
          }

          if (!refs.current.workerFramesByVariant) return;

          // Step FSM + update sprite positions.
          const now = Date.now();
          for (const [sid, b] of refs.current.bundles) {
            const session = refs.current.liveSessions.get(sid);
            if (!session) continue;
            const deskSlot = findDesk(refs.current.allRooms, session.deskId);
            if (!deskSlot) continue;
            const out = b.fsm.step({
              session,
              deskSit: { x: deskSlot.sitX, y: deskSlot.sitY },
              now,
            });
            b.worker.x = out.position.x * TILE;
            b.worker.y = out.position.y * TILE - 22;
            b.worker.scale.x = out.facing === 1 ? 1 : -1;
            b.worker.x += out.facing === 1 ? 0 : FRAME_W;

            const animName =
              (animationsConfig.workerStateToAnim as Record<string, string>)[out.display] ?? 'idle';
            const animCfg = animationsConfig.states[animName as keyof typeof animationsConfig.states];
            if (animCfg && animName !== b.animName) {
              b.animName = animName;
              b.frameIdx = 0;
            }

            if (out.leftRoom && !b.despawnRequested) {
              b.despawnRequested = true;
              getClient().despawn(sid).catch(() => { /* harmless */ });
            }

            updateOverlay(b, session, out.display);
            placeOverlayAbove(b, out);

            // Name chip lives in screen space — project the worker's world
            // position through the camera transform so the chip floats above
            // the sprite at constant pixel size, no matter the zoom.
            const worldCx = out.position.x * TILE + FRAME_W / 2;
            const worldCy = out.position.y * TILE + 4;
            b.chip.root.x = Math.round(worldCx * cam.scale + cam.offsetX);
            b.chip.root.y = Math.round(worldCy * cam.scale + cam.offsetY);
          }

          // Frame ticking
          frameAcc += ticker.deltaMS / 1000;
          if (frameAcc < framePeriod) return;
          frameAcc = 0;
          for (const b of refs.current.bundles.values()) {
            const animCfg =
              animationsConfig.states[b.animName as keyof typeof animationsConfig.states] ??
              animationsConfig.states.idle;
            b.frameIdx = (b.frameIdx + 1) % animCfg.frames;
            const tex = b.workerFrames[animCfg.row]?.[b.frameIdx % b.workerFrames[animCfg.row].length];
            if (tex) b.worker.texture = tex;
            if (b.overlay.visible) {
              b.bobPhase = (b.bobPhase + 1) % 8;
              b.overlay.alpha = b.bobPhase < 4 ? 1 : 0.75;
            }
          }

          for (const [sid, b] of refs.current.bundles) {
            const selected = refs.current.selectedId === sid;
            renderSelection(b, selected);
          }
        });
      });

    return () => {
      cancelled = true;
      const a = refs.current.app;
      if (a) {
        a.destroy(true);
        refs.current.app = null;
      }
      const ro = refs.current.resizeObserver;
      if (ro) {
        ro.disconnect();
        refs.current.resizeObserver = undefined;
      }
      const sky = refs.current.skyTimer;
      if (sky) {
        clearInterval(sky);
        refs.current.skyTimer = undefined;
      }
      if (refs.current.skyTextures) {
        refs.current.skyTextures.day.destroy(true);
        refs.current.skyTextures.night.destroy(true);
        refs.current.skyTextures = null;
      }
      refs.current.bundles.clear();
    };
  }, []);

  // Sync sprites with sessions list.
  useEffect(() => {
    const r = refs.current;
    const liveMap = new Map<string, SessionState>();
    for (const s of props.sessions) liveMap.set(s.sessionId, s);
    r.liveSessions = liveMap;
    if (
      !r.app ||
      !r.worldContainer ||
      !r.workerFramesByVariant ||
      !r.emoteTextures ||
      !r.deskTexture
    )
      return;

    // Decide visible rooms based on active worker count, rebake bg if grew.
    const need = activeRoomCount(r.scene!, r.allRooms, props.sessions.length);
    if (need !== r.visibleRoomCount) {
      rebakeWorld(r, need, props.cameraStateRef);
    }

    const seen = new Set<string>();
    let addedAny = false;
    let removedAny = false;
    for (const s of props.sessions) {
      seen.add(s.sessionId);
      let bundle = r.bundles.get(s.sessionId);
      if (!bundle) {
        bundle = createBundle(s, r);
        r.bundles.set(s.sessionId, bundle);
        addedAny = true;
      }
      updateNameChip(bundle.chip, shortLabel(s));
    }
    for (const [id, b] of r.bundles) {
      if (!seen.has(id)) {
        b.desk.destroy();
        b.worker.destroy();
        b.overlay.destroy();
        b.chip.root.destroy({ children: true });
        if ((b as any)._sel) {
          ((b as any)._sel.halo as Graphics)?.destroy();
          ((b as any)._sel.arrow as Graphics)?.destroy();
        }
        r.bundles.delete(id);
        removedAny = true;
      }
    }

    // Recenter camera on the worker centroid whenever population changes.
    if (cameraConfig.recenterOnPopulationChange && (addedAny || removedAny)) {
      const now = Date.now();
      if (now - r.lastRecenterAt > cameraConfig.recenterMinIntervalMs) {
        recenterOnWorkers(r, props.cameraStateRef, /* hardCut */ false);
        r.lastRecenterAt = now;
      }
    }
  }, [props.sessions]);

  // ----- Scene hot-swap -----
  //
  // When `sceneId` changes (recycle button click), rebake every texture
  // tied to the active palette/outfit and swap them in place. Workers'
  // FSM state, desk assignments, and active sessions are preserved — only
  // the visual representation flips. Camera position is left alone.
  useEffect(() => {
    const r = refs.current;
    if (!r.app || !r.worldContainer) {
      // App not initialized yet — the init effect captures the initial scene
      // directly from refs.current.scene. Just refresh refs so a subsequent
      // init call sees the right values.
      r.scene = props.scene;
      r.allRooms = expandWorld(props.scene);
      return;
    }
    const isFirstFrame = r.scene === props.scene;
    if (isFirstFrame) return; // Skip the synchronous mount tick — init handled it.

    r.scene = props.scene;
    r.allRooms = expandWorld(props.scene);

    // Re-bake textures. Important: we do NOT call destroy(true) on the old
    // textures here. Shared textures (deskTexture, bg, worker sheets) are
    // referenced by many sprites; destroying their underlying source while
    // those sprites still hold them corrupts Pixi's texture batch and breaks
    // ALL rendering, not just the destroyed sprite. The unused textures will
    // be GC'd once nothing references them — fine for a low-frequency event
    // like scene switching.
    const newSky = {
      day: makeSkyTexture(props.scene.palette, 'day'),
      night: makeSkyTexture(props.scene.palette, 'night'),
    };
    r.skyTextures = newSky;

    const newDeskTex = makeDeskTexture(props.scene.palette, props.scene.outfit.kind, false);
    r.deskTexture = newDeskTex;

    const newFrames = bakeWorkerFrames(props.scene);
    r.workerFramesByVariant = newFrames;

    const newEmoteSheet = makeEmoteSheet(props.scene.palette);
    const newEmotes: Texture[] = [];
    for (let i = 0; i < EMOTE_COUNT; i++) {
      newEmotes.push(new Texture({ source: newEmoteSheet.source, frame: emoteFrameRect(i) }));
    }
    r.emoteTextures = newEmotes;

    // Swap each existing bundle's textures (worker, desk, overlay) to the
    // new scene's bakes. Workers' FSM state and session bindings stay put;
    // only the visual representation flips. Desk position is also remapped
    // to the same-id desk in the new scene.
    for (const [sid, b] of r.bundles) {
      const session = r.liveSessions.get(sid);
      if (!session) continue;
      const variant = variantForSessionId(sid);
      const variantFrames = newFrames[variant];
      b.workerFrames = variantFrames;
      b.emoteTextures = newEmotes;
      b.worker.texture = variantFrames[0][0];
      b.desk.texture = newDeskTex;
      // Snap desk visual position to the new scene's same-id desk.
      const newDesk = findDesk(r.allRooms, session.deskId);
      if (newDesk) {
        b.desk.x = newDesk.x * TILE - 6;
        b.desk.y = newDesk.y * TILE - 2;
      }
    }

    // Rebake background + waypoints for the new scene at the current room
    // count. rebakeWorld reads from refs.current.scene / allRooms so it now
    // produces the new-scene world.
    rebakeWorld(r, r.visibleRoomCount, props.cameraStateRef);

    // Refresh background sky overlays to the new scene's day/night sprites.
    const skyTex = currentSkyMode() === 'day' ? newSky.day : newSky.night;
    for (const s of r.skySprites) s.texture = skyTex;
  }, [props.sceneId, props.scene]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}

function createBundle(s: SessionState, r: SceneRefs): SpriteBundle {
  const world = r.worldContainer!;
  const deskSlot = findDesk(r.allRooms, s.deskId)!;

  const desk = new Sprite(r.deskTexture!);
  desk.x = deskSlot.x * TILE - 6;
  desk.y = deskSlot.y * TILE - 2;
  desk.eventMode = 'static';
  desk.cursor = 'pointer';
  desk.on('pointertap', () => {
    if (r.drag.moved) return;
    r.onSelect(s.sessionId);
  });
  world.addChild(desk);

  const variant = variantForSessionId(s.sessionId);
  const variantFrames = r.workerFramesByVariant![variant];
  const worker = new Sprite(variantFrames[0][0]);
  worker.tint = s.tint;
  worker.eventMode = 'static';
  worker.cursor = 'pointer';
  worker.on('pointertap', () => {
    if (r.drag.moved) return;
    r.onSelect(s.sessionId);
  });
  world.addChild(worker);

  const overlay = new Sprite(r.emoteTextures![EMOTE_FRAMES.thought]);
  overlay.visible = false;
  world.addChild(overlay);

  const chip = makeNameChip(shortLabel(s));
  r.uiOverlay!.addChild(chip.root);

  // The FSM needs live waypoint lists. We pass a provider that reads from
  // the SceneRefs cache, which is kept up-to-date by rebakeWorld().
  const waypointProvider: WaypointProvider = {
    doors: () => r.waypointCache.doors,
    bookshelves: () => r.waypointCache.bookshelves,
    coffeeMachines: () => r.waypointCache.coffeeMachines,
  };

  return {
    desk,
    worker,
    overlay,
    chip,
    workerFrames: variantFrames,
    emoteTextures: r.emoteTextures!,
    fsm: new WorkerFsm(s, { x: deskSlot.sitX, y: deskSlot.sitY }, waypointProvider),
    animName: 'idle',
    frameIdx: 0,
    bobPhase: 0,
  };
}

/**
 * Re-bake the world background + sky overlays + motes for the given visible
 * room count. Also refreshes the waypoint cache that workers query.
 */
function rebakeWorld(
  r: SceneRefs,
  visibleRoomCount: number,
  cameraStateRef: React.MutableRefObject<CameraState>,
) {
  const world = r.worldContainer;
  const scene = r.scene;
  if (!world || !scene) return;
  const rooms = r.allRooms.slice(0, visibleRoomCount);

  // Bake new bg texture.
  const bgRooms: BgRoom[] = rooms.map((rm) => ({
    originTileX: rm.originTileX,
    cols: rm.cols,
    rows: rm.rows,
    decorations: rm.decorations,
  }));
  const newBg = makeOfficeBackground(scene.palette, bgRooms, scene.outfit.kind);
  if (r.bgSprite) {
    r.bgSprite.texture = newBg;
  }
  // Don't destroy(true) the old bgTexture — if anything still holds a
  // reference (e.g. a transient sprite), destroying the source corrupts
  // Pixi's texture batch. Let GC handle it.
  r.bgTexture = newBg;

  // World total pixel size, used for camera clamping.
  const totalCols = rooms.length > 0
    ? Math.max(...rooms.map((rm) => rm.originTileX + rm.cols))
    : 0;
  const totalRows = rooms.length > 0
    ? Math.max(...rooms.map((rm) => rm.rows))
    : assetsConfig.tilemap.roomRows;
  const worldWidthPx = totalCols * TILE;
  const worldHeightPx = totalRows * TILE;
  cameraStateRef.current.worldWidthPx = worldWidthPx;
  cameraStateRef.current.worldHeightPx = worldHeightPx;

  // Sky overlays: one per window across all visible rooms.
  for (const s of r.skySprites) s.destroy();
  r.skySprites = [];
  const skyTex = currentSkyMode() === 'day'
    ? r.skyTextures!.day
    : r.skyTextures!.night;
  for (const rm of rooms) {
    for (const dec of rm.decorations) {
      if (dec.type !== 'window') continue;
      const s = new Sprite(skyTex);
      s.x = rm.originTileX * TILE + dec.x + WINDOW.innerInset;
      s.y = dec.y + WINDOW.innerInset;
      world.addChild(s);
      // Keep sky behind workers but in front of bg — child order works since
      // workers are added AFTER rebake in createBundle.
      r.skySprites.push(s);
    }
  }

  // Re-create motes scoped to the (possibly grown) world bounds.
  for (const m of r.motes) m.g.destroy();
  r.motes = [];
  const MOTE_COUNT_PER_ROOM = 8;
  const moteCount = Math.max(MOTE_COUNT_PER_ROOM, rooms.length * MOTE_COUNT_PER_ROOM);
  for (let i = 0; i < moteCount; i++) {
    const g = new Graphics();
    g.rect(0, 0, 1, 1);
    g.fill({ color: 0xffe9a8, alpha: 0.7 });
    const minY = TILE * 3;
    const maxY = totalRows * TILE;
    g.x = Math.random() * worldWidthPx;
    g.y = minY + Math.random() * (maxY - minY);
    world.addChild(g);
    r.motes.push({
      g,
      vx: 0.05 + Math.random() * 0.1,
      vy: -0.02 + Math.random() * 0.04,
      t: Math.random() * Math.PI * 2,
      baseAlpha: 0.5 + Math.random() * 0.4,
      bounds: { minX: 0, maxX: worldWidthPx, minY, maxY },
    });
  }

  // Refresh waypoint cache (doors, bookshelves-equivalent, coffee-equivalent).
  // The active scene's vocabulary declares which decoration `type` strings
  // count as a bookshelf-trip target or a coffee-trip target — same canonical
  // FSM behavior, scene-specific naming.
  const bookshelfTypes = new Set(scene.vocabulary.waypointTypes.bookshelf);
  const coffeeTypes = new Set(scene.vocabulary.waypointTypes.coffee);
  const doors: Vec2[] = [];
  const bookshelves: Vec2[] = [];
  const coffeeMachines: Vec2[] = [];
  for (const rm of rooms) {
    if (rm.absoluteDoor) doors.push(rm.absoluteDoor);
    for (const dec of rm.decorations) {
      if (bookshelfTypes.has(dec.type)) {
        bookshelves.push({
          x: rm.originTileX + (dec.x + 12) / TILE,
          y: (dec.y + 32) / TILE,
        });
      } else if (coffeeTypes.has(dec.type)) {
        coffeeMachines.push({
          x: rm.originTileX + (dec.x + 6) / TILE,
          y: (dec.y + 16) / TILE,
        });
      }
    }
  }
  // Fallback: at least one door (origin) so workers can spawn/leave.
  if (doors.length === 0) doors.push({ x: 0, y: 9.5 });
  r.waypointCache = { doors, bookshelves, coffeeMachines };

  r.visibleRoomCount = visibleRoomCount;
  clampCamera(cameraStateRef.current);
}

/**
 * Recenter the camera on the centroid of active workers (or the world center
 * if no workers). `hardCut` jumps immediately; otherwise the lerp in the
 * ticker handles smoothing.
 *
 * If the world at defaultZoom is smaller than the viewport, the target zoom
 * is bumped up to whatever scale makes the world at least cover the viewport
 * in both axes. This is the "fill the area" guarantee — a single-room world
 * shouldn't leave dark padding around it. User-driven zoom (via the slider)
 * still respects minZoom and can shrink the world below the viewport.
 */
function recenterOnWorkers(
  r: SceneRefs,
  cameraStateRef: React.MutableRefObject<CameraState>,
  hardCut: boolean,
) {
  const cam = cameraStateRef.current;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const s of r.liveSessions.values()) {
    const d = findDesk(r.allRooms, s.deskId);
    if (!d) continue;
    cx += d.sitX;
    cy += d.sitY;
    n++;
  }
  if (n === 0) {
    cx = (cam.worldWidthPx / TILE) / 2;
    cy = (cam.worldHeightPx / TILE) / 2;
  } else {
    cx /= n;
    cy /= n;
  }
  // Choose the zoom: at minimum, defaultZoom; bump up to FULLY cover the
  // viewport (no dark padding on either axis) if the world is smaller. The
  // cap is autoFitMaxZoom, independent of the slider's maxZoom, so we can
  // reach cover even when that exceeds the user-facing slider range. Skip
  // entirely once the user has manually picked a zoom — their choice wins.
  if (!cam.userOverrodeScale) {
    const fitToFill = Math.max(
      cam.viewportWidthPx / Math.max(1, cam.worldWidthPx),
      cam.viewportHeightPx / Math.max(1, cam.worldHeightPx),
    );
    cam.targetScale = Math.min(
      cameraConfig.autoFitMaxZoom,
      Math.max(cameraConfig.defaultZoom, fitToFill),
    );
  }
  const cxPx = cx * TILE;
  const cyPx = cy * TILE;
  cam.targetOffsetX = cam.viewportWidthPx / 2 - cxPx * cam.targetScale;
  cam.targetOffsetY = cam.viewportHeightPx / 2 - cyPx * cam.targetScale;
  clampCameraTargets(cam);
  if (hardCut || (cameraConfig.firstSpawnHardCut && !r.hasCenteredOnce)) {
    cam.offsetX = cam.targetOffsetX;
    cam.offsetY = cam.targetOffsetY;
    cam.scale = cam.targetScale;
    r.hasCenteredOnce = true;
  }
}

/**
 * Clamp the targetOffset so the world fully covers the viewport.
 *  - If world*scale <= viewport: center the world (no room to slide).
 *  - If world*scale  > viewport: keep the world covering all viewport edges —
 *    offsetX in [viewport-world*scale, 0], same for Y. No overshoot.
 *
 * edgePaddingTiles only applies to user-driven drag (see clampCamera), never
 * to recenter — recenter must NOT leave dark stripes at the viewport edges.
 */
function clampCameraTargets(cam: CameraState) {
  const ws = cam.worldWidthPx * cam.targetScale;
  const hs = cam.worldHeightPx * cam.targetScale;
  if (ws <= cam.viewportWidthPx) {
    cam.targetOffsetX = (cam.viewportWidthPx - ws) / 2;
  } else {
    const minX = cam.viewportWidthPx - ws;
    const maxX = 0;
    cam.targetOffsetX = Math.max(minX, Math.min(maxX, cam.targetOffsetX));
  }
  if (hs <= cam.viewportHeightPx) {
    cam.targetOffsetY = (cam.viewportHeightPx - hs) / 2;
  } else {
    const minY = cam.viewportHeightPx - hs;
    const maxY = 0;
    cam.targetOffsetY = Math.max(minY, Math.min(maxY, cam.targetOffsetY));
  }
}

/**
 * Clamp the live offset (used during drag and from `onResize`). Allows
 * `edgePaddingTiles` of overshoot for nicer drag feel — user can pull the
 * world a few tiles past the edge before the clamp resists.
 */
function clampCamera(cam: CameraState) {
  const ws = cam.worldWidthPx * cam.scale;
  const hs = cam.worldHeightPx * cam.scale;
  const padX = cameraConfig.edgePaddingTiles * TILE * cam.scale;
  const padY = padX;
  if (ws <= cam.viewportWidthPx) {
    cam.offsetX = (cam.viewportWidthPx - ws) / 2;
    cam.targetOffsetX = cam.offsetX;
  } else {
    const minX = cam.viewportWidthPx - ws - padX;
    const maxX = padX;
    cam.offsetX = Math.max(minX, Math.min(maxX, cam.offsetX));
    cam.targetOffsetX = Math.max(minX, Math.min(maxX, cam.targetOffsetX));
  }
  if (hs <= cam.viewportHeightPx) {
    cam.offsetY = (cam.viewportHeightPx - hs) / 2;
    cam.targetOffsetY = cam.offsetY;
  } else {
    const minY = cam.viewportHeightPx - hs - padY;
    const maxY = padY;
    cam.offsetY = Math.max(minY, Math.min(maxY, cam.offsetY));
    cam.targetOffsetY = Math.max(minY, Math.min(maxY, cam.targetOffsetY));
  }
}

/** Public: snap camera target zoom while keeping viewport center fixed. */
export function setCameraZoom(cam: CameraState, newScale: number) {
  const clamped = Math.max(cameraConfig.minZoom, Math.min(cameraConfig.maxZoom, newScale));
  // Anchor on viewport center so zoom feels like a pinch around the middle.
  const cx = cam.viewportWidthPx / 2;
  const cy = cam.viewportHeightPx / 2;
  // World point currently under the viewport center.
  const wx = (cx - cam.targetOffsetX) / cam.targetScale;
  const wy = (cy - cam.targetOffsetY) / cam.targetScale;
  cam.targetScale = clamped;
  cam.targetOffsetX = cx - wx * cam.targetScale;
  cam.targetOffsetY = cy - wy * cam.targetScale;
  // Mark as user-overridden so auto-fit recenter/resize won't bounce it back.
  cam.userOverrodeScale = true;
  clampCameraTargets(cam);
}

function updateOverlay(b: SpriteBundle, session: SessionState, display: WorkerState) {
  let idx: number | null = null;
  if (display === 'holding_question') idx = EMOTE_FRAMES.signQuestion;
  else if (display === 'holding_plan') idx = EMOTE_FRAMES.signPlan;
  else if (display === 'walking_to_coffee' || display === 'at_coffee') idx = EMOTE_FRAMES.coffeeSteam;
  else if (display === 'at_desk_thinking') idx = EMOTE_FRAMES.thought;
  else if (session.isSubagent && display !== 'leaving') idx = EMOTE_FRAMES.helperPop;

  if (idx === null) {
    b.overlay.visible = false;
    return;
  }
  b.overlay.visible = true;
  b.overlay.texture = b.emoteTextures[idx];
}

function placeOverlayAbove(b: SpriteBundle, _out: { facing: 1 | -1 }) {
  const cx = b.worker.x + (b.worker.scale.x === -1 ? -FRAME_W / 2 : FRAME_W / 2);
  b.overlay.x = cx - 8;
  b.overlay.y = b.worker.y - 14;
}

function renderSelection(b: SpriteBundle, selected: boolean) {
  if (selected) {
    if (!(b as any)._sel) {
      const halo = new Graphics();
      halo.ellipse(0, 0, 11, 4);
      halo.fill({ color: 0xfff0a0, alpha: 0.55 });
      halo.ellipse(0, 0, 8, 3);
      halo.fill({ color: 0xffffff, alpha: 0.7 });
      b.worker.parent?.addChildAt(halo, b.worker.parent.getChildIndex(b.worker));
      const arrow = new Graphics();
      arrow.moveTo(-3, -4);
      arrow.lineTo(3, -4);
      arrow.lineTo(0, 0);
      arrow.lineTo(-3, -4);
      arrow.fill({ color: 0xffe070 });
      arrow.stroke({ color: 0x1a0e08, width: 1 });
      b.worker.parent?.addChild(arrow);
      (b as any)._sel = { halo, arrow, phase: 0 };
    }
    const sel = (b as any)._sel as { halo: Graphics; arrow: Graphics; phase: number };
    const cx = b.worker.x + (b.worker.scale.x === -1 ? -FRAME_W / 2 : FRAME_W / 2);
    sel.halo.x = cx;
    sel.halo.y = b.worker.y + FRAME_H;
    sel.arrow.x = cx;
    sel.arrow.y = b.worker.y - 8;
    sel.phase = (sel.phase + 1) % 16;
    const pulse = 0.55 + (sel.phase < 8 ? sel.phase : 16 - sel.phase) * 0.04;
    sel.halo.alpha = pulse;
    sel.arrow.y += sel.phase < 8 ? 0 : -1;
  } else if ((b as any)._sel) {
    const sel = (b as any)._sel as { halo: Graphics; arrow: Graphics };
    sel.halo.destroy();
    sel.arrow.destroy();
    (b as any)._sel = null;
  }
}

function shortLabel(s: SessionState): string {
  const cwd = s.cwd || '';
  const parts = cwd.split('/').filter(Boolean);
  let folder = parts[parts.length - 1] || 'home';
  if (folder.length > 14) folder = folder.slice(0, 11) + '…';
  const tag = s.isSubagent ? ' [sub]' : s.origin === 'external' ? ' [ext]' : '';
  return `${folder}${tag}`;
}

/**
 * Build a screen-space "name chip" — a small Stardew-style plaque (cream
 * background with a brown frame and dark shadow) holding the worker's label
 * text. The chip renders at constant pixel size regardless of camera zoom
 * because its root is parented to uiOverlay (sibling of the scaled world).
 *
 * The pivot is set so root.x/y refers to the chip's TOP-CENTER, which the
 * ticker positions just above the worker's head in screen space.
 */
function makeNameChip(text: string): NameChip {
  const root = new Container();
  root.eventMode = 'none';
  const bg = new Graphics();
  const t = new Text({
    text,
    style: {
      fontFamily: '"Menlo", "Consolas", monospace',
      fontSize: 11,
      fontWeight: 'bold',
      fill: 0x3a2410,
      letterSpacing: 0.3,
    },
  });
  t.anchor.set(0.5, 0);
  root.addChild(bg, t);
  const chip: NameChip = { root, bg, text: t, lastText: '' };
  layoutNameChip(chip, text);
  return chip;
}

function updateNameChip(chip: NameChip, text: string) {
  if (text === chip.lastText) return;
  chip.text.text = text;
  layoutNameChip(chip, text);
}

function layoutNameChip(chip: NameChip, text: string) {
  chip.lastText = text;
  // Measure rendered text to size the background pill.
  const padX = 6;
  const padY = 2;
  const w = Math.ceil(chip.text.width) + padX * 2;
  const h = Math.ceil(chip.text.height) + padY * 2;
  // Position text inside the pill (centered horizontally, padded down).
  chip.text.x = 0;
  chip.text.y = padY;
  // Background pill: dark drop-shadow, cream fill, brown border. Drawn so
  // (0, 0) is the TOP-CENTER (matches anchor used by the ticker placement).
  chip.bg.clear();
  // Drop shadow (offset 1px down)
  chip.bg
    .roundRect(-w / 2, 1, w, h, 3)
    .fill({ color: 0x1c0e08, alpha: 0.55 });
  // Brown frame
  chip.bg
    .roundRect(-w / 2, 0, w, h, 3)
    .fill({ color: 0x8a5a2b });
  // Cream interior (inset 1px to leave the brown border visible)
  chip.bg
    .roundRect(-w / 2 + 1, 1, w - 2, h - 2, 2)
    .fill({ color: 0xf8e9bc });
}
