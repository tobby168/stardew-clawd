# Approach

## What this is

**Stardew Clawd** — a desktop app that visualizes running Claude Code sessions
as Stardew Valley-style pixel-art office workers, and lets you drive Claude
(send prompts, approve/deny tool calls) by clicking on a worker. No terminal
required.

The idea: clone Stardew's vibe, give Claude Code session monitoring a soul.
Built on top of Claude Code's own hook + headless surface.

## Key decisions and tradeoffs

- **Hooks as a bidirectional channel — but only where it earns its keep.**
  The original sketch used `node-pty` to wrap the CLI. Better: install hooks
  that POST events to a local daemon. The first pass intercepted **every**
  `PreToolUse` and showed an allow/deny prompt — that turned out to be wrong
  twice over: it fought the user's normal permission settings (bypass mode
  should *bypass*), and it added a round-trip to every tool call. The fix
  was to narrow the `PreToolUse` matcher in `.claude/settings.json` to
  `AskUserQuestion|ExitPlanMode` only — Claude's two *intrinsically
  interactive* tools. Everything else (Bash/Edit/Read/Bash/etc.) never
  round-trips to the daemon at all. `PostToolUse` / `Notification` / `Stop`
  stay wide-open for observation. The interactive ones still use the
  decision-JSON pattern (see below), but it's now in service of a real
  product action — getting the user's answer — not a permission gate.
  New user turns flow via `claude --resume <id> -p "<message>"
  --output-format stream-json --verbose`, parsed live. No pty, no ANSI
  parsing.

- **Interactive tool intercept via `deny + additionalContext`.** When Claude
  calls `AskUserQuestion`, the daemon parses the structured question payload
  (header, question text, options, multi-select flag) and surfaces it in the
  Stardew side panel as a real form — option chips, multi-select checkboxes,
  "Other" free-text. Claude's native UI is suppressed; the office *is* the
  question surface. When the user submits, the daemon resolves the still-
  blocking PreToolUse hook with `permissionDecision: "deny"` and an
  `additionalContext` string phrased so Claude reads it as the answer
  ("The user answered… Treat this as the authoritative answer and continue.
  Do NOT call AskUserQuestion again for these questions."). `ExitPlanMode`
  uses the same pattern: parchment-styled plan preview + Accept (`allow` +
  feedback) / Reject (`deny` + revision prompt). The templates live in
  [config/interactive-tools.json](config/interactive-tools.json) so the wording
  is tunable without touching code.

- **Intercept policy: app-spawned only by default.** A subtle but
  load-bearing scoping rule on top of the intercept above. `external`
  sessions (Claude Code running in the user's own terminal) bypass the
  intercept entirely — the daemon `allow`s the hook and lets Claude's
  native TUI render the question card. App-spawned workers (headless
  `claude -p`) always intercept since they have no native UI. Reasoning:
  if you launched the session in a terminal, that terminal *is* where
  you are — forcing you to the Stardew panel hides the prompt from
  where it's expected. Symptom that prompted the fix: in `--global`
  mode, a question appeared in the office but vanished from the
  terminal, with no read-only hint that anything was happening there.
  The behavior is configurable via `interceptExternalSessions` in
  [config/interactive-tools.json](config/interactive-tools.json) for
  the "magical, all sessions in one panel" demo path.

- **One process per session\_id at a time.** Claude Code's docs warn that
  concurrent resumes interleave the transcript — so the daemon enforces a
  busy/idle state machine and disables the UI's send button while a session is
  running.

- **Electron + Vite + React + PixiJS.** PixiJS for the canvas (sprite tinting,
  ticker-driven 8fps animation, integer-scale pixel rendering). React for the
  panel. Electron's main process is also the daemon — single binary, single
  port range.

- **Procedurally-generated pixel sprites, not a downloaded asset pack.** itch.io
  download flows aren't scriptable and the day's clock favored shipping a
  cohesive look I fully control. Sprites are drawn to an offscreen
  `<canvas>` at native pixel resolution (16×16 / 16×24) and uploaded as PixiJS
  textures at startup. Warm Stardew-ish palette, hard-cut frames, no outlines.
  3 hand-coded character variants (brunette / ginger / blonde) plus per-session
  shirt tint give visual variety. **11 sprite rows** map worker display states
  to animations (idle / typing / bash / reading / writing / looking_up /
  waiting_approval / walking / drinking_coffee / thinking / holding_sign),
  plus **8 overlay frames** (`?` signboard, plan scroll, thought bubble,
  coffee steam, helper pop, etc.) drawn above the worker.

- **CDP-attachable dev mode.** In development the Electron main process exposes
  a Chrome DevTools Protocol endpoint (`--remote-debugging-port=9222`), so a
  Playwright script (`scripts/playwright/attach.mjs`) can autonomously
  screenshot, click "Hire Worker", inspect rendered state, and resolve approval
  prompts — without a human in the loop. Used heavily during build-out for
  fast iteration; gated to dev so it never ships in a packaged build.

- **Project-local hooks by default.** Hooks install into `.claude/settings.json`
  in the project root, so the daemon only sees sessions launched from this
  project. `--global` opt-in installs to `~/.claude/settings.json` for the
  "magical, all sessions" demo. The split exists because of an incident: I
  ran the global install during development and the daemon started intercepting
  my own Claude Code session — five-minute auto-deny timeouts. Project-local
  scope makes the safe path the default.

- **`additionalContext` on deny.** When the user denies a tool with a reason, the
  daemon emits `permissionDecision: deny` + `additionalContext: "<reason>"`.
  Claude reads it as a follow-up instruction and pivots to an alternative
  approach — turning a "no" into a productive course-correction.

- **No hard-coded values.** Per the user's standing rule, every port, path,
  timeout, tool-mapping, animation FPS, desk position, FSM threshold, etc.
  lives in a config file under `config/`.

## Worker state machine + pacing

This is the heart of the visualization. Claude can fire 10+ tool calls in
a few seconds; naively binding each `PreToolUse` to a sprite state would
make the worker teleport between desks, bookshelves, and coffee station
every frame. The FSM is built around a two-layer model:

- **Intent layer** — the latest truth. Updated immediately on every hook
  (`session.activity` in [src/main/session-store.ts](src/main/session-store.ts)).
- **Display layer** — what the sprite is actually doing. Advances on a
  controller tick toward intent, applying smoothing rules. Lives in
  [src/renderer/scene/worker-fsm.ts](src/renderer/scene/worker-fsm.ts), one
  instance per worker, driven by the PixiJS ticker.

### State catalog (17 display states)

| State | Where | Trigger |
|---|---|---|
| `spawning` | door → assigned desk | `SessionStart` |
| `at_desk_idle` | desk | post-`Stop`; default rest |
| `at_desk_thinking` | desk | between tools; `UserPromptSubmit`; thought-bubble overlay |
| `at_desk_typing` | desk | generic tool (fallback) |
| `at_desk_coding` | desk | Edit/Write/MultiEdit/NotebookEdit |
| `at_desk_reading` | desk | Read/Grep/Glob/TodoWrite |
| `at_desk_bash` | desk | Bash |
| `walking_to_bookshelf` | desk → bookshelf | sustained WebFetch/WebSearch intent |
| `at_bookshelf` | bookshelf prop | doing the web lookup |
| `walking_to_coffee` | desk → coffee machine | sustained idle + `Notification` |
| `at_coffee` | coffee prop | drinking, sips animation |
| `walking_back_to_desk` | * → desk | tool finished |
| `holding_question` | desk | intercepted `AskUserQuestion`; sign overlay |
| `holding_plan` | desk | intercepted `ExitPlanMode`; scroll overlay |
| `done` | desk | `Stop` fired |
| `leaving` | desk → door | `SubagentStop` fired — helper walks out |
| (removed) | — | reaches door → daemon despawns the session |

### Pacing rules

The controller (`WorkerFsm.step`) runs on every PixiJS ticker frame and
applies these in order:

1. **Coalesce bursts.** Multiple intent changes within `burstWindowMs`
   (default 800ms) collapse to a single intent. Inside a burst the highest
   priority wins (`waiting_question` > `coding` > `bash` > `reading` >
   `looking_up` > `typing` > `thinking` > `idle`) — "the user is editing"
   beats "the user is reading" in a mixed batch.
2. **Honor `minDwellMs`.** Each state has a configured minimum dwell time
   (desk poses 400–600ms, `at_coffee` 2000ms). The display state will not
   transition until dwell is satisfied. Prevents flicker on burst tails.
3. **Walks are atomic.** Once `walking_to_bookshelf` starts, the worker
   **must arrive** before any new state can take effect. New intents queue
   up; on arrival the FSM re-evaluates and may immediately walk back —
   but the walk-out itself never gets canceled mid-tile.
4. **Sustained intent required for walks.** Bookshelf and coffee trips
   only commit if the relevant intent has held for `walkCommitMs`
   (1200ms). A single WebFetch followed instantly by an Edit just plays
   `thinking → coding`; the worker never gets up. No pointless trips.
5. **Blocking interactions skip pacing.** `holding_question` /
   `holding_plan` transition immediately — Claude is already stalled
   waiting for the answer, so visual latency would just slow you down.
6. **Errors are overlays, not state changes.** A `frustrated` "!" or
   helper-pop emote is drawn on top of whatever the worker is doing.
   It doesn't consume dwell time or reset the FSM.

Walk position is a straight-line tween (no pathfinding — the floor is
open) over `walkSpeedTilesPerSec` (4 tiles/sec). Direction flips via
horizontal sprite scale. All thresholds in
[config/worker-fsm.config.json](config/worker-fsm.config.json).

### Subagent visualization

When a new `session_id` appears (Claude spawned a `Task` subagent), the
helper walks in from the door and sits at an available desk like any
other worker, tagged `[ext]`. When `SubagentStop` fires, the daemon
marks the session `isSubagent: true` (label flips to `[sub]`) and sets
activity `leaving`. The FSM walks the helper to the door waypoint; on
arrival the renderer hits `/sessions/despawn` and the sprite is torn
down. Captured frame-by-frame at [scripts/snap-subagent.mjs](scripts/snap-subagent.mjs).

## Session panel — transcript view

Two gaps made the side panel hard to read in practice: Claude's own text never
appeared for external sessions, and a single busy turn could produce 20+ raw
tool rows that buried the conversation.

- **External sessions get assistant text via JSONL tail.** The hook system
  delivers `UserPromptSubmit`, `PostToolUse`, and `Stop` — but no hook carries
  the model's reply text. Claude Code writes every turn to a JSONL transcript at
  `transcript_path` (present on every hook payload). The new
  [`TranscriptTailer`](src/main/transcript-tailer.ts) polls that file with
  `fs.watchFile` at a configurable `tailPollMs` interval, reads new bytes with a
  byte-offset cursor, and emits only `assistant_text` entries — hooks already
  cover everything else, so emitting them here would duplicate. The tailer starts
  idempotently from `hook-server.ts` on the first payload that carries a path,
  and stops when the session is removed. App-spawned sessions are guarded out
  inside the tailer (the stream-json runner already delivers their text in real
  time). The per-line parser reuses the exported `handleStreamLine` from
  [`stream-json-parser.ts`](src/main/stream-json-parser.ts) — the JSONL file
  uses the same `type:'assistant'` / `message.content[]` envelope as the
  `--output-format stream-json` stdout events, with only inert fields (`uuid`,
  `timestamp`) wrapping the relevant payload.

- **Consecutive tool entries fold into a single chip.** `groupTranscript` in
  [`SessionPanel.tsx`](src/renderer/panel/SessionPanel.tsx) groups any run of
  `tool_use` / `tool_result` entries into a `tool_group` row. Collapsed, the
  chip shows a call count ("12 calls") and up to three tool summaries with
  overflow ("Grep: pickSeat · Read: foo.ts · +10 more"). Expanded on click, the
  full entries render in a bordered body. The count logic uses `tool_use` events
  when available and falls back to `tool_result` count for external sessions
  (whose PreToolUse matcher is narrowed to `AskUserQuestion|ExitPlanMode`).
  Knob: `ui.transcript.foldToolGroups` in
  [`config/app.config.json`](config/app.config.json).

- **The demo-mode mutation bug.** While wiring up the test helper
  `window.__office.append()`, an initial version both pushed to
  `s.transcript` and emitted `session.transcript_appended`. The demo's
  `subscribe` snapshot passes `SessionState` references directly, so the
  React store's `s.transcript` is the same array. The reducer's
  `[...s.transcript, e.entry]` then appended a second time — every entry
  rendered twice and React threw duplicate-key warnings. Rule going forward:
  demo-mode helpers must only `emit()`, never mutate store objects. The helper
  also switched from `Date.now()+Math.random().slice(2,8)` to a monotonic
  `nextEntryId++` counter to avoid key collisions under rapid-fire appends.

All knobs in [`config/app.config.json`](config/app.config.json) under
`ui.transcript`: `foldToolGroups`, `tailExternal`, `tailPollMs`,
`tailReadFromStart`.

## Visuals — the Stardew bar

The whole pitch hangs on the aesthetic. The visual budget went into:

- **Staggered wood-plank floor** with grain, knots, scuffs, and a 1px shadow
  under the wall. Each plank row is offset by half a plank like a real floor.
- **Wood-paneled upper wall** with vertical grooves and a chair-rail trim.
  Warm-beige lower wall with a baseboard. Picture frames (tiny landscape
  scenes) and wall sconces (yellow bulb + cast glow) frame the window.
- **Window with cross-mullion and curtains**, and a sky that swaps between
  a day texture (blue gradient + white cloud puffs) and a night texture
  (dark navy + scattered stars + a 6×6 moon disc with a highlight/shade for
  volume), driven by the wall clock. The indoor scene stays at natural warm
  brightness — only the patch visible through the window reflects time of
  day, the way it would in a real room. The cross-mullion is baked into
  both overlays so the panes read correctly instead of looking like a
  sticker pasted over the window.
- **Diamond-pattern area rug** with a stripe inset, fringe pixels, and
  embedded diamond glyph in cream.
- **Bookshelf** with multi-color book spines (red/blue/green/orange/purple),
  trim, and a floor shadow.
- **Two plant varieties** (leafy fern with a red berry, spike with a small
  bloom) — different pots, different leaf shading.
- **Coffee machine** with a red display, spout, cup catch, and beans.
- **Desk** with a monitor (code lines on the screen), keyboard with key
  highlights, mug, paper stack, and a green power LED.
- **Three character variants** — brunette/short, ginger/curly, blonde/bob —
  each with eye whites, pupils, cheek highlights, drop shadow at feet, and
  hand-tuned arm/leg positions for each of the 11 animation rows. The
  walking row uses a 2-frame leg stagger + body bob; drinking has a 3-frame
  mug-to-lips sequence; thinking has a hand-on-chin pose with subtle head
  bob; holding_sign raises both arms forward to "hold" the overlay sign.
- **Overlay sprites** above the worker for at-a-glance status — `?`
  signboard during `AskUserQuestion`, a scroll during `ExitPlanMode`, a
  cream thought-bubble while thinking between tools, a coffee-cup steam
  icon during the coffee break, and a "+1" helper-pop burst for subagents.
  Drawn as separate sprites (not part of the worker sheet) so they don't
  inherit the worker's session-tint.
- **Selection halo + chevron arrow** above the selected worker, both pulsing
  in sync (16-frame loop).
- **Ambient dust motes** — 8 floating particles drifting across the room,
  twinkling on a sine, wrapping when they exit. Cheap "lived-in" feel.
- **Stardew-style interaction dialog** — wood frame border, cream paper
  fill, drop shadow, pop-in animation, and Stardew-tone buttons. Two
  variants: an `AskUserQuestion` card (option chips with selected-state
  styling, multi-select support, "Other" free-text fallback) and an
  `ExitPlanMode` card (parchment-styled plan preview + feedback textarea
  + Accept/Reject).

## Status bar — live Claude Code quota

A floating Stardew-style chip overlays the top-right of the scene with the
real-world clock, 5-hour + weekly quota bars, workers busy/idle, and an
auth-status hint. The interesting part is where the quota numbers come from.

- **No `/usage` endpoint.** Claude Code's `/usage` view is a TUI command;
  there's no programmatic equivalent. The actual mechanism is that the TUI
  reads quota state off response headers on every Anthropic API call —
  `anthropic-ratelimit-unified-{5h,7d,7d_opus,7d_sonnet}-{utilization,reset}`.
  The daemon piggybacks: every 5 minutes (configurable) it sends a 1-token
  `/v1/messages` probe and parses those headers. Cost is roughly 10k
  tokens/day at idle — negligible against the 200k+/week subscription
  window the bars track.

- **Auth resolution chain.** `ANTHROPIC_OAUTH_TOKEN` env → macOS Keychain
  (`security find-generic-password -s "Claude Code-credentials"`) →
  `ANTHROPIC_API_KEY` env fallback. The unified headers only come back on
  Pro/Max OAuth; API keys return the classic per-minute
  `anthropic-ratelimit-{tokens,requests,…}-{limit,remaining,reset}` family.
  On an API-key fallback the chip shows them honestly with a "5h/weekly
  bars require Pro/Max OAuth" note instead of pretending the data is
  there.

- **Token refresh via the CLI itself.** Access tokens expire in ~8h. Rather
  than embed a `client_id` or reverse-engineer Anthropic's refresh
  endpoint, the daemon piggybacks on Claude Code's own OAuth flow: when
  the cached `expiresAt` is within 120s, it spawns `claude -p ping`. The
  CLI auto-refreshes and writes the new token back to the same keychain
  entry, which the next poll re-reads. Zero new dependency (the CLI is
  already how the keychain entry got there in the first place), and the
  approach automatically tracks Anthropic's endpoint changes. Port of
  [HermannBjorgvin/Clawdmeter#32](https://github.com/HermannBjorgvin/Clawdmeter/pull/32).
  Visible side-effect: the refresh probe shows up briefly as an `[ext]`
  worker in the office, which is dogfood — the visualizer is watching
  itself.

- **Fails open at every layer.** Keychain denied → fall through to API
  key. CLI missing → log once, return stale token. Refresh process hangs
  → kill after 60s, return what we have. Refresh exits non-zero (refresh
  token also revoked) → surface the OAuth error as a chip-side hint
  ("Claude Code OAuth expired — run `claude auth login`") and demote to
  API key for the per-minute view. The chip never goes blank.

- **The reverse-engineering caveat that bit me.** First implementation
  looked up `anthropic-ratelimit-unified-five_hour-utilization` based on
  identifier strings found inside the bundled `cli.js`. Those turned out
  to be the parsed `rateLimitType` enum names — internal state, not the
  wire format. The actual headers are abbreviated (`5h`, `7d`, `7d_opus`,
  `7d_sonnet`). Caught by cross-referencing Clawdmeter's working Python
  daemon. Worth filing under "extracted strings ≠ HTTP wire format."

- **Empty-string env-var trap.** A subtler bug: the parent shell exports
  `ANTHROPIC_API_KEY=""` (Electron inherits it), and my fallback used
  `process.env[key] ?? dotenv[key]`. `??` only treats null/undefined as
  nullish, so the empty string tunneled through and shadowed the real
  value from `.env`. Fixed with a `pickEnv` helper that uses `||` —
  empty-string-as-missing is the right semantics for credential lookup.

- **Renderer side.** A small React component overlays the canvas (absolute
  position inside `.scene-pane`), styled to match the existing
  `approval-banner` wood-frame aesthetic — same box-shadow stack, same
  cream paper fill, same palette. The chip listens for `usage.updated`
  events on the existing WS channel and updates without re-rendering the
  Pixi scene.

- **All knobs in config.** Poll cadence, refresh buffer, model colors,
  keychain service name, probe model — every value lives in
  [config/status-bar.config.json](config/status-bar.config.json).

## Multi-room office + camera (pan / zoom / centroid recenter)

The original room was a fixed 16×11 tilemap drawn into a single bg texture
and integer-scaled up to ≤2× and centered inside `.scene-pane` —
letterboxed in dark padding, capped at 6 desks. That was fine for the demo
session count but broke down once subagents could push the population to
20–30 workers. The whole spatial layer was rebuilt around a real camera
over a world that grows with the worker count.

- **World grows with workers.** Six themed room templates in
  [config/world.config.json](config/world.config.json) — office, library
  (multiple bookshelves), lounge (multiple coffee machines), windowed
  corridor (wall of windows), then office/library variants. At any moment
  the renderer activates `ceil(workers / workersPerRoom)` rooms, re-bakes
  the bg texture from `makeOfficeBackground(rooms[])`, and the total
  world width grows accordingly. The daemon picks desks in declared order
  (first-available, not hash-shuffled) so rooms fill sequentially —
  hiring more workers visibly expands the office.

- **Float camera on the world Container.** `Office.tsx` owns a
  `CameraState` ref (`{ scale, offsetX, offsetY, targetScale,
  targetOffsetX, targetOffsetY, worldWidth/HeightPx,
  viewportWidth/HeightPx, userOverrodeScale }`) lifted to App so the zoom
  slider can mutate it without prop drilling. Each ticker frame lerps live
  values toward targets with `centroidLerpSpeed=0.08`, then applies
  `world.scale.set(cam.scale)` and `world.position.set(round(cam.offsetX),
  round(cam.offsetY))` — rounding only the final position, never the
  scale, so fractional zoom stays smooth while pixels stay aligned.
  Replaces the old integer "fit-and-center" recenter (since deleted).

- **Auto-fit at startup to fully cover the viewport.** The default scale
  is `max(defaultZoom, fitToFill)` where `fitToFill = max(viewportW/worldW,
  viewportH/worldH)` — capped at `autoFitMaxZoom` (separate from the
  slider's `maxZoom` so the camera can scale above 8× to cover a tall
  viewport even when the user's slider can't). With one 16×16 room and a
  900×724 scene-pane this resolves to 3.516×; with 30 workers across six
  rooms it falls to ≈1× (world wider than viewport, vertical fills).

- **Recenter on centroid, not on every frame.** Driven from the
  session-sync `useEffect` so the lerp only re-targets on spawn/despawn,
  not every render. Centroid is the mean of `(sitX, sitY)` across all
  active desks. The first ever recenter is a `hardCut` (no swoop on
  startup). Once the user touches the slider, `userOverrodeScale=true`
  and auto-fit stops overriding — their zoom choice sticks.

- **The clampCameraTargets bug that wasted an hour.** First version
  centered horizontally only when `world*scale < viewport` (strict less
  than) and otherwise allowed `edgePaddingTiles=4` of overshoot for nicer
  drag. With auto-fit, world*scale equals viewport exactly — falls into
  the else branch — recenter pulls toward the worker at desk-1, clamps at
  `+edgePadding*scale`, leaves the world's left edge inside the viewport.
  Result: dark stripe down the left of the scene. Fix: split clamping
  into two functions — `clampCameraTargets` (used by recenter) is strict,
  no overshoot, `≤` instead of `<`; `clampCamera` (used during live drag)
  keeps the overshoot allowance for feel. Diagnosed by attaching
  Playwright over Electron's CDP at port 9222 and reading `cam.offsetX`
  directly via a `window.__camera` dev hook. Captured at
  [scripts/electron-inspect.mjs](scripts/electron-inspect.mjs).

- **Rooms are 16 rows now, not 11.** Five extra rows of floor below the
  desks give the camera vertical headroom so panning doesn't immediately
  reveal the world's edge. The wall area stays 3 rows; the floor
  extension is bare (workers walk freely; nothing to draw beyond the
  staggered planks already there). Door waypoint at `y=9.5` still works
  — drop-in.

- **Drag-to-pan with click-vs-drag disambiguation.** Stage-level pointer
  events on `app.stage` with `hitArea = app.screen` (required to fire
  over empty space). Drag state on `refs.current.dragState`; on
  `pointermove` with active drag we set `offsetX/Y` directly (1:1 with
  cursor — no lerp during drag for tracking feel) and mark `moved=true`
  past `clickDragThresholdPx=3`. Worker/desk `pointertap` handlers
  early-return if `dragState.moved`, so you can pan over a worker without
  accidentally selecting them.

- **Fractional zoom stays crisp.** Every texture produced by
  `sprite-factory` runs through `makeTex(canvas)` which forces
  `source.scaleMode = 'nearest'`. Without this, Pixi defaults to linear
  filtering between integer scales and the pixel art turns to mush.

- **Per-instance waypoints.** With many rooms there are many bookshelves
  and coffee machines. `WorkerFsm` takes a `WaypointProvider` (a function
  returning live arrays of `doors`, `bookshelves`, `coffeeMachines`) and
  picks the **nearest** by Euclidean distance each time it commits to a
  walk. Waypoints are derived from the decoration list of each active
  room — when a room is appended the cache refreshes and existing
  workers immediately see the new bookshelf as an option. The
  single-instance waypoints in `worker-fsm.config.json` are kept only as
  fallbacks when the world config is missing one.

- **Floating Stardew zoom slider on the left.**
  [ZoomSlider.tsx](src/renderer/scene/ZoomSlider.tsx) is a pure React
  component absolutely-positioned over `.scene-pane` — a vertical
  `<input type="range">` plus +/− buttons, styled to match the status
  bar's wood frame (same box-shadow stack, cream pill, brown trim).
  Mutates `cameraRef.current.targetScale` via `setCameraZoom(cam,
  newScale)`, which also anchors the zoom on the viewport center so the
  world point under the middle stays fixed across zoom changes
  (otherwise the world appears to drift on slider).

- **Worker name chips in screen space.** The original labels were 7px
  monospace text parented to the world container — at 0.5× zoom they
  shrank to 3.5px and became unreadable. Each bundle now owns a
  `NameChip` (Container with Graphics background + Text) parented to a
  `uiOverlay` Container that sits as a sibling of `world` on the stage.
  The ticker projects each worker's world position through the camera
  transform each frame and assigns it to the chip's screen position, so
  chips render at a constant 11px Stardew plaque (cream pill, brown
  frame, dark drop shadow) regardless of zoom. The chip itself doesn't
  intercept pointer events (`eventMode='none'`), so dragging or clicking
  through it still hits the worker beneath.

- **Demo mode for browser-only previews.** When `window.stardew` is
  absent ([demo-mode.ts](src/renderer/demo-mode.ts)) the DaemonClient
  switches to a synthetic session generator — auto-spawns workers,
  cycles their activity, exposes
  `window.__office.{spawn,despawn,set,clear,list}` for poking from
  devtools. Lets the renderer-only `npm run preview` (vite on port
  5174) be a useful visual demo without requiring Electron.

- **All knobs in config.** Per the no-hard-coded rule:
  [config/camera.config.json](config/camera.config.json) holds zoom
  range, slider step, drag sensitivity, edge padding, centroid lerp
  speed, the first-spawn-hard-cut flag, autoFitMaxZoom, click/drag
  threshold. World layout in `world.config.json` —
  `growth.workersPerRoom`, `wallThickness`, per-room
  cols/rows/desks/decorations.

## What I intentionally left out

- **Windows support.** macOS + Linux only. Path handling is POSIX-friendly.
- **Persistence across app restarts.** Daemon state is in-memory. SessionStart
  hooks re-register active sessions on restart.
- **NPC schedules / audio.** Both P2 stretch in the plan. Day/night
  shipped — earlier as a world-wide `ColorMatrixFilter` that tinted
  everything, then replaced with a per-window sky overlay (see Visuals)
  once it was clear the right answer was "indoor lighting is electric
  and constant; only what's *outside* the window reflects time." Sprite
  locomotion shipped — see the state-machine section. Multi-room
  shipped — see the camera section. Scheduled NPC routines (the cleaner
  walks through at 5pm, etc.) would be the next big visual layer.
- **Real Stardew assets.** No reverse-engineering of the proprietary game's
  spritesheets. The look is "inspired by" via palette, proportions, and
  animation cadence.
- **Live terminal pane (xterm.js) per worker.** Out of scope.
- **Fork-on-resume.** We only resume in-place.

## What breaks first under pressure

- **Concurrent resume corruption.** If the user types in a terminal while the
  daemon is mid-resume on the same session, transcripts interleave. The
  busy/idle gate prevents this from the daemon side, but a determined user can
  race it.
- **Auth: subscription ≠ API key.** Headless `claude -p` makes direct calls
  to `api.anthropic.com` and requires an Anthropic Console API key. The
  claude.ai subscription OAuth that the interactive Claude Code uses won't
  authenticate the API path. The daemon strips Claude Code's SDK env vars
  on spawn and layers `ANTHROPIC_API_KEY` from `.env` on top, so a real key
  in `.env` (see `.env.example`) makes spawned claudes
  authenticate cleanly. Without that, the worker still appears, animations
  still play, and the transcript shows a clean 401 from Anthropic — the
  visual demo works either way.
- **PixiJS CSP gotcha.** Pixi v8 uses `Function()` to JIT-compile shader code,
  which the renderer's CSP disallows. The fix is to import `pixi.js/unsafe-eval`
  (a non-eval fallback shipped by Pixi). Without that import, the canvas
  silently never mounts — `app.init()` rejects after init starts. Documented in
  this codebase because the error message ("unsafe-eval required") is easy to
  miss when wrapped in PixiJS's autoDetectRenderer chain.
- **Stream-json schema drift.** Hook events fire as `system/hook_started` and
  `system/hook_response` in the stream — noisy but skippable. Real
  `session_id` is in `subtype: init`. If Claude Code restructures the
  stream-json format, the parser breaks. Unknown event types are dropped
  silently rather than crashing.
- **Hook install collisions.** `settings.json` may already contain user hooks.
  The installer deep-merges and tags every entry with `_stardewClawd: true`
  so uninstall removes only ours. Tested by surviving a coexistence with
  `vibe-island` and `clawdmeter` entries.
- **Hook matcher misregistration.** The `PreToolUse` matcher in
  `.claude/settings.json` is narrowed to `AskUserQuestion|ExitPlanMode`.
  If a careless edit (or an older copy of `install-hooks.cjs`) widens it
  back to `*`, the daemon will start gating every tool call again and
  bypass mode breaks. The `eventMatchers` map in
  [config/app.config.json](config/app.config.json) is the single source of
  truth — the installer reads it; manual edits should match. The
  interactive-queue has a defensive `allow()` fallback for tools not in
  the intercept list, so a wider matcher fails open rather than blocking,
  but the round-trip latency is still wrong.
- **Despawn race.** `SubagentStop` → `leaving` walk → renderer hits
  `/sessions/despawn` on arrival. If the user closes the window mid-walk
  the helper stays in the store until next restart (harmless — the
  SessionStore is in-memory and re-seeds from live hooks). If the daemon
  receives a fresh `PreToolUse` for the helper during the walk-out, the
  intent flips and the FSM walks them back — by design (the worker isn't
  done after all), but it's a state I'd want to test more under live
  Claude Code subagent traffic.

## Multi-scene theming

The visualization ships with five interchangeable scenes — **Cozy Office**,
**Modern Office**, **School**, **Lab**, **Construction** — selectable via a
floating recycle button at the top-left of the canvas. Click cycles to the
next scene in [config/scenes.config.json](config/scenes.config.json); the
chevron next to it opens a picker for direct selection. The chosen scene
persists across restarts in `<userData>/scene.json` via two IPC handlers
registered in [src/main/index.ts](src/main/index.ts) (`scene:get` / `scene:set`).

Scenes are defined as JSON in `config/scenes/*.config.json`. Each carries:

- A **palette** (~80 named colors, validated at load time by
  [src/renderer/scene/palette.ts](src/renderer/scene/palette.ts) —
  missing keys throw at startup, not mid-frame).
- An **outfit** descriptor (`cozy` / `modern` / `school` / `lab` /
  `construction`) that selects per-scene headwear and torso overlays drawn
  on top of the base 16×24 worker silhouette. The body rig is identical
  across scenes so the FSM positioning and walk math are untouched —
  workers gain hardhats, lab coats, school caps, or ties without any
  changes to the canonical animation rows.
- A **vocabulary** that maps each canonical `WorkerState` to a scene-
  specific display label *and* declares which decoration types serve as a
  "bookshelf-equivalent" (looking_up trip) or "coffee-equivalent" (drinking
  trip). So a school's `walking_to_coffee` walks toward a `cafeteria-counter`,
  a construction site's walks toward a `water-cooler`, and the FSM
  doesn't need to know — it just asks the WaypointProvider for the
  nearest valid target.
- Six **rooms** matching the cozy-office desk layout (`desk-1` … `desk-36`)
  so a session assigned a desk in one scene maps to the same-id desk in
  any other scene. Hot-swap is therefore a re-bake + texture-pointer
  flip; no session state is lost.

The sprite factory ([src/renderer/scene/sprite-factory.ts](src/renderer/scene/sprite-factory.ts))
used to embed a single hard-coded `PALETTE` constant. It now takes
`palette: Palette` as the first argument on every drawing function;
[src/renderer/scene/Office.tsx](src/renderer/scene/Office.tsx)'s scene-swap
effect re-bakes the background, sky, desk, worker sheets, and emote sheet
when `sceneId` changes, then re-points every existing bundle at the new
texture. The 16×16 desk and 16×24 worker rigs share textures across many
sprites, so we **never** call `destroy(true)` on those during a swap —
freeing a shared source while sprites still reference it corrupts Pixi v8's
texture batch and breaks all rendering, not just the destroyed sprite.
The unused textures are GC'd once nothing holds them; the memory hit per
swap is tiny.

Two limitations I'd revisit:

- **One world.config.json still authoritative for desk assignment.**
  The main-process `SessionStore` reads `config/world.config.json` to
  allocate `deskId` values. Every scene config repeats the same desk-id
  schema, so the assignment is correct, but a future "remove cozy-office"
  refactor needs to either parameterize the daemon by scene or move desk
  ids into a shared header.
- **All scenes share canonical decoration drawers.** The school's library
  shelf and the lab's reference archive both render as the same
  bookshelf shape with scene-specific palette colors. Adding genuinely
  novel decoration shapes (chalkboard, beaker rack, scaffolding) is a
  small additive change — extend the `switch(dec.type)` in
  `makeOfficeBackground` and the scene configs already declare the type
  names.

## What I'd build next

- **Real subagent ↔ parent affordance.** Right now subagents get their own
  desk and the link to the parent is implicit (you see them appear during
  a parent's Task call, leave on SubagentStop). A `parentSessionId` link
  + a `helperSlot` waypoint adjacent to each desk would let helpers stand
  *next to* the parent and play a high-five on completion.
- **NPC routines / second floor.** A cleaner sprite that walks through at
  5pm, an MCP-server NPC on the second floor — patterns the FSM already
  supports, but they need their own scripted intents.
- **End-of-day summary** — Stardew-style report: tools used, prompts sent,
  bookshelf trips, coffee breaks, denied questions, idle time.
- **Replay mode** — load a `transcript_path` and watch the sprite reenact
  the session in fast-forward, with the FSM driving the visual reconstruction.
- **xterm.js per-worker pane** for power users who want raw stream.
- **Multi-machine federation** — see your team's sessions in the same office.
