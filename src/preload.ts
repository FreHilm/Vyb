import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout, GitStatus, FileEntry, ProfileMemoryMap } from './shared/types';

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

  ackTerminalData: (profileId: string, bytes: number): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_ACK, profileId, bytes),

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

  openUrl: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_URL, url),

  openExternal: (command: string, folderPath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, command, folderPath),

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

  platform: process.platform,

  getGitStatus: (cwd: string): Promise<GitStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd),
  gitFetch: (cwd: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FETCH, cwd),
  serializeTerminal: (profileId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_SERIALIZE, profileId),

  listDir: (dirPath: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_DIR, dirPath),

  readFile: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath),

  saveFile: (filePath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE, filePath, content),
  deleteFile: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, targetPath),
  renameFile: (oldPath: string, newPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_RENAME, oldPath, newPath),
  copyFile: (srcPath: string, destPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_COPY, srcPath, destPath),
  createDir: (dirPath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_CREATE_DIR, dirPath),
  createFile: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_CREATE, filePath),

  exportBackup: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.BACKUP_EXPORT),

  importBackup: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.BACKUP_IMPORT),

  transcribeAudio: (audioBase64: string, lang: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.TRANSCRIBE_AUDIO, audioBase64, lang),

  loadProfileMemory: (): Promise<ProfileMemoryMap> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_MEMORY_LOAD),

  saveProfileMemory: (memory: ProfileMemoryMap): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_MEMORY_SAVE, memory),

  loadScrollback: (profileId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SCROLLBACK_LOAD, profileId),

  loadReadme: (workingDirectory: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.README_LOAD, workingDirectory),

  generateIcon: (profileId: string, projectName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.GENERATE_ICON, profileId, projectName),

  loadLayout: (): Promise<SidebarLayout> =>
    ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_LOAD),

  saveLayout: (layout: SidebarLayout): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SAVE, layout),
});
