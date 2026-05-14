import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout, GitStatus, GitCommit, GitRef, GitCheckoutResult, GitCommitResult, GitOpResult, GitMergeResult, GitRebaseResult, GitCreatePrResult, GitStash, FileEntry, ProfileMemoryMap, OrdnaTaskEnvelope, ParallelAgent, EditMenuAction, EditMenuState } from './shared/types';

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

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
    callback: (payload: { profileId: string; data: Uint8Array }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { profileId: string; data: Uint8Array },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, handler);
  },

  ackTerminalData: (profileId: string, bytes: number): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_ACK, profileId, bytes),

  onStatusChange: (
    callback: (payload: { profileId: string; status: string; hasNewContent?: boolean }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { profileId: string; status: string; hasNewContent?: boolean },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.PROFILE_STATUS_CHANGE, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_STATUS_CHANGE, handler);
  },

  onCompletionConfirmed: (
    callback: (payload: { profileId: string }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { profileId: string },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.PROFILE_COMPLETION_CONFIRMED, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_COMPLETION_CONFIRMED, handler);
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

  createTempDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_CREATE_TEMP_DIR),

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

  setSelectedParallelAgent: (parallelAgentId: string | null): void =>
    ipcRenderer.send(IPC_CHANNELS.PARALLEL_AGENT_SET_SELECTED, parallelAgentId),

  queryStatuses: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_STATUS_QUERY),

  onActivateProfileRequest: (
    callback: (payload: { profileId: string; parallelAgentId: string | null }) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { profileId: string; parallelAgentId: string | null },
    ) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.PROFILE_ACTIVATE_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_ACTIVATE_REQUEST, handler);
  },

  platform: process.platform,

  getGitStatus: (cwd: string): Promise<GitStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd),
  gitFetch: (cwd: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FETCH, cwd),
  getGitChangedFiles: (cwd: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHANGED_FILES, cwd),
  getGitFileDiff: (cwd: string, filePath: string, staged?: boolean): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FILE_DIFF, cwd, filePath, staged),
  gitStage: (cwd: string, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE, cwd, filePath),

  gitDiscardFile: (cwd: string, filePath: string, untracked: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DISCARD_FILE, cwd, filePath, untracked),
  gitUnstage: (cwd: string, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE, cwd, filePath),
  gitCommit: (cwd: string, subject: string, description: string): Promise<GitCommitResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, cwd, subject, description),
  gitPush: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH, cwd),
  gitPull: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, cwd),
  gitMerge: (cwd: string, sourceRef: string): Promise<GitMergeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_MERGE, cwd, sourceRef),
  gitMergeAbort: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_MERGE_ABORT, cwd),
  gitListStashes: (cwd: string): Promise<GitStash[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LIST_STASHES, cwd),
  gitStashSave: (cwd: string, message: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STASH_SAVE, cwd, message),
  gitStashApply: (cwd: string, ref: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STASH_APPLY, cwd, ref),
  gitStashPop: (cwd: string, ref: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STASH_POP, cwd, ref),
  gitStashDrop: (cwd: string, ref: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STASH_DROP, cwd, ref),
  gitCreateBranch: (cwd: string, name: string, startPoint?: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CREATE_BRANCH, cwd, name, startPoint),
  gitDeleteBranch: (cwd: string, name: string, force: boolean): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DELETE_BRANCH, cwd, name, force),
  gitDeleteRemoteBranch: (cwd: string, remote: string, branch: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DELETE_REMOTE_BRANCH, cwd, remote, branch),
  gitDeleteTag: (cwd: string, name: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DELETE_TAG, cwd, name),
  gitRebase: (cwd: string, ontoRef: string): Promise<GitRebaseResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REBASE, cwd, ontoRef),
  gitRebaseAbort: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REBASE_ABORT, cwd),
  gitRebaseContinue: (cwd: string): Promise<GitRebaseResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REBASE_CONTINUE, cwd),
  gitSetUpstream: (cwd: string, branch: string, upstream: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SET_UPSTREAM, cwd, branch, upstream),
  gitUnsetUpstream: (cwd: string, branch: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSET_UPSTREAM, cwd, branch),
  gitRenameBranch: (cwd: string, oldName: string, newName: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_RENAME_BRANCH, cwd, oldName, newName),
  gitAddWorktree: (cwd: string, worktreePath: string, branch: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_ADD_WORKTREE, cwd, worktreePath, branch),
  gitCreatePr: (cwd: string, title: string, body: string): Promise<GitCreatePrResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CREATE_PR, cwd, title, body),
  gitCreateTag: (cwd: string, name: string, ref: string, message: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CREATE_TAG, cwd, name, ref, message),
  gitCherryPick: (cwd: string, sha: string): Promise<GitMergeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHERRY_PICK, cwd, sha),
  gitCherryPickAbort: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHERRY_PICK_ABORT, cwd),
  gitCherryPickContinue: (cwd: string): Promise<GitMergeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHERRY_PICK_CONTINUE, cwd),
  gitRevert: (cwd: string, sha: string): Promise<GitMergeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REVERT, cwd, sha),
  gitRevertAbort: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REVERT_ABORT, cwd),
  gitRevertContinue: (cwd: string): Promise<GitMergeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REVERT_CONTINUE, cwd),
  gitReset: (cwd: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_RESET, cwd, sha, mode),
  getGitLog: (cwd: string, limit: number): Promise<GitCommit[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LOG, cwd, limit),
  getGitRefs: (cwd: string): Promise<GitRef[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LIST_REFS, cwd),
  gitCheckoutCommit: (cwd: string, sha: string): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHECKOUT_COMMIT, cwd, sha),

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
  saveFileAs: (content: string, defaultPath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE_AS, content, defaultPath),
  resolveFilePath: (workingDir: string, token: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_RESOLVE_PATH, workingDir, token),

  watchDir: (cwd: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_WATCH_START, cwd),
  unwatchDir: (watchId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_WATCH_STOP, watchId),
  onFileWatchChange: (
    callback: (payload: { watchId: string; eventType: string; absPath: string; relPath: string }) => void,
  ): (() => void) => {
    const handler = (_: unknown, p: { watchId: string; eventType: string; absPath: string; relPath: string }) => callback(p);
    ipcRenderer.on(IPC_CHANNELS.FILE_WATCH_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_WATCH_CHANGE, handler);
  },

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

  startOrdna: (
    instanceKey: string,
    profileId: string,
    cwd: string,
    mode: 'web' | 'tui',
  ): Promise<{ webUrl?: string; tuiPtyId?: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.ORDNA_START, instanceKey, profileId, cwd, mode),

  stopOrdna: (instanceKey: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.ORDNA_STOP, instanceKey),

  getOrdnaInstance: (
    instanceKey: string,
  ): Promise<{ mode: 'web' | 'tui'; webUrl: string | null; tuiPtyId: string | null } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.ORDNA_GET_WEB_URL, instanceKey),

  getOrdnaHookInfo: (): Promise<{ url: string; port: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.ORDNA_HOOK_INFO),

  onOrdnaTask: (callback: (envelope: OrdnaTaskEnvelope) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, envelope: OrdnaTaskEnvelope) =>
      callback(envelope);
    ipcRenderer.on(IPC_CHANNELS.ORDNA_TASK_RECEIVED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ORDNA_TASK_RECEIVED, handler);
  },

  onOrdnaExited: (callback: (payload: { instanceKey: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { instanceKey: string }) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.ORDNA_EXITED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ORDNA_EXITED, handler);
  },

  spawnParallelAgent: (
    profileId: string,
    task: { id: string; title: string; filePath?: string },
  ): Promise<ParallelAgent | { error: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PARALLEL_AGENT_SPAWN, profileId, task),

  destroyParallelAgent: (id: string, discardWork?: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PARALLEL_AGENT_DESTROY, id, discardWork === true),

  listParallelAgents: (profileId?: string): Promise<ParallelAgent[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.PARALLEL_AGENT_LIST, profileId),

  finishParallelAgent: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PARALLEL_AGENT_FINISH, id),

  onParallelAgentChange: (callback: (agent: ParallelAgent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, agent: ParallelAgent) =>
      callback(agent);
    ipcRenderer.on(IPC_CHANNELS.PARALLEL_AGENT_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PARALLEL_AGENT_CHANGE, handler);
  },

  onParallelAgentExited: (callback: (agent: ParallelAgent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, agent: ParallelAgent) =>
      callback(agent);
    ipcRenderer.on(IPC_CHANNELS.PARALLEL_AGENT_EXITED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PARALLEL_AGENT_EXITED, handler);
  },

  setEditMenuState: (state: EditMenuState): void =>
    ipcRenderer.send(IPC_CHANNELS.EDIT_MENU_STATE, state),

  onEditMenuAction: (callback: (action: EditMenuAction) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: EditMenuAction) =>
      callback(action);
    ipcRenderer.on(IPC_CHANNELS.EDIT_MENU_ACTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EDIT_MENU_ACTION, handler);
  },
});
