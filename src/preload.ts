import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, Profile, AppSettings, SidebarLayout, GitStatus, GitCommit, GitRef, GitCheckoutResult, GitCommitResult, GitOpResult, GitMergeResult, GitMergePreviewResult, GitRebaseResult, GitCreatePrResult, GitStash, FileEntry, ProfileMemoryMap, OrdnaTaskEnvelope, ParallelAgent, EditMenuAction, EditMenuState } from './shared/types';

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  getProfiles: (): Promise<Profile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILES_LOAD),

  createTerminal: (profileId: string, profile: Profile, cols?: number, rows?: number, overrideArgs?: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, profileId, profile, cols, rows, overrideArgs),

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

  openWebviewDevTools: (targetId: number, hostId: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBVIEW_OPEN_DEVTOOLS, targetId, hostId),
  closeWebviewDevTools: (targetId: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBVIEW_CLOSE_DEVTOOLS, targetId),
  registerWebviewContextMenu: (targetId: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBVIEW_REGISTER_CONTEXT_MENU, targetId),
  webviewInspectAt: (targetId: number, x: number, y: number): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBVIEW_INSPECT_AT, targetId, x, y),
  onWebviewInspectRequest: (cb: (p: { targetId: number; x: number; y: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { targetId: number; x: number; y: number }) => cb(payload);
    ipcRenderer.on(IPC_CHANNELS.WEBVIEW_INSPECT_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBVIEW_INSPECT_REQUEST, handler);
  },

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

  pathExists: (p: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FS_PATH_EXISTS, p),

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

  onMenuNewProfile: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MENU_NEW_PROFILE, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.MENU_NEW_PROFILE, handler);
  },

  // Quit handshake. Main fires APP_BEFORE_QUIT; the renderer checks for
  // unsaved files and, after the user decides, replies via APP_QUIT_DECISION
  // with whether to proceed.
  onAppBeforeQuit: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.APP_BEFORE_QUIT, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.APP_BEFORE_QUIT, handler);
  },
  sendQuitDecision: (proceed: boolean): void =>
    ipcRenderer.send(IPC_CHANNELS.APP_QUIT_DECISION, proceed),
  setTerminalFocused: (focused: boolean): void =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_FOCUS_CHANGED, focused),

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
  getGitFileAtHead: (cwd: string, filePath: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FILE_AT_HEAD, cwd, filePath),
  gitStage: (cwd: string, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE, cwd, filePath),

  gitDiscardFile: (cwd: string, filePath: string, untracked: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DISCARD_FILE, cwd, filePath, untracked),
  gitUnstage: (cwd: string, filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE, cwd, filePath),
  gitCommit: (cwd: string, subject: string, description: string): Promise<GitCommitResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, cwd, subject, description),
  /** Amend HEAD. Pass `subject = null` to preserve the existing message
   * (`--no-edit`); pass a new subject + description to replace it. */
  gitAmendCommit: (cwd: string, subject: string | null, description: string | null): Promise<GitCommitResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_AMEND_COMMIT, cwd, subject, description),
  gitRewordHead: (cwd: string, subject: string, description: string): Promise<GitCommitResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REWORD_HEAD, cwd, subject, description),
  gitHeadInfo: (cwd: string): Promise<{
    ok: boolean;
    sha?: string;
    subject?: string;
    body?: string;
    pushed?: boolean;
    branch?: string;
    message?: string;
  }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_HEAD_INFO, cwd),
  gitPush: (cwd: string, tagMode?: 'off' | 'reachable' | 'all'): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH, cwd, tagMode),
  /** Safe force-push variant: fetches first, then pushes with
   * `--force-with-lease`. Use only on diverged history (after amend /
   * rebase). The lease prevents overwriting upstream commits that
   * appeared while we were rewriting locally. */
  gitPushForceLease: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH_FORCE_LEASE, cwd),
  gitPull: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, cwd),
  /** Pull with --rebase. Linear history; conflicts surface via the
   * existing rebase-in-progress banner. */
  gitPullRebase: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL_REBASE, cwd),
  /** Files differing between two refs. `threeDot=true` uses `a...b`
   * (merge-base range — "what would arrive on a if you merged b");
   * false (default) uses `a..b` (every difference). */
  gitCompareFiles: (cwd: string, a: string, b: string, threeDot: boolean): Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_COMPARE_FILES, cwd, a, b, threeDot),
  gitCompareFileDiff: (cwd: string, a: string, b: string, filePath: string, threeDot: boolean): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_COMPARE_FILE_DIFF, cwd, a, b, filePath, threeDot),
  /** Read the base / ours / theirs version of a conflicted file from
   * git's index. stage = 1 (base), 2 (ours = HEAD), 3 (theirs = MERGE_HEAD). */
  gitShowStage: (cwd: string, filePath: string, stage: 1 | 2 | 3): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SHOW_STAGE, cwd, filePath, stage),

  gitApplyPatch: (cwd: string, patch: string, opts?: { reverse?: boolean }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_APPLY_PATCH, cwd, patch, opts),

  gitFileLog: (cwd: string, filePath: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FILE_LOG, cwd, filePath, limit),

  gitFileLogDiff: (cwd: string, sha: string, filePath: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_FILE_LOG_DIFF, cwd, sha, filePath),

  gitBlameFile: (cwd: string, filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_BLAME_FILE, cwd, filePath),

  gitGetSignCommits: (cwd: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_SIGN_COMMITS, cwd),
  gitSetSignCommits: (cwd: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SET_SIGN_COMMITS, cwd, enabled),
  gitCommitSignatures: (cwd: string, limit: number): Promise<Record<string, { sigStatus: string; sigSigner: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT_SIGNATURES, cwd, limit),

  gitListRemotes: (cwd: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LIST_REMOTES, cwd),
  gitAddRemote: (cwd: string, name: string, url: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_ADD_REMOTE, cwd, name, url),
  gitRenameRemote: (cwd: string, oldName: string, newName: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_RENAME_REMOTE, cwd, oldName, newName),
  gitSetRemoteUrl: (cwd: string, name: string, url: string, opts?: { push?: boolean }): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SET_REMOTE_URL, cwd, name, url, opts),
  gitRemoveRemote: (cwd: string, name: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REMOVE_REMOTE, cwd, name),
  gitRemoteTrackingBranches: (cwd: string, remoteName: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REMOTE_TRACKING_BRANCHES, cwd, remoteName),

  gitListWorktrees: (cwd: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LIST_WORKTREES, cwd),
  gitRemoveWorktree: (cwd: string, worktreePath: string, force: boolean): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REMOVE_WORKTREE, cwd, worktreePath, force),

  gitReflog: (cwd: string, ref?: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REFLOG, cwd, ref ?? 'HEAD', limit ?? 500),

  gitBisectStart: (cwd: string, goodSha: string, badSha: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_BISECT_START, cwd, goodSha, badSha),
  gitBisectMark: (cwd: string, kind: 'good' | 'bad' | 'skip'): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_BISECT_MARK, cwd, kind),
  gitBisectReset: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_BISECT_RESET, cwd),
  gitBisectStatus: (cwd: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_BISECT_STATUS, cwd),

  gitLfsInfo: (cwd: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LFS_INFO, cwd),
  gitLfsListLocks: (cwd: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LFS_LIST_LOCKS, cwd),
  gitLfsLock: (cwd: string, filePath: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LFS_LOCK, cwd, filePath),
  gitLfsUnlock: (cwd: string, filePath: string, force: boolean): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LFS_UNLOCK, cwd, filePath, force),
  gitLfsFetch: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LFS_FETCH, cwd),
  gitLfsPrune: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_LFS_PRUNE, cwd),

  gitSubmodulesList: (cwd: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SUBMODULES_LIST, cwd),
  gitSubmoduleInit: (cwd: string, subPath: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SUBMODULE_INIT, cwd, subPath),
  gitSubmoduleUpdate: (cwd: string, subPath: string, remote: boolean): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SUBMODULE_UPDATE, cwd, subPath, remote),
  gitSubmoduleSync: (cwd: string, subPath: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_SUBMODULE_SYNC, cwd, subPath),

  gitRebaseInteractive: (cwd: string, base: string, todoLines: string[]): Promise<GitRebaseResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_REBASE_INTERACTIVE, cwd, base, todoLines),

  gitMerge: (cwd: string, sourceRef: string): Promise<GitMergeResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_MERGE, cwd, sourceRef),
  gitMergeAbort: (cwd: string): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_MERGE_ABORT, cwd),
  gitMergePreview: (cwd: string, sourceRef: string): Promise<GitMergePreviewResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_MERGE_PREVIEW, cwd, sourceRef),
  gitCheckoutOursTheirs: (cwd: string, filePath: string, side: 'ours' | 'theirs'): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHECKOUT_OURS_THEIRS, cwd, filePath, side),
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
  gitCheckoutCommit: (cwd: string, sha: string, stashCarry?: boolean): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CHECKOUT_COMMIT, cwd, sha, stashCarry === true),

  listDir: (dirPath: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_DIR, dirPath),

  listProjectFiles: (cwd: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_PROJECT, cwd),

  searchInFiles: (cwd: string, query: string, opts?: import('./shared/types').FileSearchOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SEARCH_IN_FILES, cwd, query, opts),

  replaceInFiles: (
    cwd: string,
    query: string,
    opts: import('./shared/types').FileSearchOptions | undefined,
    replaceText: string,
    targets: import('./shared/types').FileReplaceTarget[],
  ): Promise<import('./shared/types').FileReplaceResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_REPLACE_IN_FILES, cwd, query, opts, replaceText, targets),

  listAgentSessions: (command: string, cwd: string): Promise<import('./shared/types').AgentSessionList> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST_SESSIONS, command, cwd),

  onMenuFindInFiles: (callback: (payload: { withReplace: boolean }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { withReplace: boolean }) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.MENU_FIND_IN_FILES, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_FIND_IN_FILES, handler);
  },

  formatDocument: (filePath: string, content: string): Promise<{ content?: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_FORMAT, filePath, content),

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
  isLargeDir: (cwd: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_DIR_IS_LARGE, cwd),
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

  spawnParallelSession: (
    profileId: string,
    opts: { sessionId: string | null; label: string },
  ): Promise<ParallelAgent | { error: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PARALLEL_AGENT_SPAWN_SESSION, profileId, opts),

  resumeParallelSession: (id: string): Promise<ParallelAgent | { error: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PARALLEL_AGENT_RESUME_SESSION, id),

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

  popupMenu: (label: string, x: number, y: number): void =>
    ipcRenderer.send(IPC_CHANNELS.MENU_POPUP, { label, x, y }),

  setTitleBarOverlay: (color: string, symbolColor: string): void =>
    ipcRenderer.send(IPC_CHANNELS.TITLEBAR_SET_OVERLAY, { color, symbolColor }),

  onEditMenuAction: (callback: (action: EditMenuAction) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: EditMenuAction) =>
      callback(action);
    ipcRenderer.on(IPC_CHANNELS.EDIT_MENU_ACTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EDIT_MENU_ACTION, handler);
  },
});
