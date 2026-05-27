# Video recording pipeline

Automates the ~5-min submission walkthrough. TTS narration via OpenAI; screen
capture via ffmpeg; Playwright (CDP) drives the Electron UI in sync with the
audio timeline.

## One-time setup

```bash
# 1. Real OpenAI key in .env (length > 20)
grep ^OPENAI_API_KEY= .env

# 2. Grant Screen Recording to the terminal that will run record.sh
# System Settings → Privacy & Security → Screen Recording

# 3. Grant Accessibility to Terminal so osascript can read window bounds
# System Settings → Privacy & Security → Accessibility

# 4. Enable mock-session intercept (the recording uses mock workers, which are
#    "external" by default; the AskUserQuestion beat needs intercept on for
#    external sessions). The script will patch this and tell you to restart.
```

## Usage

```bash
# 1. Generate audio (idempotent; re-run with --force to redo)
node scripts/video/generate-tts.mjs

# 2. In one terminal: start the app
npm run dev          # boots Electron with CDP at :9222 and daemon at :47821

# 3. Position the Electron window where you want it on screen. The script will
#    detect its bounds and crop the recording to it.

# 4. In another terminal: record
./scripts/video/record.sh
```

Output: `scripts/video/out/final.mp4`

## How it works

- `script.json` — 21 narration beats, each with `text` + `action` key.
- `generate-tts.mjs` — POSTs each `text` to OpenAI `/v1/audio/speech` (voice
  from script.json), writes `audio/<beat-id>.mp3`, ffprobes durations into
  `audio/manifest.json`.
- `orchestrator.mjs` — Playwright `connectOverCDP` to Electron, iterates beats:
  fires the action (mock `/hook` POST, panel click, drag-pan, theme cycle),
  sleeps for the beat's audio duration, repeats.
- `record.sh` — pre-flight + ffmpeg screen capture + orchestrator + audio
  concat + final mux to mp4.

Per-beat sync is exact because each beat's wall-clock start equals
`sum(durations[0..i-1])` — same offsets ffmpeg uses when concatenating audio.

## Iterating on a single beat

```bash
# Regenerate one beat's audio (e.g. you edited the text)
node scripts/video/generate-tts.mjs --only=08-intercept-setup --force

# Smoke-test the orchestrator without recording
node scripts/video/orchestrator.mjs
```

## Files

```
scripts/video/
├── script.json           # narration + action cues (edit this to revise)
├── generate-tts.mjs      # OpenAI TTS + ffprobe duration manifest
├── orchestrator.mjs      # Playwright + mock /hook driver (shared by both pipelines)
├── record.sh             # long-form: ffmpeg + orchestrator + TTS mux
├── teaser-manifest.json  # 20s no-narration beat timing
├── record-teaser.sh      # teaser: ffmpeg + orchestrator + music mux
├── audio/                # per-beat mp3s + manifest.json (generated)
│   └── teaser-music.mp3  # royalty-free music for the teaser (drop your own here)
├── tmp/                  # intermediate video/audio (generated)
└── out/                  # final.mp4, teaser.mp4, *-web.mp4
```

## 20s teaser variant

A no-narration, music-only teaser drives the same UI via a different beat
manifest:

```bash
# 1. Drop a royalty-free track at scripts/video/audio/teaser-music.mp3
#    (or point TEASER_MUSIC=/path/to/track.mp3 when running).
# 2. With `npm run dev` running:
./scripts/video/record-teaser.sh
```

Output: `scripts/video/out/teaser.mp4` + `out/teaser-web.mp4`.

The default music shipped with this pipeline is **"Pixelland" by Kevin
MacLeod** (incompetech.com), licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). If you use it in a
public-facing video, keep the attribution intact in the video description or
README.
