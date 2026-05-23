import { WebSocketServer, WebSocket } from 'ws';
import { loadAppConfig } from '@shared/config';
import type { ServerEvent, UsageSnapshot } from '@shared/events';
import type { SessionStore } from './session-store';
import type { QuotaPoller } from './quota-poller';

export function startWsServer(opts: { store: SessionStore; token: string; quota?: QuotaPoller }) {
  const cfg = loadAppConfig();
  const wss = new WebSocketServer({ host: cfg.daemon.host, port: cfg.daemon.wsPort });
  console.log(`[ws-server] listening on ws://${cfg.daemon.host}:${cfg.daemon.wsPort}`);

  const clients = new Set<WebSocket>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', `http://${cfg.daemon.host}`);
    const t = url.searchParams.get('token');
    if (t !== opts.token) {
      ws.close(4001, 'unauthorized');
      return;
    }
    clients.add(ws);
    // Send snapshot on connect — include the last known usage so the chip
    // doesn't flicker blank between socket open and the next poll tick.
    safeSend(ws, {
      type: 'snapshot',
      sessions: opts.store.snapshot(),
      usage: opts.quota?.snapshot(),
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  opts.store.on('event', (e: ServerEvent) => {
    for (const ws of clients) safeSend(ws, e);
  });

  opts.quota?.on('usage', (snap: UsageSnapshot) => {
    for (const ws of clients) safeSend(ws, { type: 'usage.updated', usage: snap });
  });

  return { wss };
}

function safeSend(ws: WebSocket, ev: ServerEvent) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(ev));
  } catch {
    // ignore
  }
}
