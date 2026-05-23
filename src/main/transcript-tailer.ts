import { createReadStream, statSync, unwatchFile, watchFile } from 'node:fs';
import { loadAppConfig } from '@shared/config';
import { handleStreamLine, newTranscriptEntry } from './stream-json-parser';
import type { SessionStore } from './session-store';

// Claude Code maintains a JSONL transcript at ~/.claude/projects/<slug>/<sid>.jsonl
// for every session (interactive or headless). The path is delivered to us as
// `transcript_path` on every hook payload.
//
// For external sessions (Claude Code running in the user's terminal) hooks
// fire only on tool events / Stop / Notification — there is no hook that
// carries the model's assistant text. To get the AI response into the panel
// we tail that JSONL: every time the file grows we read the new lines, parse
// them with the same dispatcher the stream-json runner uses, and append
// `assistant_text` transcript entries.
//
// We deliberately *only* emit assistant_text. The hooks already produce the
// `user`, `tool_use`, `tool_result`, and `system` entries; emitting them from
// the tail too would duplicate everything.
//
// App-spawned sessions never start a tailer — the stream-json runner already
// gets assistant_text in real time via stdout, and tailing the same file would
// duplicate every text segment.

const cfg = loadAppConfig();

interface Handle {
  path: string;
  offset: number;
  buf: string;
  reading: boolean;
  pending: boolean;
}

export class TranscriptTailer {
  private handles = new Map<string, Handle>();
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
    this.store.on('event', (ev) => {
      if (ev.type === 'session.removed') this.stop(ev.sessionId);
    });
  }

  start(sessionId: string, transcriptPath: string) {
    if (!cfg.ui.transcript.tailExternal) return;
    if (this.handles.has(sessionId)) return;
    if (!transcriptPath) return;

    const s = this.store.get(sessionId);
    // Never tail app-spawned sessions — stream-json already covers them.
    if (s?.origin === 'app-spawned') return;

    console.log(
      `[transcript-tailer] starting tail for ${sessionId.slice(0, 8)}… ` +
      `path=${transcriptPath} origin=${s?.origin ?? 'unknown'}`,
    );

    let initialOffset = 0;
    if (!cfg.ui.transcript.tailReadFromStart) {
      try {
        initialOffset = statSync(transcriptPath).size;
      } catch {
        initialOffset = 0;
      }
    }

    const h: Handle = {
      path: transcriptPath,
      offset: initialOffset,
      buf: '',
      reading: false,
      pending: false,
    };
    this.handles.set(sessionId, h);

    const pollMs = Math.max(50, cfg.ui.transcript.tailPollMs);
    watchFile(transcriptPath, { interval: pollMs, persistent: false }, (curr, prev) => {
      if (curr.size > prev.size || (curr.size > h.offset && prev.size === 0)) {
        this.drain(sessionId);
      } else if (curr.size < h.offset) {
        // File rotated/truncated — reset and re-read from the new start.
        h.offset = 0;
        h.buf = '';
        this.drain(sessionId);
      }
    });

    // Initial drain (catches everything already in the file when reading
    // from the start, and gets us past startup races when reading from end).
    this.drain(sessionId);
  }

  stop(sessionId: string) {
    const h = this.handles.get(sessionId);
    if (!h) return;
    unwatchFile(h.path);
    this.handles.delete(sessionId);
  }

  stopAll() {
    for (const sid of Array.from(this.handles.keys())) this.stop(sid);
  }

  private drain(sessionId: string) {
    const h = this.handles.get(sessionId);
    if (!h) return;
    if (h.reading) {
      h.pending = true;
      return;
    }
    h.reading = true;

    let size = 0;
    try {
      size = statSync(h.path).size;
    } catch {
      h.reading = false;
      return;
    }
    if (size <= h.offset) {
      h.reading = false;
      if (h.pending) {
        h.pending = false;
        this.drain(sessionId);
      }
      return;
    }

    const stream = createReadStream(h.path, {
      start: h.offset,
      end: size - 1,
      encoding: 'utf-8',
    });
    let consumed = 0;
    stream.on('data', (chunkRaw: string | Buffer) => {
      const chunk = typeof chunkRaw === 'string' ? chunkRaw : chunkRaw.toString('utf-8');
      consumed += Buffer.byteLength(chunk, 'utf-8');
      h.buf += chunk;
      let idx: number;
      while ((idx = h.buf.indexOf('\n')) >= 0) {
        const line = h.buf.slice(0, idx).trim();
        h.buf = h.buf.slice(idx + 1);
        if (!line) continue;
        this.dispatch(sessionId, line);
      }
    });
    stream.on('end', () => {
      h.offset += consumed;
      h.reading = false;
      if (h.pending) {
        h.pending = false;
        this.drain(sessionId);
      }
    });
    stream.on('error', (err) => {
      console.warn(`[transcript-tailer] read error for ${sessionId}:`, err.message);
      h.reading = false;
    });
  }

  private dispatch(sessionId: string, line: string) {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // tolerate partial / non-JSON lines (rare during writer flushes)
    }
    handleStreamLine(ev, {
      onAssistantText: (text) => {
        if (!text.trim()) return;
        // Hook events do not deliver assistant text, so anything we emit here
        // is by definition not a duplicate of hook-driven entries.
        console.log(
          `[transcript-tailer] emit assistant_text for ${sessionId.slice(0, 8)}… (${text.length} chars)`,
        );
        this.store.appendTranscript(
          sessionId,
          newTranscriptEntry('assistant_text', text),
        );
      },
      // Intentionally no-op for everything else — hooks already cover them.
    });
  }
}
