import { contextBridge, ipcRenderer } from 'electron';

interface DesktopResult {
  success: boolean;
  error?: string;
}

/** Minimal, explicit bridge for desktop-only lifecycle and shell controls. */
contextBridge.exposeInMainWorld('agentpanelDesktop', {
  relaunch: (): Promise<void> => ipcRenderer.invoke('agentpanel:relaunch'),
  openExternal: (url: string): Promise<DesktopResult> =>
    ipcRenderer.invoke('agentpanel:open-external', url),
  openDeliveryFolder: async (directory: string): Promise<void> => {
    const result = (await ipcRenderer.invoke(
      'agentpanel:open-delivery-folder',
      directory
    )) as DesktopResult;
    if (!result.success) throw new Error(result.error ?? '打开成果文件夹失败');
  },
});
