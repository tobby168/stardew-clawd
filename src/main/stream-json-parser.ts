import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { TranscriptEntry } from '@shared/events';

// claude -p --output-format stream-json emits newline-delimited JSON.
// Each line is one event. We're conservative: tolerate unknown event types.
export interface StreamJsonHandlers {
  onSessionId?: (sessionId: string) => void;
  onAssistantText?: (text: string) => void;
  onToolUse?: (toolName: string, toolInput: unknown, toolUseId: string) => void;
  onToolResult?: (toolUseId: string, output: string) => void;
  onResult?: (finalText: string) => void;
  onError?: (err: Error) => void;
}

export function parseStream(stream: Readable, handlers: StreamJsonHandlers) {
  let buf = '';

  stream.setEncoding('utf-8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        handleStreamLine(JSON.parse(line), handlers);
      } catch (e) {
        handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    }
  });
  stream.on('end', () => {
    if (buf.trim()) {
      try {
        handleStreamLine(JSON.parse(buf.trim()), handlers);
      } catch {
        // ignore trailing junk
      }
      buf = '';
    }
  });
}

// Exported so the JSONL transcript tailer (used for external sessions where
// hooks can't surface assistant text) can reuse the same shape detection. The
// JSONL file written by Claude Code happens to use the same `type: 'assistant'`
// / `message.content[]` envelope as the stream-json `assistant` event — only
// the surrounding fields (`uuid`, `timestamp`, `parentUuid`, …) differ, and
// this dispatcher ignores them.
export function handleStreamLine(ev: any, h: StreamJsonHandlers) {
  // Top-level shapes observed from claude --output-format stream-json:
  //   { type: 'system', subtype: 'init', session_id, cwd, tools, ... }
  //   { type: 'system', subtype: 'hook_started' | 'hook_response', ... }   <- noise; skip
  //   { type: 'assistant', message: { content: [ {type:'text'|'tool_use', ...} ] } }
  //   { type: 'user', message: { content: [ {type:'tool_result', ...} ] } }
  //   { type: 'result', subtype: 'success' | ..., result: '...', session_id }
  if (!ev || typeof ev !== 'object') return;

  if (ev.type === 'system') {
    // Only init carries the real session_id we want; hook lifecycle events
    // also carry session_id but firing onSessionId for them would be harmless.
    if (ev.subtype === 'init' && ev.session_id) {
      h.onSessionId?.(ev.session_id);
    }
    return;
  }

  if (ev.type === 'assistant' && ev.message?.content) {
    for (const part of ev.message.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        h.onAssistantText?.(part.text);
      } else if (part.type === 'tool_use') {
        h.onToolUse?.(part.name, part.input, part.id);
      }
    }
    return;
  }

  if (ev.type === 'user' && ev.message?.content) {
    for (const part of ev.message.content) {
      if (part.type === 'tool_result') {
        const text =
          typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? part.content.map((c: any) => c?.text ?? '').join('')
              : '';
        h.onToolResult?.(part.tool_use_id ?? '', text);
      }
    }
    return;
  }

  if (ev.type === 'result') {
    if (typeof ev.result === 'string') h.onResult?.(ev.result);
    if (ev.session_id) h.onSessionId?.(ev.session_id);
    return;
  }
}

export function newTranscriptEntry(
  kind: TranscriptEntry['kind'],
  text: string,
  toolName?: string,
): TranscriptEntry {
  return {
    id: randomUUID(),
    ts: Date.now(),
    kind,
    text,
    ...(toolName ? { toolName } : {}),
  };
}
