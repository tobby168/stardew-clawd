// Event types shared between main (daemon) and renderer.
// Hook payloads roughly follow Claude Code's documented schema.

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop';

export interface HookPayloadBase {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: HookEventName;
  permission_mode?: string;
}

export interface PreToolUsePayload extends HookPayloadBase {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

export interface PostToolUsePayload extends HookPayloadBase {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  tool_response?: unknown;
}

export interface UserPromptSubmitPayload extends HookPayloadBase {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface SessionStartPayload extends HookPayloadBase {
  hook_event_name: 'SessionStart';
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  model?: string;
}

export type AnyHookPayload =
  | HookPayloadBase
  | PreToolUsePayload
  | PostToolUsePayload
  | UserPromptSubmitPayload
  | SessionStartPayload;

// PreToolUse hook decision schema (what we write to stdout).
export type PermissionDecision = 'allow' | 'deny' | 'ask' | 'defer';
export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: PermissionDecision;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

// ----- Worker state machine -----
//
// `Activity` is the "intent" — the latest truth derived from hook events.
// `WorkerState` is the "display state" — what the sprite is doing right now.
// The display layer (renderer FSM) advances toward intent with min-dwell,
// burst coalescing, and atomic walk segments. See worker-fsm.config.json.

export type Activity =
  | 'idle'
  | 'typing'
  | 'bash'
  | 'reading'
  | 'writing'
  | 'looking_up'      // WebFetch / WebSearch — intent for bookshelf trip
  | 'thinking'         // between tools / model reasoning
  | 'waiting_idle'     // Notification fired, Claude is waiting on user
  | 'waiting_question' // intercepted AskUserQuestion
  | 'waiting_plan'     // intercepted ExitPlanMode
  | 'done'             // Stop fired
  | 'leaving';         // SubagentStop fired (helper walks out)

export type WorkerState =
  | 'spawning'
  | 'at_desk_idle'
  | 'at_desk_thinking'
  | 'at_desk_typing'
  | 'at_desk_coding'
  | 'at_desk_reading'
  | 'at_desk_bash'
  | 'walking_to_bookshelf'
  | 'at_bookshelf'
  | 'walking_to_coffee'
  | 'at_coffee'
  | 'walking_back_to_desk'
  | 'holding_question'
  | 'holding_plan'
  | 'done'
  | 'leaving';

export type SessionOrigin = 'external' | 'app-spawned';

export interface SessionState {
  sessionId: string;
  origin: SessionOrigin;
  cwd: string;
  status: 'busy' | 'idle' | 'done';
  // Intent (latest hook truth)
  activity: Activity;
  lastTool?: string;
  lastActivityAt: number;
  lastUserPrompt?: string;
  transcript: TranscriptEntry[];
  pendingInteraction?: PendingInteraction;
  deskId?: string;
  characterId: string;
  tint: number;
  isSubagent?: boolean; // toggled by SubagentStop receipt
  createdAt: number;
  /** Model id reported via SessionStart hook payload (e.g. claude-opus-4-7). */
  model?: string;
}

export interface TranscriptEntry {
  id: string;
  ts: number;
  kind: 'user' | 'assistant_text' | 'tool_use' | 'tool_result' | 'system';
  text: string;
  toolName?: string;
}

// ----- AskUserQuestion + ExitPlanMode payloads -----
//
// Mirror Claude Code's tool input shapes — these come straight off
// `PreToolUsePayload.tool_input` when the matched tool fires.

export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

export interface ExitPlanModeInput {
  plan: string;
}

export interface PendingInteractionBase {
  toolUseId: string;
  requestedAt: number;
}
export interface PendingQuestion extends PendingInteractionBase {
  kind: 'question';
  questions: AskUserQuestionItem[];
}
export interface PendingPlan extends PendingInteractionBase {
  kind: 'plan';
  plan: string;
}
export type PendingInteraction = PendingQuestion | PendingPlan;

// User responses sent back to the daemon.
export interface QuestionAnswer {
  // One entry per question — answers[i] aligns with questions[i].
  // For single-select, value is the chosen option label (or custom text after "Other").
  // For multiSelect, value is a comma-separated label list.
  value: string;
}
export interface ResolveQuestionRequest {
  sessionId: string;
  toolUseId: string;
  answers: QuestionAnswer[];
}
export interface ResolvePlanRequest {
  sessionId: string;
  toolUseId: string;
  accept: boolean;
  feedback?: string;
}

// ----- Usage / quota -----
//
// `unified` window data is only populated when the daemon authenticated against a
// Claude Code (Pro/Max) OAuth session; classic per-minute API-key headers are
// always populated when the probe authenticated with an ANTHROPIC_API_KEY.
// `auth` tells the renderer which path produced this snapshot so the UI can
// degrade honestly when 5h/seven-day data isn't available.
export type UsageAuthMode = 'oauth' | 'api_key' | 'none';

export interface UsageWindow {
  /** 0..1 — fraction of window consumed. */
  utilization: number;
  /** Unix seconds when the window resets. */
  resetsAt: number;
}

export interface ClassicRateLimit {
  limit: number;
  remaining: number;
  resetsAt: number; // unix seconds
}

export interface UsageSnapshot {
  /** When the daemon last successfully probed (ms epoch). 0 = never. */
  fetchedAt: number;
  auth: UsageAuthMode;
  /** Last error message from the probe, if any. */
  error?: string;
  /** Unified rate-limit windows (Pro/Max OAuth only). */
  unified?: {
    five_hour?: UsageWindow;
    seven_day?: UsageWindow;
    seven_day_opus?: UsageWindow;
    seven_day_sonnet?: UsageWindow;
  };
  /** Classic per-minute API-key headers (fallback / always present on api_key auth). */
  classic?: {
    inputTokens?: ClassicRateLimit;
    outputTokens?: ClassicRateLimit;
    tokens?: ClassicRateLimit;
    requests?: ClassicRateLimit;
  };
}

// ----- Server → renderer events -----
export type ServerEvent =
  | { type: 'snapshot'; sessions: SessionState[]; usage?: UsageSnapshot }
  | { type: 'session.upserted'; session: SessionState }
  | { type: 'session.activity_changed'; sessionId: string; activity: Activity; lastTool?: string; lastActivityAt: number }
  | { type: 'session.transcript_appended'; sessionId: string; entry: TranscriptEntry }
  | { type: 'session.interaction_requested'; sessionId: string; interaction: PendingInteraction }
  | { type: 'session.interaction_resolved'; sessionId: string; toolUseId: string }
  | { type: 'session.status_changed'; sessionId: string; status: SessionState['status'] }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'usage.updated'; usage: UsageSnapshot };

// REST commands from renderer to daemon.
export interface HireWorkerRequest {
  cwd: string;
  prompt: string;
}
export interface SendMessageRequest {
  sessionId: string;
  text: string;
}
