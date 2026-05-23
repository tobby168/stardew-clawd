# 🌾 Stardew Clawd

> A Stardew Valley-style desktop app that visualizes your Claude Code
> sessions as pixel-art office workers — and lets you drive them from
> the office, no terminal required.

## 60-second tour

https://github.com/tobby168/stardew-clawd/releases/download/v0.1.0/stardew-clawd-intro.mp4

_(if the inline player doesn't load, [grab the mp4 from the release page](https://github.com/tobby168/stardew-clawd/releases/tag/v0.1.0))_

---

Every running Claude Code session is a worker at a desk. Tools fire,
they shift between coding, reading, bashing, thinking. Claude needs
your input and a `?` sign pops up over their head. Click them to open
a chat panel and type a message — that resumes the session headlessly
behind the scenes (`claude --resume <id> -p`). Everything is rendered
from procedurally-generated pixel sprites; no asset packs to ship.

## What it does

- **Watches Claude Code's hook events** and renders every session as a
  worker at a desk in a procedurally-drawn pixel office. Project-local
  install by default, optional `--global` install picks up every
  Claude Code session on the machine.
- **Click a worker** to open a chat panel with their live transcript.
  Type a reply and the daemon resumes that session headlessly.
- **Approve / answer tool prompts from the office.** `AskUserQuestion`
  and `ExitPlanMode` are intercepted on `PreToolUse` and surfaced as
  Stardew-style wood-frame dialogs. Answering feeds the response back
  to Claude via the hook's `permissionDecision` JSON.
- **17 display states across 11 sprite rows** — idle, typing, bash,
  reading, writing, looking up, holding sign, walking, drinking coffee,
  thinking, waiting for approval. A small FSM coalesces tool bursts
  into one dominant activity so workers don't teleport between desks.
- **Foldable side panel.** Consecutive tool calls collapse into a single
  chip with a count + overflow summary; click to expand.
- **Multi-room office, drag-pan + zoom camera.** Rooms grow as you hire
  more workers; six room templates, configurable workers per room.
- **5 interchangeable scenes** — cozy office, modern, school, lab,
  construction. Same desks, same state machine; only textures, palette,
  worker outfits, and decoration types swap.
- **Live Claude Code quota in the top-right** — 5-hour and weekly bars.
  Sent via a one-token probe every five minutes; rate-limit headers
  parsed from the response.
- **Nothing hard-coded.** Every port, threshold, FPS, palette colour,
  desk position, animation timing lives in a config file under `config/`.

## Run it (macOS / Linux desktop)

```bash
# from a normal shell (not nested inside another Claude Code session)
npm install
npm run install-hooks          # writes hooks to ./.claude/settings.json
npm run dev                    # boots the Electron app + Vite dev server

# Optional: see every Claude Code session on the machine
npm run install-hooks -- --global
```

### Production-style run

If you'd rather skip dev mode (no DevTools window, no Vite HMR, no CDP port):

```bash
npm install
npm run install-hooks
npm run build                  # bundles main + preload + renderer into out/
npm start                      # launches Electron against the built bundle
```

> This is a **desktop Electron app** — it needs a display server. It
> won't run in a headless Linux container; spin it up on a macOS or
> Linux desktop (with X / Wayland) instead.

The Electron window opens with the office. Click **+ HIRE WORKER**,
point it at any directory, give a prompt — a worker appears and starts
working. Run `claude` independently in another terminal (with
project-local hooks that path is inside this repo; with `--global`
it's anywhere) and that session shows up too, tagged `[ext]`, with
the input box enabled the moment it goes idle.

## Auth

Spawned `claude` processes need a real Anthropic API key. The daemon
loads it from `.env` and strips Claude Code's SDK env vars before
spawning, so children don't accidentally inherit a parent CC session's
restricted key.

```bash
cp .env.example .env
# put a real key in ANTHROPIC_API_KEY (console.anthropic.com)
```

If `.env` has the placeholder `sk-ant-xxxxx`, the loader skips it;
you'll see a 401 in the worker's transcript instead of a real reply.

## Demo / testing without burning API credit

```bash
# mock 4 sessions doing a realistic tool sequence (Read, Grep, Edit, Bash, …)
node scripts/playwright/mock-session.mjs --sessions=4
```

Drives the daemon with fake hook payloads — same render path as a real
session, no API calls.

## Debug helpers

Dev-mode Electron exposes CDP on `127.0.0.1:9222`. There's a tiny
Playwright wrapper:

```bash
node scripts/playwright/attach.mjs --screenshot /tmp/office.png
node scripts/playwright/attach.mjs --inspect
node scripts/playwright/attach.mjs --hire <cwd> "<prompt>"
node scripts/playwright/attach.mjs --approve | --deny
```

Used during build-out to iterate without a human in the loop.

## Uninstalling

```bash
npm run uninstall-hooks         # removes project-local hooks
npm run uninstall-hooks -- --all # also cleans ~/.claude/settings.json
```

## Architecture

If you want the full story — the FSM, the deny-plus-context intercept
trick, the JSONL tailing for external sessions, the procedural sprite
pipeline — see [APPROACH.md](APPROACH.md).

## License

MIT — do what you want, attribution appreciated.
