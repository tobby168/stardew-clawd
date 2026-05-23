import { useRef, useState } from 'react';
import { useSessions, useUsage } from './useSessions';
import { Office, makeCameraState, type CameraState } from './scene/Office';
import { StatusBar } from './scene/StatusBar';
import { ZoomSlider } from './scene/ZoomSlider';
import { SceneSwitcher } from './scene/SceneSwitcher';
import { useActiveScene } from './scene/scene-state';
import { SessionPanel } from './panel/SessionPanel';
import { HireWorkerModal } from './panel/HireWorkerModal';

export function App() {
  const sessions = useSessions();
  const usage = useUsage();
  const activeScene = useActiveScene();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHire, setShowHire] = useState(false);

  // Shared camera state — Office writes to it from the Pixi ticker and pointer
  // events; ZoomSlider mutates targetScale on slider/buttons.
  const cameraStateRef = useRef<CameraState>(makeCameraState());
  // Dev hook — read camera state from devtools / playwright.
  if (typeof window !== 'undefined') {
    (window as unknown as { __camera: () => CameraState }).__camera = () =>
      cameraStateRef.current;
  }

  // Selection priority:
  //   1) explicit user click,
  //   2) any session with a pending approval (urgent),
  //   3) any busy session (most likely interesting),
  //   4) the most recently created session.
  const pending = sessions.find((s) => s.pendingInteraction);
  const busy = sessions.find((s) => s.status === 'busy');
  const newest = [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0];
  const effectiveSelected =
    selectedId ?? pending?.sessionId ?? busy?.sessionId ?? newest?.sessionId ?? null;
  const selected = sessions.find((s) => s.sessionId === effectiveSelected) ?? null;

  return (
    <div className="app">
      <div className="titlebar">
        <h1>{activeScene.scene.icon} {activeScene.scene.displayName.toUpperCase()}</h1>
        <span style={{ opacity: 0.6 }}>
          {sessions.length === 0
            ? 'office is empty — hire a worker to start'
            : `${sessions.length} worker${sessions.length === 1 ? '' : 's'} on the floor`}
        </span>
        <button className="hire-btn" onClick={() => setShowHire(true)}>
          + HIRE WORKER
        </button>
      </div>
      <div className="scene-pane">
        <Office
          sessions={sessions}
          selectedSessionId={effectiveSelected}
          onSelect={setSelectedId}
          cameraStateRef={cameraStateRef}
          scene={activeScene.scene}
          sceneId={activeScene.sceneId}
        />
        <SceneSwitcher active={activeScene} />
        <ZoomSlider cameraStateRef={cameraStateRef} />
        <StatusBar sessions={sessions} usage={usage} />
      </div>
      <SessionPanel session={selected} />
      {showHire && <HireWorkerModal onClose={() => setShowHire(false)} />}
    </div>
  );
}
