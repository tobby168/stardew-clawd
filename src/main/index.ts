import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { SessionStore } from './session-store';
import { InteractiveQueue } from './approval-queue';
import { ResumeRunner } from './resume-runner';
import { startHookServer } from './hook-server';
import { TranscriptTailer } from './transcript-tailer';
import { startWsServer } from './ws-server';
import { QuotaPoller } from './quota-poller';
import { loadAppConfig } from '@shared/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = loadAppConfig();

// Expose a Chrome DevTools Protocol endpoint so Playwright can attach in dev.
// Off in production; on by default in dev, override with STARDEW_OFFICE_CDP_PORT=0
const isDev = !!process.env.ELECTRON_RENDERER_URL;
if (isDev) {
  const cdpPort = process.env.STARDEW_OFFICE_CDP_PORT ?? '9222';
  if (cdpPort !== '0') {
    app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
    console.log(`[stardew-clawd] CDP listening on http://127.0.0.1:${cdpPort}`);
  }
}

let mainWindow: BrowserWindow | null = null;
let store: SessionStore | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Stardew Clawd',
    backgroundColor: '#2a1d12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  store = new SessionStore();
  const approvals = new InteractiveQueue(store);
  const runner = new ResumeRunner(store);
  const tailer = new TranscriptTailer(store);
  const { token } = startHookServer({ store, approvals, runner, tailer });
  const quota = new QuotaPoller();
  startWsServer({ store, token, quota });
  quota.start();

  // Expose connection info to renderer through preload (one-shot).
  ipcMain.handle('daemon-info', () => ({
    httpUrl: `http://${cfg.daemon.host}:${cfg.daemon.httpPort}`,
    wsUrl: `ws://${cfg.daemon.host}:${cfg.daemon.wsPort}?token=${encodeURIComponent(token)}`,
    token,
  }));

  // Scene selection persistence. Stored in Electron's userData dir as a tiny
  // JSON file so the user's last scene survives restarts. `scene:get` returns
  // the stored id (or null if none); the renderer falls back to the registry
  // default. `scene:set` writes through and is fire-and-forget for the caller.
  const sceneFilePath = join(app.getPath('userData'), 'scene.json');
  ipcMain.handle('scene:get', (): string | null => {
    try {
      if (!existsSync(sceneFilePath)) return null;
      const raw = readFileSync(sceneFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { sceneId?: unknown };
      return typeof parsed.sceneId === 'string' ? parsed.sceneId : null;
    } catch (err) {
      console.warn('[scene] failed to read scene.json:', err);
      return null;
    }
  });
  ipcMain.handle('scene:set', (_e, sceneId: unknown): boolean => {
    if (typeof sceneId !== 'string' || sceneId.length === 0) return false;
    try {
      mkdirSync(dirname(sceneFilePath), { recursive: true });
      writeFileSync(sceneFilePath, JSON.stringify({ sceneId }, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.warn('[scene] failed to write scene.json:', err);
      return false;
    }
  });

  createWindow();

  // Refresh quota on window focus — keeps the bars fresh when the user
  // alt-tabs back into the office, without burning calls while idle.
  app.on('browser-window-focus', () => void quota.refresh());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
