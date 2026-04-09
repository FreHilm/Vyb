import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout } from './shared/types';

contextBridge.exposeInMainWorld('api', {
  getProfiles: (): Promise<Profile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_LOAD),

  createTerminal: (profileId: string, profile: Profile): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, profileId, profile),

  sendInput: (profileId: string, data: string): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_INPUT, profileId, data),

  resizeTerminal: (profileId: string, cols: number, rows: number): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, profileId, cols, rows),

  destroyTerminal: (profileId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_DESTROY, profileId),

  onTerminalData: (
    callback: (payload: { profileId: string; data: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { profileId: string; data: string },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, handler);
  },

  onStatusChange: (
    callback: (payload: { profileId: string; status: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { profileId: string; status: string },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.PROFILE_STATUS_CHANGE, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_STATUS_CHANGE, handler);
  },

  openInFinder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SHOW_IN_FOLDER, folderPath),

  openInVSCode: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_VSCODE, folderPath),

  openInFork: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_FORK, folderPath),

  createShellTerminal: (terminalId: string, cwd: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_TERMINAL_CREATE, terminalId, cwd),

  onShellExited: (
    callback: (payload: { terminalId: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { terminalId: string },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.SHELL_TERMINAL_EXITED, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.SHELL_TERMINAL_EXITED, handler);
  },

  saveProfiles: (profiles: Profile[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_SAVE, profiles),

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),

  selectFile: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILE),

  loadSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_LOAD),

  saveSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings),

  onOpenSettings: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_OPEN_DIALOG, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_OPEN_DIALOG, handler);
  },

  setActiveProfile: (profileId: string | null): void =>
    ipcRenderer.send(IPC_CHANNELS.PROFILE_SET_ACTIVE, profileId),

  generateIcon: (profileId: string, projectName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.GENERATE_ICON, profileId, projectName),

  loadLayout: (): Promise<SidebarLayout> =>
    ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LOAD),

  saveLayout: (layout: SidebarLayout): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SAVE, layout),
});
