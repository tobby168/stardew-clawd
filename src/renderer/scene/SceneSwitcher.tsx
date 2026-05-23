import { useEffect, useRef, useState } from 'react';
import type { ActiveScene } from './scene-state';

/**
 * Floating top-left recycle button + popup picker. Left-click cycles
 * to the next scene in `registry.order`. Click the chevron (or the
 * button when expanded) to open the radial-ish picker showing every
 * scene with its icon — useful when you have 5 scenes and don't want
 * to cycle through them all.
 *
 * Styling matches the wood-frame aesthetic of .zoom-slider so the UI
 * reads as part of the same Stardew-style control set.
 */
export function SceneSwitcher(props: { active: ActiveScene }) {
  const { active } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the picker if the user clicks anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const current = active.available.find((s) => s.id === active.sceneId);

  return (
    <div className="scene-switcher" ref={rootRef}>
      <button
        className="scene-switcher-btn"
        title={`Scene: ${current?.displayName ?? active.sceneId} — click to cycle`}
        aria-label={`Switch scene (current: ${current?.displayName ?? active.sceneId})`}
        onClick={() => active.cycle()}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        <RecycleIcon />
      </button>
      <button
        className="scene-switcher-chev"
        title="Pick a scene"
        aria-label="Pick a scene"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="scene-switcher-popup" role="menu" aria-label="Scenes">
          {active.available.map((s) => (
            <button
              key={s.id}
              className={
                'scene-switcher-item' + (s.id === active.sceneId ? ' is-active' : '')
              }
              role="menuitemradio"
              aria-checked={s.id === active.sceneId}
              onClick={() => {
                active.setSceneId(s.id);
                setOpen(false);
              }}
            >
              <span className="scene-switcher-icon" aria-hidden="true">{s.icon}</span>
              <span>{s.displayName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pixel-art recycle/cycle icon. Two arrows chasing each other around a circle.
 * Inline SVG keeps the bundle asset-free and lets us inherit currentColor.
 */
function RecycleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <g fill="currentColor">
        {/* Top arrow — curving clockwise to the right */}
        <path d="M3 9 L4 9 L4 7 L8 7 L8 5 L12 5 L12 7 L13 7 L13 8 L14 8 L14 9 L15 9 L15 8 L14 8 L14 6 L13 6 L13 5 L12 5 L12 3 L8 3 L8 5 L4 5 L4 7 L3 7 Z" opacity="0" />
        {/* Simpler: two arcs as filled pixel-art arrows */}
        <path d="M4 8 L8 4 L8 6 L13 6 L13 9 L11 9 L11 8 L8 8 L8 10 Z" />
        <path d="M16 12 L12 16 L12 14 L7 14 L7 11 L9 11 L9 12 L12 12 L12 10 Z" />
      </g>
    </svg>
  );
}
