/*
 * Active-scene hook + scene-config loading.
 *
 * Scene configs are bundled as static JSON imports (Vite resolves them at
 * build time). The registry `scenes.config.json` declares the ordered list
 * and the default; each scene id maps to its own `scenes/<id>.config.json`.
 *
 * On boot the hook asks the main process for the last-persisted scene id
 * (via the `getScene` IPC exposed by preload). If that id is unknown or
 * missing, it falls back to the registry's `default`.
 *
 * Switching scenes calls `setScene` which:
 *   1. Updates React state (drives the Office hot-swap effect)
 *   2. Persists through IPC (so the next launch picks up here)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { validateSceneConfig, type SceneConfig } from './palette';
import scenesRegistry from '../../../config/scenes.config.json';
import cozyOfficeRaw from '../../../config/scenes/cozy-office.config.json';
import modernOfficeRaw from '../../../config/scenes/modern-office.config.json';
import schoolRaw from '../../../config/scenes/school.config.json';
import labRaw from '../../../config/scenes/lab.config.json';
import constructionRaw from '../../../config/scenes/construction.config.json';

// ---- Static scene catalog ----
//
// Each raw JSON is validated at module load. If a palette key is missing the
// validator throws here, surfacing the bug at app start instead of mid-frame
// inside a `palette.X` lookup.
function load(raw: unknown, source: string): SceneConfig {
  validateSceneConfig(raw, source);
  return raw;
}

const CATALOG: Record<string, SceneConfig> = {
  'cozy-office': load(cozyOfficeRaw, 'cozy-office'),
  'modern-office': load(modernOfficeRaw, 'modern-office'),
  'school': load(schoolRaw, 'school'),
  'lab': load(labRaw, 'lab'),
  'construction': load(constructionRaw, 'construction'),
};

interface SceneRegistry {
  default: string;
  order: string[];
  scenes: Record<string, { displayName: string; icon: string }>;
}
const REGISTRY = scenesRegistry as SceneRegistry;

export function getRegistry(): SceneRegistry {
  return REGISTRY;
}

export function getSceneConfig(id: string): SceneConfig | null {
  return CATALOG[id] ?? null;
}

export function getDefaultSceneId(): string {
  return REGISTRY.default;
}

/**
 * Bridge type for the `stardew` global exposed by preload. Kept here so the
 * renderer doesn't have to import from the preload package (which would
 * pull in electron typings).
 */
interface StardewBridge {
  getScene?: () => Promise<string | null>;
  setScene?: (sceneId: string) => Promise<boolean>;
}
function bridge(): StardewBridge | null {
  return (window as unknown as { stardew?: StardewBridge }).stardew ?? null;
}

export interface ActiveScene {
  sceneId: string;
  scene: SceneConfig;
  /** Cycle to the next scene in `registry.order`. Persists through IPC. */
  cycle: () => void;
  /** Switch to a specific scene id (no-op if id is unknown). Persists. */
  setSceneId: (id: string) => void;
  /** All known scenes, in display order. */
  available: Array<{ id: string; displayName: string; icon: string }>;
}

/**
 * Active scene hook. Initialized to the registry default; once the main
 * process answers with the persisted id (if any) and it's valid, we swap.
 *
 * This intentionally does NOT block the first render — the user sees the
 * default scene for one frame then the persisted scene takes over. In
 * practice the IPC round-trip is <5ms so this is imperceptible.
 */
export function useActiveScene(): ActiveScene {
  const [sceneId, setSceneIdState] = useState<string>(getDefaultSceneId());

  useEffect(() => {
    const b = bridge();
    if (!b?.getScene) return;
    b.getScene()
      .then((persisted) => {
        if (persisted && CATALOG[persisted]) {
          setSceneIdState(persisted);
        }
      })
      .catch((err) => console.warn('[scene-state] getScene failed', err));
  }, []);

  const setSceneId = useCallback((id: string) => {
    if (!CATALOG[id]) return;
    setSceneIdState(id);
    const b = bridge();
    if (b?.setScene) {
      b.setScene(id).catch((err) => console.warn('[scene-state] setScene failed', err));
    }
  }, []);

  const cycle = useCallback(() => {
    const order = REGISTRY.order;
    setSceneIdState((cur) => {
      const idx = order.indexOf(cur);
      const next = order[(idx + 1) % order.length];
      const b = bridge();
      if (b?.setScene) {
        b.setScene(next).catch((err) => console.warn('[scene-state] setScene failed', err));
      }
      return next;
    });
  }, []);

  const available = useMemo(
    () =>
      REGISTRY.order
        .filter((id) => !!REGISTRY.scenes[id])
        .map((id) => ({
          id,
          displayName: REGISTRY.scenes[id].displayName,
          icon: REGISTRY.scenes[id].icon,
        })),
    [],
  );

  const scene = CATALOG[sceneId] ?? CATALOG[getDefaultSceneId()];

  return { sceneId, scene, cycle, setSceneId, available };
}
