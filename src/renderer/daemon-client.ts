import type {
  ServerEvent,
  SessionState,
  HireWorkerRequest,
  SendMessageRequest,
  ResolveQuestionRequest,
  ResolvePlanRequest,
} from '@shared/events';
import { startDemo, type DemoController } from './demo-mode';

export interface DaemonInfo {
  httpUrl: string;
  wsUrl: string;
  token: string;
}

declare global {
  interface Window {
    stardew: {
      daemonInfo: () => Promise<DaemonInfo>;
    };
  }
}

export class DaemonClient {
  private info: DaemonInfo | null = null;
  private ws: WebSocket | null = null;
  private listeners = new Set<(e: ServerEvent) => void>();
  private snapshot: SessionState[] = [];
  private demo: DemoController | null = null;

  async connect(): Promise<void> {
    // When the renderer is loaded outside Electron (e.g. vite dev server in a
    // plain browser tab for UI work) the preload bridge is absent — switch to
    // a synthetic demo so the office is populated.
    if (typeof window === 'undefined' || !window.stardew) {
      console.warn('[daemon-client] window.stardew unavailable — starting demo mode');
      this.demo = startDemo();
      return;
    }
    this.info = await window.stardew.daemonInfo();
    console.log('[daemon-client] info:', { httpUrl: this.info.httpUrl, wsUrl: this.info.wsUrl });
    this.openSocket();
  }

  private openSocket() {
    if (!this.info) return;
    const ws = new WebSocket(this.info.wsUrl);
    this.ws = ws;
    ws.onopen = () => console.log('[daemon-client] ws open');
    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as ServerEvent;
        if (ev.type === 'snapshot') {
          this.snapshot = ev.sessions;
          console.log('[daemon-client] snapshot:', ev.sessions.length, 'sessions');
        } else {
          console.log('[daemon-client] event:', ev.type);
        }
        this.listeners.forEach((l) => l(ev));
      } catch (e) {
        console.warn('[daemon-client] parse error', e);
      }
    };
    ws.onerror = (e) => console.warn('[daemon-client] ws error', e);
    ws.onclose = (e) => {
      console.warn('[daemon-client] ws closed, code=', e.code, 'reconnecting in 1.5s');
      setTimeout(() => this.openSocket(), 1500);
    };
  }

  subscribe(l: (e: ServerEvent) => void): () => void {
    // Demo mode owns its own subscriber list.
    if (this.demo) return this.demo.subscribe(l);
    this.listeners.add(l);
    // Replay snapshot on first subscribe.
    if (this.snapshot.length > 0) {
      l({ type: 'snapshot', sessions: this.snapshot });
    }
    return () => this.listeners.delete(l);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.info) throw new Error('daemon not connected');
    const res = await fetch(this.info.httpUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.info.token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  hire(req: HireWorkerRequest) {
    return this.post<{ sessionId: string }>('/sessions/hire', req);
  }
  send(req: SendMessageRequest) {
    return this.post<{ sessionId: string }>('/sessions/message', req);
  }
  answerQuestion(req: ResolveQuestionRequest) {
    if (this.demo) {
      this.demo.resolvePending?.(req.sessionId);
      return Promise.resolve({ ok: true });
    }
    return this.post<{ ok: boolean }>('/sessions/question-answer', req);
  }
  decidePlan(req: ResolvePlanRequest) {
    if (this.demo) {
      this.demo.resolvePending?.(req.sessionId);
      return Promise.resolve({ ok: true });
    }
    return this.post<{ ok: boolean }>('/sessions/plan-decision', req);
  }
  despawn(sessionId: string) {
    if (this.demo) {
      this.demo.despawn(sessionId);
      return Promise.resolve({ ok: true });
    }
    return this.post<{ ok: boolean }>('/sessions/despawn', { sessionId });
  }
}
