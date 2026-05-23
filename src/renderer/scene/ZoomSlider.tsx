import { useEffect, useState } from 'react';
import { setCameraZoom, type CameraState } from './Office';
import cameraConfig from '../../../config/camera.config.json';

/**
 * Floating Stardew-style zoom control. Lives top-left over the scene.
 * Reads/writes a shared CameraState ref; the Pixi ticker picks up changes
 * via cam.targetScale (with a smooth lerp).
 */
export function ZoomSlider(props: {
  cameraStateRef: React.MutableRefObject<CameraState>;
}) {
  // Mirror the camera's targetScale into local React state so the slider
  // input renders. Initialized to defaultZoom; kept in sync by polling the
  // ref each animation frame (camera may also change from drag/recenter).
  const [zoom, setZoom] = useState(cameraConfig.defaultZoom);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const z = props.cameraStateRef.current.targetScale;
      if (Math.abs(z - zoom) > 0.01) setZoom(z);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [zoom, props.cameraStateRef]);

  const apply = (newZoom: number) => {
    setCameraZoom(props.cameraStateRef.current, newZoom);
    setZoom(props.cameraStateRef.current.targetScale);
  };

  const sliderMin = Math.round(cameraConfig.minZoom * 100);
  const sliderMax = Math.round(cameraConfig.maxZoom * 100);
  const sliderStep = Math.round(cameraConfig.sliderStep * 100);
  const buttonStep = cameraConfig.sliderButtonStep;

  return (
    <div className="zoom-slider" role="group" aria-label="Zoom">
      <button
        className="zoom-btn"
        aria-label="Zoom in"
        onClick={() => apply(zoom + buttonStep)}
      >
        +
      </button>
      <input
        className="zoom-range"
        type="range"
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        value={Math.round(zoom * 100)}
        // Vertical slider via CSS writing-mode + transform; the value runs
        // small-at-bottom to large-at-top, so we don't need to invert.
        onChange={(e) => apply(Number(e.target.value) / 100)}
        aria-label="Zoom level"
      />
      <button
        className="zoom-btn"
        aria-label="Zoom out"
        onClick={() => apply(zoom - buttonStep)}
      >
        −
      </button>
      <div className="zoom-readout">{zoom.toFixed(1)}×</div>
    </div>
  );
}
