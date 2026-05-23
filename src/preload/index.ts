import { contextBridge, ipcRenderer } from 'electron';

export interface DaemonInfo {
  httpUrl: string;
  wsUrl: string;
  token: string;
}

contextBridge.exposeInMainWorld('stardew', {
  daemonInfo: (): Promise<DaemonInfo> => ipcRenderer.invoke('daemon-info'),
  // Scene persistence — see src/main/index.ts for the on-disk file. The
  // renderer's scene-state hook calls these on boot and on every switch.
  getScene: (): Promise<string | null> => ipcRenderer.invoke('scene:get'),
  setScene: (sceneId: string): Promise<boolean> => ipcRenderer.invoke('scene:set', sceneId),
});
