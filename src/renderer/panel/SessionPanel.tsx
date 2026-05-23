import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AskUserQuestionItem,
  PendingPlan,
  PendingQuestion,
  SessionState,
  TranscriptEntry,
} from '@shared/events';
import { getClient } from '../useSessions';

// Visual rows derived from `session.transcript`:
//   - `entry`     a single user / assistant_text / system row
//   - `tool_group` a fold of N consecutive tool_use / tool_result entries
//
// Tool calls fire in bursts of 10–20+ for any non-trivial Claude turn. Folding
// them keeps the user's prompts and the model's text replies visually
// dominant — click a chip to inspect what the worker actually did.
type Row =
  | { kind: 'entry'; key: string; entry: TranscriptEntry }
  | { kind: 'tool_group'; key: string; entries: TranscriptEntry[] };

function groupTranscript(entries: TranscriptEntry[]): Row[] {
  const rows: Row[] = [];
  let buf: TranscriptEntry[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    rows.push({ kind: 'tool_group', key: `g:${buf[0].id}`, entries: buf });
    buf = [];
  };
  for (const e of entries) {
    if (e.kind === 'tool_use' || e.kind === 'tool_result') {
      buf.push(e);
    } else {
      flush();
      rows.push({ kind: 'entry', key: e.id, entry: e });
    }
  }
  flush();
  return rows;
}

function groupSummary(entries: TranscriptEntry[]): string {
  // Show up to 3 tool_use summaries; fall back to tool_result text if a group
  // only contains results (rare but possible during partial streams).
  const tools = entries.filter((e) => e.kind === 'tool_use');
  const labels = (tools.length ? tools : entries).slice(0, 3).map((e) => e.text);
  const remaining = (tools.length || entries.length) - labels.length;
  const head = labels.join(' · ');
  if (remaining > 0) return `${head} · +${remaining} more`;
  return head || 'tool activity';
}

// A "tool call" is one tool_use (paired with its tool_result when present).
// Counting use-events keeps the chip label honest even on bursts that haven't
// yet received their PostToolUse events.
function groupCallCount(entries: TranscriptEntry[]): number {
  const uses = entries.filter((e) => e.kind === 'tool_use').length;
  if (uses > 0) return uses;
  // External sessions don't get tool_use entries (PreToolUse matcher is
  // narrowed) — count results in that case so the chip still shows real
  // activity rather than zero.
  return entries.filter((e) => e.kind === 'tool_result').length || entries.length;
}

export function SessionPanel({ session }: { session: SessionState | null }) {
  if (!session) {
    return (
      <div className="side-panel">
        <h2>OFFICE</h2>
        <div className="panel-empty">
          Click a worker to talk to them. Or hit <b>Hire Worker</b> in the top bar to summon
          a new one.
          <br />
          <br />
          Workers tagged <code>[ext]</code> were launched from a terminal — finish your turn
          there, then they'll be available here.
          <br />
          <br />
          When a worker holds up a <b>?</b> sign, they're asking you something —
          your answers appear here.
        </div>
      </div>
    );
  }
  return <SessionPanelInner session={session} />;
}

function SessionPanelInner({ session }: { session: SessionState }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const lastEntryId = session.transcript[session.transcript.length - 1]?.id ?? '';

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [lastEntryId]);

  const canSend =
    session.status === 'idle' &&
    session.origin === 'app-spawned' &&
    !sending &&
    draft.trim().length > 0;

  const canSendButExternal = session.origin === 'external' && session.status === 'idle';
  const disableReason =
    session.origin === 'external'
      ? session.status === 'busy'
        ? 'External session is in their terminal — wait for them to finish their turn.'
        : 'External session is idle — sending will resume them headlessly.'
      : session.status === 'busy'
        ? 'Worker is busy.'
        : null;

  const onSend = async () => {
    setError(null);
    setSending(true);
    try {
      await getClient().send({ sessionId: session.sessionId, text: draft });
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="side-panel">
      <h2>
        {sessionFolder(session.cwd)}{' '}
        <span style={{ opacity: 0.6, fontSize: 11 }}>· {session.origin}</span>
      </h2>
      <div className="session-status">
        status: <span className={session.status}>{session.status}</span>
        {session.lastTool ? ` · last: ${session.lastTool}` : ''}
        {' · '}activity: {session.activity}
      </div>

      {session.pendingInteraction?.kind === 'question' && (
        <QuestionForm session={session} interaction={session.pendingInteraction} />
      )}
      {session.pendingInteraction?.kind === 'plan' && (
        <PlanForm session={session} interaction={session.pendingInteraction} />
      )}

      <TranscriptView session={session} transcriptRef={transcriptRef} />

      <div className="input-row" title={disableReason ?? ''}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            canSendButExternal
              ? 'sending will resume this external session…'
              : session.status === 'busy'
                ? 'worker is busy…'
                : 'type a message to the worker'
          }
          disabled={session.status === 'busy' || sending}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (canSend || canSendButExternal)) {
              onSend();
            }
          }}
        />
        <button onClick={onSend} disabled={!(canSend || canSendButExternal)}>
          {sending ? '…' : 'SEND'}
        </button>
      </div>
      {error && (
        <div style={{ color: '#ff8888', padding: '0 12px 8px', fontSize: 11 }}>{error}</div>
      )}
    </div>
  );
}

// AskUserQuestion responder. Renders each question as its own card.
function QuestionForm({
  session,
  interaction,
}: {
  session: SessionState;
  interaction: PendingQuestion;
}) {
  const [answers, setAnswers] = useState<Array<string | string[]>>(() =>
    interaction.questions.map((q) => (q.multiSelect ? [] : '')),
  );
  const [other, setOther] = useState<string[]>(() => interaction.questions.map(() => ''));
  const [submitting, setSubmitting] = useState(false);

  // Reset local state if the interaction changes (next AskUserQuestion call).
  useEffect(() => {
    setAnswers(interaction.questions.map((q) => (q.multiSelect ? [] : '')));
    setOther(interaction.questions.map(() => ''));
  }, [interaction.toolUseId]);

  const allAnswered = useMemo(
    () =>
      interaction.questions.every((q, i) => {
        const a = answers[i];
        const o = other[i].trim();
        if (q.multiSelect) return Array.isArray(a) && (a.length > 0 || !!o);
        return (typeof a === 'string' && a.length > 0) || !!o;
      }),
    [interaction.questions, answers, other],
  );

  const onPick = (qi: number, label: string, multi: boolean) => {
    setAnswers((prev) => {
      const next = [...prev];
      if (multi) {
        const cur = Array.isArray(next[qi]) ? (next[qi] as string[]) : [];
        next[qi] = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
      } else {
        next[qi] = label;
      }
      return next;
    });
  };

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const payload = interaction.questions.map((q, i) => {
        const a = answers[i];
        const o = other[i].trim();
        let value = '';
        if (q.multiSelect) {
          const arr = [...(Array.isArray(a) ? a : [])];
          if (o) arr.push(`Other: ${o}`);
          value = arr.join(', ');
        } else {
          value = o ? `Other: ${o}` : (a as string) || '';
        }
        return { value };
      });
      await getClient().answerQuestion({
        sessionId: session.sessionId,
        toolUseId: interaction.toolUseId,
        answers: payload,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="approval-banner">
      <h3>
        <span className="who" />? &nbsp;Worker is asking
      </h3>
      {interaction.questions.map((q, i) => (
        <QuestionCard
          key={i}
          q={q}
          value={answers[i]}
          other={other[i]}
          onPick={(label) => onPick(i, label, q.multiSelect)}
          onOther={(v) => setOther((p) => p.map((x, idx) => (idx === i ? v : x)))}
        />
      ))}
      <div className="actions">
        <button className="allow" disabled={!allAnswered || submitting} onClick={onSubmit}>
          {submitting ? '…' : 'ANSWER'}
        </button>
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  value,
  other,
  onPick,
  onOther,
}: {
  q: AskUserQuestionItem;
  value: string | string[];
  other: string;
  onPick: (label: string) => void;
  onOther: (v: string) => void;
}) {
  const isSelected = (label: string) =>
    q.multiSelect ? Array.isArray(value) && value.includes(label) : value === label;

  return (
    <div className="question-card">
      {q.header && <div className="question-header">{q.header}</div>}
      <div className="question-text">{q.question}</div>
      <div className="question-options">
        {q.options.map((o, i) => (
          <button
            key={i}
            className={`question-option ${isSelected(o.label) ? 'selected' : ''}`}
            onClick={() => onPick(o.label)}
            title={o.description ?? ''}
          >
            <span className="check">{isSelected(o.label) ? '●' : '○'}</span>
            <span className="label">{o.label}</span>
            {o.description && <span className="desc">{o.description}</span>}
          </button>
        ))}
      </div>
      <input
        type="text"
        className="other-input"
        value={other}
        onChange={(e) => onOther(e.target.value)}
        placeholder="Other (free text)"
      />
    </div>
  );
}

// ExitPlanMode responder: show the plan + Accept / Reject.
function PlanForm({
  session,
  interaction,
}: {
  session: SessionState;
  interaction: PendingPlan;
}) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setFeedback('');
  }, [interaction.toolUseId]);

  const send = async (accept: boolean) => {
    setSubmitting(true);
    try {
      await getClient().decidePlan({
        sessionId: session.sessionId,
        toolUseId: interaction.toolUseId,
        accept,
        feedback: feedback.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="approval-banner">
      <h3>
        <span className="who" />📜 Worker has a plan
      </h3>
      <pre className="plan-text">{interaction.plan}</pre>
      <textarea
        className="plan-feedback"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="optional feedback (passed to Claude either way)"
      />
      <div className="actions">
        <button className="allow" disabled={submitting} onClick={() => send(true)}>
          {submitting ? '…' : 'ACCEPT PLAN'}
        </button>
        <button className="deny" disabled={submitting} onClick={() => send(false)}>
          REJECT
        </button>
      </div>
    </div>
  );
}

function TranscriptView({
  session,
  transcriptRef,
}: {
  session: SessionState;
  transcriptRef: React.RefObject<HTMLDivElement>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => groupTranscript(session.transcript), [session.transcript]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="transcript" ref={transcriptRef}>
      {rows.length === 0 && <div className="transcript-entry system">no activity yet…</div>}
      {rows.map((row) => {
        if (row.kind === 'entry') {
          const e = row.entry;
          return (
            <div key={row.key} className={`transcript-entry ${e.kind}`}>
              <div className="entry-label">{labelFor(e.kind)}</div>
              <div>{e.text}</div>
            </div>
          );
        }
        const open = expanded.has(row.key);
        return (
          <div key={row.key} className={`tool-group ${open ? 'expanded' : 'collapsed'}`}>
            <button
              className="tool-group-chip"
              onClick={() => toggle(row.key)}
              title={open ? 'Click to fold' : 'Click to expand'}
            >
              <span className="chevron">{open ? '▾' : '▸'}</span>
              {(() => {
                const n = groupCallCount(row.entries);
                return <span className="count">{n} call{n === 1 ? '' : 's'}</span>;
              })()}
              <span className="chip-summary">{groupSummary(row.entries)}</span>
            </button>
            {open && (
              <div className="tool-group-body">
                {row.entries.map((e) => (
                  <div key={e.id} className={`transcript-entry ${e.kind}`}>
                    <div className="entry-label">{labelFor(e.kind)}</div>
                    <div>{e.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function labelFor(kind: string): string {
  switch (kind) {
    case 'user':
      return '› you';
    case 'assistant_text':
      return '· claude';
    case 'tool_use':
      return '· tool';
    case 'tool_result':
      return '· result';
    default:
      return '· system';
  }
}

function sessionFolder(cwd: string) {
  if (!cwd) return 'no-cwd';
  return cwd.split('/').filter(Boolean).slice(-2).join('/');
}
