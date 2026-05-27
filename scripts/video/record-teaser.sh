#!/usr/bin/env bash
# 20-second teaser recorder. Same machinery as record.sh — screen-capture via
# ffmpeg/avfoundation, orchestrator-driven UI actions — but no TTS narration:
# a single royalty-free music file is muxed in instead.
#
# Required:
#   $TEASER_MUSIC (env)  path to an mp3/m4a/wav. Default:
#                        scripts/video/audio/teaser-music.mp3
#                        (gitignored; drop your file there).
#
# Flow:
#   1. Pre-flight (dev running, intercept flag, music file present).
#   2. Position the Electron window and detect actual bounds.
#   3. Start ffmpeg screen capture → tmp/teaser-raw.mov
#   4. Run orchestrator with --manifest=teaser-manifest.json
#   5. Stop ffmpeg.
#   6. Mux video + music (looped/trimmed to clip duration) → out/teaser.mp4
#   7. Encode web-friendly variant → out/teaser-web.mp4
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
TMP_DIR="$SCRIPT_DIR/tmp"
MANIFEST="$SCRIPT_DIR/teaser-manifest.json"
CONFIG_PATH="$REPO_ROOT/config/interactive-tools.json"
MUSIC="${TEASER_MUSIC:-$SCRIPT_DIR/audio/teaser-music.mp3}"
SCREEN_INDEX="${STARDEW_VIDEO_SCREEN_INDEX:-4}"
FPS="${STARDEW_VIDEO_FPS:-30}"

mkdir -p "$OUT_DIR" "$TMP_DIR"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# ----- pre-flight -----------------------------------------------------------
[ -f "$MANIFEST" ] || { red "missing $MANIFEST"; exit 1; }
[ -f "$MUSIC" ]    || { red "missing music file at $MUSIC — set TEASER_MUSIC or drop a track there"; exit 1; }
command -v ffmpeg >/dev/null  || { red "ffmpeg not installed (brew install ffmpeg)"; exit 1; }
command -v ffprobe >/dev/null || { red "ffprobe not installed (comes with ffmpeg)"; exit 1; }
command -v osascript >/dev/null || { red "osascript missing — this script is macOS only"; exit 1; }

# Reset persisted scene to cozy-office so the teaser always opens on the farm look.
SCENE_FILE="$HOME/Library/Application Support/stardew-clawd/scene.json"
mkdir -p "$(dirname "$SCENE_FILE")"
echo '{ "sceneId": "cozy-office" }' > "$SCENE_FILE"
green "Persisted scene reset to cozy-office."

# Dev reachable?
if ! curl -sf "http://127.0.0.1:9222/json/version" >/dev/null; then
  red "Electron CDP not reachable at 127.0.0.1:9222 — start the app with: npm run dev"
  red "(Scene was just reset to cozy-office; restart dev so the change loads.)"
  exit 1
fi

# Intercept flag must be on for AskUserQuestion to be re-routed to a worker UI.
if ! node -e "process.exit(JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf-8')).interceptExternalSessions ? 0 : 1)"; then
  yellow "interceptExternalSessions is false — patching config; RESTART dev after this"
  node -e "
    const fs = require('fs');
    const p = '$CONFIG_PATH';
    const j = JSON.parse(fs.readFileSync(p,'utf-8'));
    j.interceptExternalSessions = true;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  "
  red "config patched. RESTART \`npm run dev\` and re-run this script."
  exit 1
fi

# ----- position the Electron window for recording --------------------------
WIN_X="${STARDEW_VIDEO_WIN_X:-0}"
WIN_Y="${STARDEW_VIDEO_WIN_Y:-28}"
WIN_W="${STARDEW_VIDEO_WIN_W:-1700}"
WIN_H="${STARDEW_VIDEO_WIN_H:-900}"

green "Positioning Stardew Clawd window to ${WIN_W}x${WIN_H} at +${WIN_X}+${WIN_Y}..."
osascript <<AS || { red "could not position window (grant Accessibility, or app not running)"; exit 1; }
tell application "System Events"
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

# Read back actual bounds (macOS/Electron sometimes snaps to a different size).
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
  WIN_X=$ACT_X; WIN_Y=$ACT_Y; WIN_W=$ACT_W; WIN_H=$ACT_H
fi
green "Window positioned at ${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}."

SCALE="${STARDEW_VIDEO_SCALE:-2}"
WIN_X=$(( WIN_X * SCALE ))
WIN_Y=$(( WIN_Y * SCALE ))
WIN_W=$(( WIN_W * SCALE ))
WIN_H=$(( WIN_H * SCALE ))
WIN_W=$(( WIN_W - WIN_W % 2 ))
WIN_H=$(( WIN_H - WIN_H % 2 ))
green "Crop (×${SCALE} for retina): ${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# ----- compute total run duration from manifest -----------------------------
TOTAL_SEC=$(node -e "
  const m = JSON.parse(require('fs').readFileSync('$MANIFEST','utf-8'));
  console.log(m.beats.reduce((s,b)=>s+b.durationSec,0));
")
green "Teaser duration: ${TOTAL_SEC}s"

# ----- start recording ------------------------------------------------------
VIDEO_RAW="$TMP_DIR/teaser-raw.mov"
rm -f "$VIDEO_RAW"

green "Starting ffmpeg recording..."
ffmpeg -hide_banner -loglevel warning \
  -f avfoundation -framerate "$FPS" -capture_cursor 0 -i "${SCREEN_INDEX}:none" \
  -c:v h264_videotoolbox -b:v 8M -pix_fmt yuv420p \
  -vf "crop=${WIN_W}:${WIN_H}:${WIN_X}:${WIN_Y}" \
  "$VIDEO_RAW" &
FFMPEG_PID=$!
trap 'kill -INT $FFMPEG_PID 2>/dev/null || true; wait $FFMPEG_PID 2>/dev/null || true' EXIT

sleep 1.5

# ----- run orchestrator -----------------------------------------------------
green "Running orchestrator (teaser manifest)..."
node "$SCRIPT_DIR/orchestrator.mjs" --record --manifest="$MANIFEST"

# Give ffmpeg ~1s after the orchestrator finishes — SIGINT'ing it immediately
# drops a few hundred ms of buffered frames, which trims the FINAL trim window
# short of TOTAL_SEC and cuts the outro's last beat in half.
sleep 1

# ----- stop recording -------------------------------------------------------
green "Stopping ffmpeg..."
kill -INT $FFMPEG_PID 2>/dev/null || true
wait $FFMPEG_PID 2>/dev/null || true
trap - EXIT

[ -s "$VIDEO_RAW" ] || { red "recording produced no output — check Screen Recording permission"; exit 1; }
green "Video raw: $VIDEO_RAW ($(du -h "$VIDEO_RAW" | cut -f1))"

# ----- mux video + music ----------------------------------------------------
# -ss 1.5 seeks past the ffmpeg-spool lead so FINAL t=0 lines up with
# orchestrator t=0 — that lets the post-prod zoom filter below key off
# absolute beat offsets (zoom fires at FINAL t=18 = orch outro start).
# Trim the music to TOTAL_SEC and add a 0.5s fade-out so the clip doesn't end
# on a hard cut. -stream_loop -1 lets short music tracks loop if needed.
FINAL="$OUT_DIR/teaser.mp4"
rm -f "$FINAL"
FADE_START=$(awk -v t="$TOTAL_SEC" 'BEGIN { printf "%.2f", t - 0.5 }')
green "Muxing → $FINAL"
ffmpeg -hide_banner -loglevel warning \
  -ss 1.5 -i "$VIDEO_RAW" \
  -stream_loop -1 -i "$MUSIC" \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a aac -b:a 192k \
  -af "afade=t=out:st=${FADE_START}:d=0.5" \
  -t "$TOTAL_SEC" \
  "$FINAL"
green "✅ done: $FINAL ($(du -h "$FINAL" | cut -f1))"

# ----- web-compressed variant + post-prod zoom-in on usage bar -------------
# Outro is the last 2s of the 20s teaser. Over t=17.5→19.5 we zoom into the
# top-right usage panel: end with z=4.5 centered on (input x=1010, y=30) so
# the bar fills ~70% of output width.
#
# Bar bounding box measured empirically on a 1700×900 scaled-down frame:
#   wood-frame outline x=1076-1321, y=88-188  (width 245, height 100, center 1198,138)
# Crop region at max zoom (z=4.5): 1700/4.5 × 900/4.5 = 378 × 200 — that's
# tight enough to hide the side panel (which starts at input x=1396) while
# keeping the bar centered.
#
# We pre-scale FINAL (3400×1800 retina) to 1700×900 before zoompan so the
# crop coords above are in the same dimension the bar was measured in.
# ffmpeg 8.x's crop filter no longer supports `eval=frame`, so we use the
# zoompan filter (purpose-built for animated crops) instead.
FINAL_WEB="$OUT_DIR/teaser-web.mp4"
rm -f "$FINAL_WEB"
green "Encoding web-friendly variant (with usage-bar zoom-in) → $FINAL_WEB"
ffmpeg -hide_banner -loglevel warning -y \
  -i "$FINAL" \
  -vf "scale=1700:900:flags=lanczos,zoompan=z='if(lt(in_time,17.5),1,1+3.5*min(1,(in_time-17.5)/2))':x='if(lt(in_time,17.5),0,1010*min(1,(in_time-17.5)/2))':y='if(lt(in_time,17.5),0,30*min(1,(in_time-17.5)/2))':d=1:s=1700x900:fps=30" \
  -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 96k -ac 1 \
  "$FINAL_WEB"
green "✅ web variant: $FINAL_WEB ($(du -h "$FINAL_WEB" | cut -f1))"
echo "Preview: open $FINAL_WEB"
