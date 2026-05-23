import { loadInteractiveToolsConfig } from '@shared/config';
import type {
  AskUserQuestionInput,
  ExitPlanModeInput,
  PendingInteraction,
  PreToolUseHookOutput,
  QuestionAnswer,
} from '@shared/events';
import type { SessionStore } from './session-store';

const cfg = loadInteractiveToolsConfig();
const INTERCEPT = new Set(cfg.intercept);

type Resolver = (output: PreToolUseHookOutput) => void;

interface Pending {
  sessionId: string;
  interaction: PendingInteraction;
  resolve: Resolver;
  timer: NodeJS.Timeout;
}

/**
 * InteractiveQueue intercepts only the PreToolUse calls for tools whose names
 * are listed in `config/interactive-tools.json` (AskUserQuestion, ExitPlanMode).
 * Every other tool call would never get here in the first place — the
 * .claude/settings.json PreToolUse matcher is narrowed to those tool names.
 *
 * Resolution path: the user clicks in the Stardew side panel, the REST
 * endpoint calls one of the `resolve*` methods, which builds a hook output
 * with `permissionDecision: 'deny'` + `additionalContext` that phrases the
 * user's answer for Claude to read on the next turn.
 */
export class InteractiveQueue {
  private pending = new Map<string, Pending>(); // keyed by toolUseId

  constructor(private store: SessionStore) {}

  /** Hook server entry-point. Returns the hook output once the user answers
   *  in the UI (or auto-denies after the configured timeout). */
  request(opts: {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
  }): Promise<PreToolUseHookOutput> {
    const { sessionId, toolName, toolInput, toolUseId } = opts;

    // Defensive: if matcher mis-fires for an un-intercepted tool, just allow.
    if (!INTERCEPT.has(toolName)) {
      return Promise.resolve(allow());
    }

    // External sessions = interactive Claude Code running in the user's own
    // terminal. They have a native TUI for AskUserQuestion / ExitPlanMode;
    // intercepting would *hide* the question from where the user already is.
    // Let the native UI handle it (the daemon still observes via PostToolUse).
    // App-spawned `claude -p` workers have no native UI, so they always
    // intercept regardless of this flag.
    if (!cfg.interceptExternalSessions) {
      const s = this.store.get(sessionId);
      if (s && s.origin === 'external') {
        return Promise.resolve(allow());
      }
    }

    const interaction = parseInteraction(toolName, toolInput, toolUseId);
    if (!interaction) {
      return Promise.resolve(allow('interactive tool input could not be parsed'));
    }

    return new Promise<PreToolUseHookOutput>((resolveOuter) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseId);
        this.store.clearPendingInteraction(sessionId, toolUseId);
        resolveOuter(
          deny('UI interaction timed out — defaulting to no answer; please ask again.'),
        );
      }, cfg.uiTimeoutSec * 1000);

      this.pending.set(toolUseId, {
        sessionId,
        interaction,
        resolve: resolveOuter,
        timer,
      });

      this.store.setPendingInteraction(sessionId, interaction);
    });
  }

  /** REST endpoint → user submitted AskUserQuestion answers in the UI. */
  resolveQuestion(toolUseId: string, answers: QuestionAnswer[]): boolean {
    const p = this.pending.get(toolUseId);
    if (!p || p.interaction.kind !== 'question') return false;
    clearTimeout(p.timer);
    this.pending.delete(toolUseId);
    this.store.clearPendingInteraction(p.sessionId, toolUseId);
    // Push intent back to a neutral "thinking" so the renderer FSM doesn't
    // re-enter the holding state on the next tick. (PostToolUse normally
    // does this, but PreToolUse-deny short-circuits PostToolUse.)
    this.store.setActivity(p.sessionId, 'thinking');

    const lines = p.interaction.questions
      .map((q, i) => `  ${i + 1}. ${q.question} → ${answers[i]?.value ?? '(no answer)'}`)
      .join('\n');
    const ctx = cfg.questionPromptTemplate.replace('{ANSWERS}', lines);
    p.resolve(deny(ctx));
    return true;
  }

  /** REST endpoint → user accepted/rejected ExitPlanMode in the UI. */
  resolvePlan(toolUseId: string, accept: boolean, feedback?: string): boolean {
    const p = this.pending.get(toolUseId);
    if (!p || p.interaction.kind !== 'plan') return false;
    clearTimeout(p.timer);
    this.pending.delete(toolUseId);
    this.store.clearPendingInteraction(p.sessionId, toolUseId);
    // Push intent back to a neutral "thinking" so the renderer FSM doesn't
    // re-enter the holding state on the next tick. (PostToolUse normally
    // does this, but PreToolUse-deny short-circuits PostToolUse.)
    this.store.setActivity(p.sessionId, 'thinking');

    const fb = feedback?.trim() ?? '';
    if (accept) {
      const ctx = cfg.planAcceptedTemplate.replace(
        '{FEEDBACK}',
        fb ? `\nAdditional notes from the user:\n${fb}` : '',
      );
      // Plans are accepted with `permissionDecision: "allow"` so Claude's own
      // ExitPlanMode flow (which transitions out of plan mode) proceeds.
      p.resolve(allow(ctx));
    } else {
      const ctx = cfg.planRejectedTemplate.replace('{FEEDBACK}', fb || '(no feedback provided)');
      p.resolve(deny(ctx));
    }
    return true;
  }

  isIntercepted(toolName: string): boolean {
    return INTERCEPT.has(toolName);
  }
}

function parseInteraction(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
): PendingInteraction | null {
  const now = Date.now();
  if (toolName === 'AskUserQuestion') {
    const input = toolInput as unknown as AskUserQuestionInput;
    if (!Array.isArray(input.questions) || input.questions.length === 0) return null;
    return {
      kind: 'question',
      toolUseId,
      requestedAt: now,
      questions: input.questions.map((q) => ({
        question: String(q.question ?? ''),
        header: String(q.header ?? ''),
        multiSelect: Boolean(q.multiSelect),
        options: Array.isArray(q.options)
          ? q.options.map((o) => ({
              label: String(o?.label ?? ''),
              description: o?.description ? String(o.description) : undefined,
            }))
          : [],
      })),
    };
  }
  if (toolName === 'ExitPlanMode') {
    const input = toolInput as unknown as ExitPlanModeInput;
    return {
      kind: 'plan',
      toolUseId,
      requestedAt: now,
      plan: String(input.plan ?? ''),
    };
  }
  return null;
}

function allow(reason?: string): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(reason ? { permissionDecisionReason: reason, additionalContext: reason } : {}),
    },
  };
}
function deny(reason: string): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      additionalContext: reason,
    },
  };
}
