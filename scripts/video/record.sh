#!/usr/bin/env bash
# Top-level recorder for the Stardew Clawd submission walkthrough.
#
# Flow:
#   1. Pre-flight checks (dev running, audio manifest exists, intercept flag on).
#   2. Detects the Electron window bounds via osascript so ffmpeg can crop.
#   3. Starts ffmpeg screen capture (cropped) → tmp/video.mp4
#   4. Runs the orchestrator (drives the demo via CDP + mock hooks).
#   5. Stops ffmpeg cleanly.
#   6. Concats the per-beat MP3s into one audio track.
#   7. Muxes video + audio → scripts/video/out/final.mp4
#
# macOS only. Requires Screen Recording permission for whatever Terminal /
# parent process is invoking this script (System Settings → Privacy →
# Screen Recording).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
TMP_DIR="$SCRIPT_DIR/tmp"
AUDIO_DIR="$SCRIPT_DIR/audio"
MANIFEST="$AUDIO_DIR/manifest.json"
CONFIG_PATH="$REPO_ROOT/config/interactive-tools.json"
SCREEN_INDEX="${STARDEW_VIDEO_SCREEN_INDEX:-4}"   # avfoundation device index for "Capture screen 0"
FPS="${STARDEW_VIDEO_FPS:-30}"

mkdir -p "$OUT_DIR" "$TMP_DIR"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# ----- pre-flight -----------------------------------------------------------
[ -f "$MANIFEST" ] || { red "missing $MANIFEST — run: node scripts/video/generate-tts.mjs"; exit 1; }
command -v ffmpeg >/dev/null  || { red "ffmpeg not installed (brew install ffmpeg)"; exit 1; }
command -v ffprobe >/dev/null || { red "ffprobe not installed (comes with ffmpeg)"; exit 1; }
command -v osascript >/dev/null || { red "osascript missing — this script is macOS only"; exit 1; }

# Daemon reachable?
if ! curl -sf "http://127.0.0.1:9222/json/version" >/dev/null; then
  red "Electron CDP not reachable at 127.0.0.1:9222 — start the app with: npm run dev"
  exit 1
fi

# Intercept flag must be true for the AskUserQuestion beat to fire on mock sessions.
if ! node -e "process.exit(JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf-8')).interceptExternalSessions ? 0 : 1)"; then
  yellow "interceptExternalSessions is false — patching config and reminding you to restart dev"
  node -e "
    const fs = require('fs');
    const p = '$CONFIG_PATH';
    const j = JSON.parse(fs.readFileSync(p,'utf-8'));
    j.interceptExternalSessions = true;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  "
  red "config patched. RESTART \`npm run dev\` now (Ctrl-C + re-run) — config is loaded at boot."
  red "Then re-run this script."
  exit 1
fi

# ----- position the Electron window for recording --------------------------
# Sets a known size + position so the recording crop is deterministic. Knobs
# via env if you want a different rect on your display.
WIN_X="${STARDEW_VIDEO_WIN_X:-0}"
WIN_Y="${STARDEW_VIDEO_WIN_Y:-28}"
WIN_W="${STARDEW_VIDEO_WIN_W:-1700}"
WIN_H="${STARDEW_VIDEO_WIN_H:-900}"

green "Positioning Stardew Clawd window to ${WIN_W}x${WIN_H} at +${WIN_X}+${WIN_Y}..."
osascript <<AS || { red "could not position window (grant Accessibility to Claude.app, or app not running)"; exit 1; }
tell application "System Events"
  -- Multiple apps run under "Electron" (VS Code shares the bundle name).
  -- The whose-clause has to be inline at property-access time — iterating
  -- the window list or holding a reference trips an AppleScript bug on this
  -- Electron version ("can't get window 1").
  set ok to false
  repeat with p in (every application process whose name is "Electron")
    try
      set position of (first window of p whose name is "Stardew Clawd") to {$WIN_X, $WIN_Y}
      set size of (first window of p whose name is "Stardew Clawd") to {$WIN_W, $WIN_H}
      set frontmost of p to true
      set ok to true
      exit repeat
    end try
  end repeat
  if not ok then error "no Electron process owns a window titled 'Stardew Clawd'"
end tell
AS
sleep 0.8
# Read the ACTUAL window bounds back — macOS / Electron sometimes ignores the
# requested size (we've seen 1600 → 1710 in practice) and the crop must match
# what's really on screen, not what we asked for.
ACTUAL=$(osascript <<'AS' 2>/dev/null
tell application "System Events"
  repeat with p in (every application process whose name is "Electron")
    try
      set pos to position of (first window of p whose name is "Stardew Clawd")
      set sz to size of (first window of p whose name is "Stardew Clawd")
      return (item 1 of pos as text) & " " & (item 2 of pos as text) & " " & (item 1 of sz as text) & " " & (item 2 of sz as text)
    end try
  end repeat
end tell
AS
)
if [ -n "$ACTUAL" ]; then
  read -r ACT_X ACT_Y ACT_W ACT_H <<< "$ACTUAL"
  if [ "$ACT_W" != "$WIN_W" ] || [ "$ACT_H" != "$WIN_H" ] || [ "$ACT_X" != "$WIN_X" ] || [ "$ACT_Y" != "$WIN_Y" ]; then
    yellow "Window snapped to ${ACT_W}x${ACT_H} at +${ACT_X}+${ACT_Y} (requested ${WIN_W}x${WIN_H} at +${WIN_X}+${WIN_Y})"
    WIN_X=$ACT_X; WIN_Y=$ACT_Y; WIN_W=$ACT_W; WIN_H=$ACT_H
  fi
fi
green "Window positioned at ${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}."

# macOS retina displays capture at 2x logical points. Override with
# STARDEW_VIDEO_SCALE=N if your display uses a non-2x ratio.
SCALE="${STARDEW_VIDEO_SCALE:-2}"
WIN_X=$(( WIN_X * SCALE ))
WIN_Y=$(( WIN_Y * SCALE ))
WIN_W=$(( WIN_W * SCALE ))
WIN_H=$(( WIN_H * SCALE ))
# Even dimensions for h264.
WIN_W=$(( WIN_W - WIN_W % 2 ))
WIN_H=$(( WIN_H - WIN_H % 2 ))

green "Crop (×${SCALE} for retina): ${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# ----- start recording ------------------------------------------------------
VIDEO_RAW="$TMP_DIR/video-raw.mov"
rm -f "$VIDEO_RAW"

green "Starting ffmpeg recording (raw, will crop in post)..."
# Capture the whole screen, crop in post — most reliable. Output to lossless mov
# so we can re-crop without re-encoding loss.
ffmpeg -hide_banner -loglevel warning \
  -f avfoundation -framerate "$FPS" -capture_cursor 0 -i "${SCREEN_INDEX}:none" \
  -c:v h264_videotoolbox -b:v 8M -pix_fmt yuv420p \
  -vf "crop=${WIN_W}:${WIN_H}:${WIN_X}:${WIN_Y}" \
  "$VIDEO_RAW" &
FFMPEG_PID=$!
trap 'kill -INT $FFMPEG_PID 2>/dev/null || true; wait $FFMPEG_PID 2>/dev/null || true' EXIT

# Give ffmpeg a moment to spool up before the orchestrator starts firing actions.
sleep 1.5

# ----- run orchestrator -----------------------------------------------------
green "Running orchestrator..."
node "$SCRIPT_DIR/orchestrator.mjs" --record

# ----- stop recording -------------------------------------------------------
green "Stopping ffmpeg..."
kill -INT $FFMPEG_PID 2>/dev/null || true
wait $FFMPEG_PID 2>/dev/null || true
trap - EXIT

[ -s "$VIDEO_RAW" ] || { red "recording produced no output — check Screen Recording permission"; exit 1; }
green "Video raw: $VIDEO_RAW ($(du -h "$VIDEO_RAW" | cut -f1))"

# ----- build audio track ----------------------------------------------------
green "Building audio track from beats..."
AUDIO_LIST="$TMP_DIR/audio-list.txt"
: > "$AUDIO_LIST"
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('$MANIFEST','utf-8'));
  const lines = m.beats.map(b => \`file '$AUDIO_DIR/\${b.file}'\`).join('\n');
  fs.writeFileSync('$AUDIO_LIST', lines + '\n');
"
AUDIO_OUT="$TMP_DIR/audio.mp3"
rm -f "$AUDIO_OUT"
ffmpeg -hide_banner -loglevel warning -f concat -safe 0 -i "$AUDIO_LIST" -c copy "$AUDIO_OUT"
green "Audio: $AUDIO_OUT ($(du -h "$AUDIO_OUT" | cut -f1))"

# ----- final mux ------------------------------------------------------------
FINAL="$OUT_DIR/final.mp4"
rm -f "$FINAL"
green "Muxing → $FINAL"
ffmpeg -hide_banner -loglevel warning \
  -i "$VIDEO_RAW" -i "$AUDIO_OUT" \
  -c:v copy -c:a aac -b:a 192k -shortest \
  "$FINAL"

green "✅ done: $FINAL ($(du -h "$FINAL" | cut -f1))"
echo "Preview: open $FINAL"
