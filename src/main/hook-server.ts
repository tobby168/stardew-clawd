import express, { type Request, type Response } from 'express';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { loadAppConfig } from '@shared/config';
import { activityForTool, type SessionStore } from './session-store';
import type {
  Activity,
  AnyHookPayload,
  PreToolUsePayload,
  PostToolUsePayload,
  UserPromptSubmitPayload,
  SessionStartPayload,
} from '@shared/events';
import { newTranscriptEntry } from './stream-json-parser';
import type { InteractiveQueue } from './approval-queue';
import type { ResumeRunner } from './resume-runner';
import type { TranscriptTailer } from './transcript-tailer';

export function startHookServer(opts: {
  store: SessionStore;
  approvals: InteractiveQueue;
  runner: ResumeRunner;
  tailer: TranscriptTailer;
}) {
  const cfg = loadAppConfig();
  const token = readTokenOrCreate(cfg.tokenPath);

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use((req, res, next) => {
    const origin = req.header('origin') ?? '';
    if (
      origin === '' ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      origin === 'file://'
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const auth = req.header('authorization');
    if (auth !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/hook', async (req: Request, res: Response) => {
    const payload = req.body as AnyHookPayload;
    if (!payload?.session_id || !payload.hook_event_name) {
      return res.status(400).json({ error: 'invalid hook payload' });
    }

    handleHookEvent(payload, opts).then(
      (out) => res.json(out ?? {}),
      (err) => {
        console.warn('[hook-server] error:', err);
        res.json({}); // fail-open
      },
    );
  });

  app.post('/sessions/hire', async (req, res) => {
    const { cwd, prompt } = req.body || {};
    if (!cwd || !prompt) return res.status(400).json({ error: 'cwd and prompt required' });
    try {
      const r = await opts.runner.hireWorker({ cwd, prompt });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/sessions/message', async (req, res) => {
    const { sessionId, text } = req.body || {};
    if (!sessionId || !text) return res.status(400).json({ error: 'sessionId and text required' });
    const s = opts.store.get(sessionId);
    if (!s) return res.status(404).json({ error: 'session not found' });
    if (s.status === 'busy') return res.status(409).json({ error: 'session is busy' });
    try {
      const r = await opts.runner.sendMessage({ sessionId, cwd: s.cwd, text });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/sessions/question-answer', (req, res) => {
    const { toolUseId, answers } = req.body || {};
    if (!toolUseId || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'toolUseId and answers[] required' });
    }
    const ok = opts.approvals.resolveQuestion(toolUseId, answers);
    res.json({ ok });
  });

  // Renderer signals a subagent worker reached the door — drop them from
  // the store so they disappear from the scene.
  app.post('/sessions/despawn', (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    opts.store.remove(sessionId);
    res.json({ ok: true });
  });

  app.post('/sessions/plan-decision', (req, res) => {
    const { toolUseId, accept, feedback } = req.body || {};
    if (!toolUseId || typeof accept !== 'boolean') {
      return res.status(400).json({ error: 'toolUseId and accept(bool) required' });
    }
    const ok = opts.approvals.resolvePlan(toolUseId, accept, feedback);
    res.json({ ok });
  });

  const server = app.listen(cfg.daemon.httpPort, cfg.daemon.host, () => {
    console.log(
      `[hook-server] listening on http://${cfg.daemon.host}:${cfg.daemon.httpPort} (token=${token.slice(0, 8)}…)`,
    );
  });

  return { server, token };
}

async function handleHookEvent(
  payload: AnyHookPayload,
  { store, approvals, tailer }: {
    store: SessionStore;
    approvals: InteractiveQueue;
    runner: ResumeRunner;
    tailer: TranscriptTailer;
  },
) {
  const sid = payload.session_id;
  store.ensure(sid, { cwd: payload.cwd ?? undefined });

  // Every hook payload carries `transcript_path` — start (idempotent) a tail
  // for external sessions so we can surface assistant text in the panel.
  // App-spawned sessions are skipped inside the tailer (origin guard).
  if (payload.transcript_path) {
    tailer.start(sid, payload.transcript_path);
  }

  switch (payload.hook_event_name) {
    case 'SessionStart': {
      const p = payload as SessionStartPayload;
      const s = store.get(sid);
      if (s && s.origin !== 'app-spawned') {
        store.setStatus(sid, 'busy');
      }
      if (p.model) store.setModel(sid, p.model);
      store.appendTranscript(
        sid,
        newTranscriptEntry('system', `session ${p.source ?? 'started'}${p.model ? ' (' + p.model + ')' : ''}`),
      );
      return {};
    }
    case 'UserPromptSubmit': {
      const p = payload as UserPromptSubmitPayload;
      const s = store.get(sid);
      const last = s?.transcript[s.transcript.length - 1];
      if (!last || last.kind !== 'user' || last.text !== p.prompt) {
        store.appendTranscript(sid, newTranscriptEntry('user', p.prompt));
      }
      store.setActivity(sid, 'thinking');
      return {};
    }
    case 'PreToolUse': {
      // Per .claude/settings.json matcher, this only fires for intercepted
      // interactive tools (AskUserQuestion, ExitPlanMode). All other tool
      // calls bypass this round-trip entirely.
      const p = payload as PreToolUsePayload;
      const activity = activityForTool(p.tool_name);
      store.setActivity(sid, activity, p.tool_name);
      if (approvals.isIntercepted(p.tool_name)) {
        return approvals.request({
          sessionId: sid,
          toolName: p.tool_name,
          toolInput: p.tool_input,
          toolUseId: p.tool_use_id,
        });
      }
      // Matcher mis-fire (shouldn't happen): just allow.
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      };
    }
    case 'PostToolUse': {
      const p = payload as PostToolUsePayload;
      const resp = p.tool_response as any;
      const failed =
        resp && typeof resp === 'object' &&
        (resp.error || resp.is_error || (typeof resp.exit_code === 'number' && resp.exit_code !== 0));
      store.appendTranscript(
        sid,
        newTranscriptEntry(
          'tool_result',
          failed ? `${p.tool_name} failed` : `${p.tool_name} completed`,
          p.tool_name,
        ),
      );
      // Drop intent back to "thinking" — Claude is processing the result
      // between tool calls. The renderer FSM will smooth this out.
      store.setActivity(sid, 'thinking');
      return {};
    }
    case 'Notification': {
      // Claude is waiting on user input (could be permission prompt or
      // unanswered question). We flag this as `waiting_idle` so the renderer
      // can decide whether to send the worker on a coffee break.
      store.setActivity(sid, 'waiting_idle');
      return {};
    }
    case 'Stop': {
      store.setStatus(sid, 'idle');
      store.setActivity(sid, 'done');
      return {};
    }
    case 'SubagentStop': {
      store.markSubagent(sid);
      store.setStatus(sid, 'idle');
      // 'leaving' intent: tells the renderer FSM to walk the helper out
      // through the door. The session despawns once it reaches the door
      // (the renderer requests removal via /sessions/despawn).
      store.setActivity(sid, 'leaving');
      return {};
    }
    default:
      return {};
  }
}

function readTokenOrCreate(tokenPath: string): string {
  try {
    const t = readFileSync(tokenPath, 'utf-8').trim();
    if (t) return t;
  } catch {
    // fall through
  }
  const t = createHash('sha256').update(randomBytes(32)).digest('hex').slice(0, 48);
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, t, { mode: 0o600 });
  return t;
}
