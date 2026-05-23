import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAppConfig } from '@shared/config';
import { activityForTool, type SessionStore } from './session-store';
import { newTranscriptEntry, parseStream } from './stream-json-parser';
import type { Activity } from '@shared/events';

const cfg = loadAppConfig();

// Load .env (project root) once at module load. We only use it to surface
// auth-relevant keys to spawned claudes — never to override the daemon's own
// runtime env. If .env is missing or unreadable, we just have no auth keys.
const ENV_FROM_DOTENV: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const tryPaths = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '.env'),
  ];
  for (const p of tryPaths) {
    try {
      const text = readFileSync(p, 'utf-8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // Skip obvious placeholders ("xxxxx", "sk-ant-xxxxx").
        if (/^sk-(ant-)?x+$/i.test(val) || /^x+$/i.test(val)) continue;
        out[key] = val;
      }
      if (Object.keys(out).length > 0) {
        console.log(`[resume-runner] loaded ${Object.keys(out).length} keys from ${p}`);
        return out;
      }
    } catch {
      // try next
    }
  }
  return out;
})();

interface RunHandle {
  child: ChildProcess;
  sessionId: string | null;
}

export class ResumeRunner {
  // Tracks running processes per sessionId so we don't double-resume.
  private running = new Map<string, RunHandle>();

  constructor(private store: SessionStore) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  // Spawn a new session: `claude -p "<prompt>" --output-format stream-json --verbose`
  // Returns a promise that resolves with the captured session_id once known.
  hireWorker(opts: { cwd: string; prompt: string }): Promise<{ sessionId: string }> {
    return this.spawnClaude({ cwd: opts.cwd, prompt: opts.prompt, resumeSessionId: null });
  }

  // Append a user turn to an existing session.
  sendMessage(opts: { sessionId: string; cwd: string; text: string }): Promise<{ sessionId: string }> {
    if (this.running.has(opts.sessionId)) {
      return Promise.reject(new Error(`session ${opts.sessionId} is busy`));
    }
    return this.spawnClaude({
      cwd: opts.cwd,
      prompt: opts.text,
      resumeSessionId: opts.sessionId,
    });
  }

  private spawnClaude(opts: {
    cwd: string;
    prompt: string;
    resumeSessionId: string | null;
  }): Promise<{ sessionId: string }> {
    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      cfg.claude.streamFormat,
      ...cfg.claude.extraArgs,
    ];
    if (opts.resumeSessionId) {
      args.unshift('--resume', opts.resumeSessionId);
    }

    const child = spawn(cfg.claude.binary, args, {
      cwd: opts.cwd,
      env: sanitizeEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // If resuming, we already know the sessionId; mark busy now.
    let capturedId: string | null = opts.resumeSessionId;
    if (capturedId) {
      this.store.ensure(capturedId, { cwd: opts.cwd, origin: 'app-spawned' });
      this.store.setStatus(capturedId, 'busy');
      this.store.appendTranscript(
        capturedId,
        newTranscriptEntry('user', opts.prompt),
      );
      this.running.set(capturedId, { child, sessionId: capturedId });
    }

    const debounceMs = cfg.ui.activityDebounceMs;
    let activityTimer: NodeJS.Timeout | null = null;
    const setActivityDebounced = (a: Activity, tool?: string) => {
      if (!capturedId) return;
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        if (capturedId) this.store.setActivity(capturedId, a, tool);
      }, debounceMs);
    };

    return new Promise<{ sessionId: string }>((resolveOuter, rejectOuter) => {
      let resolved = !!capturedId;
      const resolveOnce = (id: string) => {
        if (resolved) return;
        resolved = true;
        capturedId = id;
        this.store.ensure(id, { cwd: opts.cwd, origin: 'app-spawned' });
        this.store.setStatus(id, 'busy');
        this.store.appendTranscript(id, newTranscriptEntry('user', opts.prompt));
        this.running.set(id, { child, sessionId: id });
        resolveOuter({ sessionId: id });
      };

      parseStream(child.stdout!, {
        onSessionId: (id) => resolveOnce(id),
        onAssistantText: (text) => {
          if (!capturedId) return;
          this.store.appendTranscript(capturedId, newTranscriptEntry('assistant_text', text));
          setActivityDebounced('typing');
        },
        onToolUse: (toolName, toolInput) => {
          if (!capturedId) return;
          this.store.appendTranscript(
            capturedId,
            newTranscriptEntry('tool_use', summarize(toolName, toolInput), toolName),
          );
          setActivityDebounced(activityForTool(toolName), toolName);
        },
        onToolResult: (toolUseId, output) => {
          if (!capturedId) return;
          const trimmed = output.length > 500 ? output.slice(0, 500) + '…' : output;
          this.store.appendTranscript(capturedId, newTranscriptEntry('tool_result', trimmed));
        },
        onResult: (_finalText) => {
          // The result event repeats the last assistant_text — assistant_text
          // already streamed it in real time, so skip to avoid duplicates.
        },
        onError: (err) => {
          console.warn('[resume-runner] stream parse warning:', err.message);
        },
      });

      child.stderr?.on('data', (d) => {
        process.stderr.write(`[claude stderr] ${d}`);
      });

      child.on('error', (err) => {
        if (!resolved) {
          rejectOuter(err);
        } else if (capturedId) {
          this.store.appendTranscript(
            capturedId,
            newTranscriptEntry('system', `process error: ${err.message}`),
          );
        }
      });

      child.on('close', (code) => {
        if (capturedId) {
          this.running.delete(capturedId);
          this.store.setStatus(capturedId, 'idle');
          this.store.setActivity(capturedId, 'idle');
          if (code !== 0) {
            this.store.appendTranscript(
              capturedId,
              newTranscriptEntry('system', `claude exited with code ${code}`),
            );
          }
        }
        if (!resolved) rejectOuter(new Error(`claude exited before emitting session_id (code ${code})`));
      });
    });
  }
}

// Strip env vars that would make a child `claude` think it's running inside
// another Claude Code session (and therefore use SDK-only credentials that
// only the parent session can use). Forces fallback to the user's OAuth
// credentials in ~/.claude/.credentials.json — what a fresh `claude` would do.
function sanitizeEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // 1) Drop everything that would make a child `claude` think it's running
  //    inside another Claude Code session (and reuse the parent's SDK-only
  //    credentials, which only the parent session can use).
  const STRIP_EXACT = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDECODE',
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
    'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
    'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
    'CLAUDE_CODE_DISABLE_CRON',
    'CLAUDE_EFFORT',
    'AI_AGENT',
  ]);
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (STRIP_EXACT.has(k)) continue;
    clean[k] = v;
  }
  // 2) Layer the project's .env on top — that's where users put real API
  //    keys. If none provided, the child falls back to whatever auth the
  //    user's machine has set up.
  Object.assign(clean, ENV_FROM_DOTENV);
  return clean;
}

function summarize(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return toolName;
  const obj = input as Record<string, unknown>;
  // Pick the most relevant field per tool.
  const showFor: Record<string, string[]> = {
    Bash: ['command', 'description'],
    Read: ['file_path'],
    Edit: ['file_path'],
    Write: ['file_path'],
    Grep: ['pattern', 'path'],
    Glob: ['pattern'],
    WebFetch: ['url'],
    WebSearch: ['query'],
  };
  const fields = showFor[toolName] ?? Object.keys(obj).slice(0, 1);
  const parts = fields.map((f) => (obj[f] != null ? `${f}=${String(obj[f]).slice(0, 80)}` : ''));
  const summary = parts.filter(Boolean).join(' ');
  return `${toolName}${summary ? ': ' + summary : ''}`;
}
