import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandBar } from './components/CommandBar';
import { ToastContainer } from './components/ToastContainer';
import { TerminalPane } from './components/TerminalPane';
import { ShellPane } from './components/ShellPane';
import { ProfileEditor } from './components/ProfileEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { ResizeHandle } from './components/ResizeHandle';
import { FileExplorer, type FileExplorerHandle } from './components/FileExplorer';
import { QuickOpenDialog } from './components/QuickOpenDialog';
import { SessionPickerDialog } from './components/SessionPickerDialog';
import { RemoteChatPane } from './components/RemoteChatPane';
import { toastError } from './lib/toast';
import { FindInFilesPanel } from './components/FindInFilesPanel';
import { KanbanViewer } from './components/KanbanViewer';
import { WebViewer } from './components/WebViewer';
import { ParallelAgentTerminal } from './components/ParallelAgentTerminal';
import { StatusBar } from './components/StatusBar';
import { GitChangesPanel } from './components/GitChangesPanel';
import { useKeyNav } from './components/KeyNav';
import { HotkeyHints } from './components/HotkeyHints';
import { useDictation } from './components/Dictation';
import { Profile, AgentStatus, AppSettings, DEFAULT_SETTINGS, SidebarLayout, Workspace, GitStatus, GitCommit, GitBlameLine, GitRef, GitRemote, GitWorktree, GitReflogEntry, GitBisectStatus, GitLfsInfo, GitLfsLock, GitSubmodule, GitCheckoutResult, GitCommitResult, GitOpResult, GitMergeResult, GitMergePreviewResult, GitRebaseResult, GitCreatePrResult, GitStash, ExternalApp, FileEntry, ProfileMemoryMap, OrdnaTaskEnvelope, ParallelAgent, EditMenuAction, EditMenuState, FileSearchOptions, FileSearchResult, FileReplaceTarget, FileReplaceResult, AgentSessionList, DEFAULT_AGENTS, resolveAgent, buildSessionArgs, RemoteChatState, RemoteChatMessage, RemoteChatEvent, RemoteChatTopics, RemoteChatTopic } from '../shared/types';
import { applyTheme } from './theme';
import './App.css';

// Build the prefixed task message we feed into the agent.
//
// For regular dispatch the agent runs in the parent repo, so we keep the
// original absolute task.filePath. For a parallel agent we rewrite the path
// to point at the worktree's copy of the same file, and prepend a worktree
// preamble so the agent never strays out of its isolated checkout.
function buildOrdnaTaskMessage(
  payload: OrdnaTaskEnvelope['payload'],
  parallel?: { worktreePath: string; branch: string; parentRepoPath: string },
): string {
  const t = payload.task;
  const priority = t.priority || 'unset';
  const tags = t.tags && t.tags.length > 0 ? t.tags.join(', ') : 'none';

  // Map the task file's absolute path into the worktree, if applicable.
  let taskFilePath = t.filePath;
  if (parallel) {
    const parent = parallel.parentRepoPath.replace(/\/+$/, '');
    if (taskFilePath && taskFilePath.startsWith(parent + '/')) {
      const rel = taskFilePath.slice(parent.length + 1);
      taskFilePath = `${parallel.worktreePath}/${rel}`;
    }
  }

  const worktreePreamble = parallel
    ? `[Workspace — isolated git worktree]\n\n` +
      `You are running in an isolated git worktree at:\n  ${parallel.worktreePath}\n` +
      `Branch: ${parallel.branch}\n` +
      `Make ALL edits inside this directory only — do NOT touch files in\n` +
      `the original repo at ${parallel.parentRepoPath}. Your current working\n` +
      `directory is already the worktree, so cwd-relative paths are safest.\n\n`
    : '';

  return (
    worktreePreamble +
    '[Ordna Task — please implement]\n\n' +
    'This is a task from the Kanban board. Please read it carefully, and ' +
    'before starting work, ask clarifying questions about anything ambiguous ' +
    'or unspecified — do not make assumptions about scope or intent.\n\n' +
    `Keep the task file (${taskFilePath}) in sync as you work: set ` +
    '`status: doing` before you start, append a brief note to the ' +
    '`## Progress` section at meaningful checkpoints, and set ' +
    '`status: done` when finished.\n\n' +
    `Task: ${t.title}\n` +
    `ID: ${t.id}\n` +
    `Status: ${t.status}\n` +
    `Priority: ${priority}\n` +
    `Tags: ${tags}\n\n` +
    (t.rawContent || '')
  );
}

declare global {
  interface Window {
    api: {
      getPathForFile: (file: File) => string;
      getProfiles: () => Promise<Profile[]>;
      saveProfiles: (profiles: Profile[]) => Promise<void>;
      createTerminal: (profileId: string, profile: Profile, cols?: number, rows?: number, overrideArgs?: string[]) => Promise<void>;
      sendInput: (profileId: string, data: string) => void;
      resizeTerminal: (profileId: string, cols: number, rows: number) => void;
      destroyTerminal: (profileId: string) => Promise<void>;
      onTerminalData: (
        callback: (payload: { profileId: string; data: Uint8Array }) => void,
      ) => () => void;
      onStatusChange: (
        callback: (payload: { profileId: string; status: string; hasNewContent?: boolean }) => void,
      ) => () => void;
      onCompletionConfirmed: (
        callback: (payload: { profileId: string }) => void,
      ) => () => void;
      openInFinder: (folderPath: string) => Promise<void>;
      openInVSCode: (folderPath: string) => Promise<void>;
      openInFork: (folderPath: string) => Promise<void>;
      openUrl: (url: string) => Promise<void>;
      openWebviewDevTools: (targetId: number, hostId: number) => Promise<boolean>;
      closeWebviewDevTools: (targetId: number) => Promise<boolean>;
      registerWebviewContextMenu: (targetId: number) => Promise<boolean>;
      webviewInspectAt: (targetId: number, x: number, y: number) => Promise<boolean>;
      onWebviewInspectRequest: (cb: (p: { targetId: number; x: number; y: number }) => void) => () => void;
      openExternal: (command: string, folderPath: string) => Promise<void>;
      createShellTerminal: (terminalId: string, cwd: string) => Promise<void>;
      onShellExited: (
        callback: (payload: { terminalId: string }) => void,
      ) => () => void;
      selectDirectory: () => Promise<string | null>;
      selectFile: () => Promise<string | null>;
      createTempDir: () => Promise<string>;
      pathExists: (p: string) => Promise<boolean>;
      loadSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<void>;
      onOpenSettings: (callback: () => void) => () => void;
      onMenuNewProfile: (callback: () => void) => () => void;
      onAppBeforeQuit: (callback: () => void) => () => void;
      sendQuitDecision: (proceed: boolean) => void;
      setTerminalFocused: (focused: boolean) => void;
      platform: string;
      getGitStatus: (cwd: string) => Promise<GitStatus>;
      ackTerminalData: (profileId: string, bytes: number) => void;
      gitFetch: (cwd: string) => Promise<boolean>;
      gitPushForceLease: (cwd: string) => Promise<GitOpResult>;
      gitPullRebase: (cwd: string) => Promise<GitOpResult>;
      gitCompareFiles: (cwd: string, a: string, b: string, threeDot: boolean) => Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]>;
      gitCompareFileDiff: (cwd: string, a: string, b: string, filePath: string, threeDot: boolean) => Promise<string>;
      gitShowStage: (cwd: string, filePath: string, stage: 1 | 2 | 3) => Promise<string>;
      gitApplyPatch: (cwd: string, patch: string, opts?: { reverse?: boolean }) => Promise<{ ok: boolean; error?: string }>;
      gitFileLog: (cwd: string, filePath: string, limit?: number) => Promise<GitCommit[]>;
      gitFileLogDiff: (cwd: string, sha: string, filePath: string) => Promise<string>;
      gitBlameFile: (cwd: string, filePath: string) => Promise<GitBlameLine[]>;
      gitGetSignCommits: (cwd: string) => Promise<boolean>;
      gitSetSignCommits: (cwd: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
      gitCommitSignatures: (cwd: string, limit: number) => Promise<Record<string, { sigStatus: string; sigSigner: string }>>;
      gitListRemotes: (cwd: string) => Promise<GitRemote[]>;
      gitAddRemote: (cwd: string, name: string, url: string) => Promise<GitOpResult>;
      gitRenameRemote: (cwd: string, oldName: string, newName: string) => Promise<GitOpResult>;
      gitSetRemoteUrl: (cwd: string, name: string, url: string, opts?: { push?: boolean }) => Promise<GitOpResult>;
      gitRemoveRemote: (cwd: string, name: string) => Promise<GitOpResult>;
      gitRemoteTrackingBranches: (cwd: string, remoteName: string) => Promise<string[]>;
      gitListWorktrees: (cwd: string) => Promise<GitWorktree[]>;
      gitRemoveWorktree: (cwd: string, worktreePath: string, force: boolean) => Promise<GitOpResult>;
      gitReflog: (cwd: string, ref?: string, limit?: number) => Promise<GitReflogEntry[]>;
      gitBisectStart: (cwd: string, goodSha: string, badSha: string) => Promise<GitOpResult>;
      gitBisectMark: (cwd: string, kind: 'good' | 'bad' | 'skip') => Promise<GitOpResult>;
      gitBisectReset: (cwd: string) => Promise<GitOpResult>;
      gitBisectStatus: (cwd: string) => Promise<GitBisectStatus>;
      gitLfsInfo: (cwd: string) => Promise<GitLfsInfo>;
      gitLfsListLocks: (cwd: string) => Promise<GitLfsLock[]>;
      gitLfsLock: (cwd: string, filePath: string) => Promise<GitOpResult>;
      gitLfsUnlock: (cwd: string, filePath: string, force: boolean) => Promise<GitOpResult>;
      gitLfsFetch: (cwd: string) => Promise<GitOpResult>;
      gitLfsPrune: (cwd: string) => Promise<GitOpResult>;
      gitSubmodulesList: (cwd: string) => Promise<GitSubmodule[]>;
      gitSubmoduleInit: (cwd: string, subPath: string) => Promise<GitOpResult>;
      gitSubmoduleUpdate: (cwd: string, subPath: string, remote: boolean) => Promise<GitOpResult>;
      gitSubmoduleSync: (cwd: string, subPath: string) => Promise<GitOpResult>;
      gitRebaseInteractive: (cwd: string, base: string, todoLines: string[]) => Promise<GitRebaseResult>;
      getGitChangedFiles: (cwd: string) => Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]>;
      getGitFileDiff: (cwd: string, filePath: string, staged?: boolean) => Promise<string>;
      getGitFileAtHead: (cwd: string, filePath: string) => Promise<string | null>;
      getGitLog: (cwd: string, limit: number) => Promise<GitCommit[]>;
      getGitRefs: (cwd: string) => Promise<GitRef[]>;
      gitCheckoutCommit: (cwd: string, sha: string, stashCarry?: boolean) => Promise<GitCheckoutResult>;
      gitStage: (cwd: string, filePath: string) => Promise<boolean>;
      gitUnstage: (cwd: string, filePath: string) => Promise<boolean>;
      gitDiscardFile: (cwd: string, filePath: string, untracked: boolean) => Promise<boolean>;
      gitCommit: (cwd: string, subject: string, description: string) => Promise<GitCommitResult>;
      gitAmendCommit: (cwd: string, subject: string | null, description: string | null) => Promise<GitCommitResult>;
      gitRewordHead: (cwd: string, subject: string, description: string) => Promise<GitCommitResult>;
      gitHeadInfo: (cwd: string) => Promise<{
        ok: boolean;
        sha?: string;
        subject?: string;
        body?: string;
        pushed?: boolean;
        branch?: string;
        message?: string;
      }>;
      gitPush: (cwd: string, tagMode?: 'off' | 'reachable' | 'all') => Promise<GitOpResult>;
      gitPull: (cwd: string) => Promise<GitOpResult>;
      gitMerge: (cwd: string, sourceRef: string) => Promise<GitMergeResult>;
      gitMergeAbort: (cwd: string) => Promise<GitOpResult>;
      gitMergePreview: (cwd: string, sourceRef: string) => Promise<GitMergePreviewResult>;
      gitCheckoutOursTheirs: (cwd: string, filePath: string, side: 'ours' | 'theirs') => Promise<GitOpResult>;
      gitListStashes: (cwd: string) => Promise<GitStash[]>;
      gitStashSave: (cwd: string, message: string) => Promise<GitOpResult>;
      gitStashApply: (cwd: string, ref: string) => Promise<GitOpResult>;
      gitStashPop: (cwd: string, ref: string) => Promise<GitOpResult>;
      gitStashDrop: (cwd: string, ref: string) => Promise<GitOpResult>;
      gitCreateBranch: (cwd: string, name: string, startPoint?: string) => Promise<GitOpResult>;
      gitDeleteBranch: (cwd: string, name: string, force: boolean) => Promise<GitOpResult>;
      gitDeleteRemoteBranch: (cwd: string, remote: string, branch: string) => Promise<GitOpResult>;
      gitDeleteTag: (cwd: string, name: string) => Promise<GitOpResult>;
      gitRebase: (cwd: string, ontoRef: string) => Promise<GitRebaseResult>;
      gitRebaseAbort: (cwd: string) => Promise<GitOpResult>;
      gitRebaseContinue: (cwd: string) => Promise<GitRebaseResult>;
      gitSetUpstream: (cwd: string, branch: string, upstream: string) => Promise<GitOpResult>;
      gitUnsetUpstream: (cwd: string, branch: string) => Promise<GitOpResult>;
      gitRenameBranch: (cwd: string, oldName: string, newName: string) => Promise<GitOpResult>;
      gitAddWorktree: (cwd: string, worktreePath: string, branch: string) => Promise<GitOpResult>;
      gitCreatePr: (cwd: string, title: string, body: string) => Promise<GitCreatePrResult>;
      gitCreateTag: (cwd: string, name: string, ref: string, message: string) => Promise<GitOpResult>;
      gitCherryPick: (cwd: string, sha: string) => Promise<GitMergeResult>;
      gitCherryPickAbort: (cwd: string) => Promise<GitOpResult>;
      gitCherryPickContinue: (cwd: string) => Promise<GitMergeResult>;
      gitRevert: (cwd: string, sha: string) => Promise<GitMergeResult>;
      gitRevertAbort: (cwd: string) => Promise<GitOpResult>;
      gitRevertContinue: (cwd: string) => Promise<GitMergeResult>;
      gitReset: (cwd: string, sha: string, mode: 'soft' | 'mixed' | 'hard') => Promise<GitOpResult>;
      listDir: (dirPath: string) => Promise<FileEntry[]>;
      listProjectFiles: (cwd: string) => Promise<string[]>;
      searchInFiles: (cwd: string, query: string, opts?: FileSearchOptions) => Promise<FileSearchResult>;
      replaceInFiles: (cwd: string, query: string, opts: FileSearchOptions | undefined, replaceText: string, targets: FileReplaceTarget[]) => Promise<FileReplaceResult>;
      listAgentSessions: (command: string, cwd: string) => Promise<AgentSessionList>;
      remoteChatState: () => Promise<RemoteChatState>;
      remoteChatLoginStart: (apiId: number, apiHash: string, phone: string) => Promise<RemoteChatState>;
      remoteChatLoginCode: (code: string) => Promise<void>;
      remoteChatLoginPassword: (password: string) => Promise<void>;
      remoteChatLogout: () => Promise<void>;
      remoteChatHistory: (profileId: string, topicId?: string) => Promise<RemoteChatMessage[]>;
      remoteChatSend: (profileId: string, text: string, topicId?: string) => Promise<{ ok: boolean; error?: string }>;
      remoteChatSendFile: (profileId: string, filePath: string, topicId?: string) => Promise<{ ok: boolean; error?: string }>;
      remoteChatOpenMedia: (profileId: string, messageId: string) => Promise<{ ok: boolean; error?: string }>;
      remoteChatPressButton: (profileId: string, messageId: string, dataBase64: string) => Promise<{ ok: boolean; error?: string; answer?: string }>;
      remoteChatFetchMedia: (profileId: string, messageId: string) => Promise<{ ok: true; path: string; name: string; kind: string } | { ok: false; error: string }>;
      remoteChatSaveMedia: (profileId: string, messageId: string) => Promise<{ ok: boolean; savedTo?: string; canceled?: boolean; error?: string }>;
      remoteChatTopics: (profileId: string) => Promise<RemoteChatTopics>;
      remoteChatCreateTopic: (profileId: string, title: string) => Promise<RemoteChatTopic | { error: string }>;
      onRemoteChatEvent: (callback: (event: RemoteChatEvent) => void) => () => void;
      onMenuFindInFiles: (callback: (payload: { withReplace: boolean }) => void) => () => void;
      onMenuToggleSplit: (callback: () => void) => () => void;
      formatDocument: (filePath: string, content: string) => Promise<{ content?: string; error?: string }>;
      readFile: (filePath: string) => Promise<string | null>;
      saveFile: (filePath: string, content: string) => Promise<boolean>;
      deleteFile: (targetPath: string) => Promise<boolean>;
      renameFile: (oldPath: string, newPath: string) => Promise<boolean>;
      copyFile: (srcPath: string, destPath: string) => Promise<boolean>;
      createDir: (dirPath: string) => Promise<boolean>;
      moveDirContents: (srcDir: string, destDir: string) => Promise<{ ok: boolean; error?: string }>;
      createFile: (filePath: string) => Promise<boolean>;
      saveFileAs: (content: string, defaultPath: string) => Promise<string | null>;
      resolveFilePath: (workingDir: string, token: string) => Promise<string | null>;
      watchDir: (cwd: string) => Promise<string | null>;
      unwatchDir: (watchId: string) => Promise<void>;
      isLargeDir: (cwd: string) => Promise<boolean>;
      onFileWatchChange: (
        callback: (payload: { watchId: string; eventType: string; absPath: string; relPath: string }) => void,
      ) => () => void;
      exportBackup: () => Promise<string | null>;
      importBackup: () => Promise<boolean>;
      transcribeAudio: (audioBase64: string, lang: string) => Promise<string>;
      loadProfileMemory: () => Promise<ProfileMemoryMap>;
      saveProfileMemory: (memory: ProfileMemoryMap) => Promise<void>;
      loadScrollback: (profileId: string) => Promise<string | null>;
      loadReadme: (workingDirectory: string) => Promise<string | null>;
      setActiveProfile: (profileId: string | null) => void;
      setSelectedParallelAgent: (parallelAgentId: string | null) => void;
      queryStatuses: () => Promise<Record<string, string>>;
      onActivateProfileRequest: (
        callback: (payload: { profileId: string; parallelAgentId: string | null }) => void,
      ) => () => void;
      generateIcon: (profileId: string, projectName: string) => Promise<string | null>;
      loadLayout: () => Promise<SidebarLayout>;
      saveLayout: (layout: SidebarLayout) => Promise<void>;
      startOrdna: (
        instanceKey: string,
        profileId: string,
        cwd: string,
        mode: 'web' | 'tui',
      ) => Promise<{ webUrl?: string; tuiPtyId?: string; error?: string }>;
      stopOrdna: (instanceKey: string) => Promise<void>;
      getOrdnaInstance: (
        instanceKey: string,
      ) => Promise<{ mode: 'web' | 'tui'; webUrl: string | null; tuiPtyId: string | null } | null>;
      getOrdnaHookInfo: () => Promise<{ url: string; port: number }>;
      onOrdnaTask: (callback: (envelope: OrdnaTaskEnvelope) => void) => () => void;
      onOrdnaExited: (callback: (payload: { instanceKey: string }) => void) => () => void;
      spawnParallelAgent: (
        profileId: string,
        task: { id: string; title: string; filePath?: string },
      ) => Promise<ParallelAgent | { error: string }>;
      spawnParallelSession: (
        profileId: string,
        opts: { sessionId: string | null; label: string },
      ) => Promise<ParallelAgent | { error: string }>;
      resumeParallelSession: (id: string) => Promise<ParallelAgent | { error: string }>;
      destroyParallelAgent: (id: string, discardWork?: boolean) => Promise<void>;
      listParallelAgents: (profileId?: string) => Promise<ParallelAgent[]>;
      finishParallelAgent: (id: string) => Promise<void>;
      onParallelAgentChange: (callback: (agent: ParallelAgent) => void) => () => void;
      onParallelAgentExited: (callback: (agent: ParallelAgent) => void) => () => void;
      setEditMenuState: (state: EditMenuState) => void;
      onEditMenuAction: (callback: (action: EditMenuAction) => void) => () => void;
      popupMenu: (label: string, x: number, y: number) => void;
      setTitleBarOverlay: (color: string, symbolColor: string) => void;
    };
  }
}

// Width of the sidebar when collapsed to icon-only mode. Fits the 42 px
// profile icon + the agent badge that sticks out 2 px past its top-left
// corner, with a touch of margin so the icons don't feel cramped.
const SIDEBAR_COMPACT_WIDTH = 64;
const SIDEBAR_EXPANDED_MIN = 160;
const SIDEBAR_EXPANDED_MAX = 500;
// Drag past this width (in either direction) flips the snap.
const SIDEBAR_SNAP_THRESHOLD = 120;

export function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Map<string, AgentStatus>>(
    new Map(),
  );
  const [initialized, setInitialized] = useState<Set<string>>(new Set());
  // Profiles the user explicitly stopped — don't auto-init them
  const stoppedRef = useRef<Set<string>>(new Set());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  /** Profile IDs whose icon is currently being generated in the
   * background. Lets the ProfileEditor show a spinner without blocking
   * Save / Close — the generation continues even after the dialog is
   * dismissed, and updates the profile's icon path in place when done. */
  const [pendingIconGenerations, setPendingIconGenerations] = useState<Set<string>>(new Set());
  const [iconRevision, setIconRevision] = useState(0);
  const [shellOpenSet, setShellOpenSet] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  // Sidebar collapse-to-icons mode. Drives a snap behaviour when dragging
  // the resize handle past a threshold. When true, `sidebarWidth` is the
  // saved expanded width to restore on un-collapse; the rendered width is
  // `SIDEBAR_COMPACT_WIDTH`.
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [layout, setLayout] = useState<SidebarLayout>({ items: [], folders: [] });
  // Overlay visibility is per-VIEW so each parallel agent has its own state
  // independent of the parent profile and its siblings. View key is the
  // profileId for the parent view, or `${profileId}|${parallelId}` for a
  // parallel agent's view. The parent view's key is just `${profileId}` so
  // existing behavior (open Files on profile A, switch to B, switch back —
  // Files reappears) is preserved.
  const [filesViews, setFilesViews] = useState<Set<string>>(new Set());
  // Files mounts persist for every view that has ever been opened (same
  // pattern as kanbanRunning / webRunning). Lets a profile keep its open
  // tabs + unsaved edits across tab toggles and profile switches.
  const [filesRunning, setFilesRunning] = useState<Set<string>>(new Set());
  // kanbanViews = views whose Kanban tab is currently SHOWN (overlay active).
  // kanbanRunning = views whose KanbanViewer is mounted and whose Ordna
  // instance is alive in the background. kanbanRunning ⊇ kanbanViews.
  // Closing the Kanban tab only removes from kanbanViews, so re-opening
  // shows the existing Ordna view without reloading.
  const [kanbanViews, setKanbanViews] = useState<Set<string>>(new Set());
  const [kanbanRunning, setKanbanRunning] = useState<Set<string>>(new Set());
  // Web (in-app browser) views — mirrors the kanbanViews/kanbanRunning
  // pattern. `webViews` = currently shown as the active overlay (or as
  // the right pane in split mode). `webRunning` = ever opened so the
  // <webview> stays mounted and keeps its history/scroll position.
  const [webViews, setWebViews] = useState<Set<string>>(new Set());
  const [webRunning, setWebRunning] = useState<Set<string>>(new Set());
  // External navigation request for the Web tab (triggered by clicking a
  // link in the agent terminal). Keyed by viewKey so each profile/parallel
  // routes its own navigations; nonce so a re-click of the same URL still
  // navigates.
  const [pendingWebNavigate, setPendingWebNavigate] = useState<{ key: string; url: string; nonce: number } | null>(null);
  // Per-view-key: when true, the Agent terminal is pinned to the left half
  // and the right half shows Files or Kanban side-by-side. Toggled via the
  // split button next to the Kanban tab. Persisted across app restarts
  // via `settings.openFunctionTabs` — parallel-agent keys are
  // session-bound and excluded from the persisted snapshot.
  const [splitViews, setSplitViews] = useState<Set<string>>(new Set());
  // Views where the user EXPLICITLY turned split off. Together with
  // splitViews this forms a tri-state per view: explicit-on / explicit-off
  // / unset. Unset views follow `settings.defaultSplitView` on first
  // activation; explicit choices persist (as split:false) and always win.
  const [splitOffViews, setSplitOffViews] = useState<Set<string>>(new Set());
  // Per-view-key: when true, the FileExplorer's "show only git-changed
  // files" toggle is on. Lifted from FileExplorer so each profile (and
  // each parallel agent view) remembers the state and so we can persist
  // it under settings.openFunctionTabs[key].showChanged alongside the
  // rest of the pane state.
  const [showChangedFilesViews, setShowChangedFilesViews] = useState<Set<string>>(new Set());
  // Per-view-key snapshot of FileExplorer's open file tabs (absolute
  // paths + currently active path). Lifted out of FileExplorer so each
  // profile remembers its tabs across restarts via
  // `settings.fileExplorerTabs`. Parallel-agent keys are excluded from
  // persistence — see the parent comment on splitViews.
  const [fileExplorerTabs, setFileExplorerTabs] = useState<Record<string, { paths: string[]; activePath?: string }>>({});
  // Per-view-key list of unsaved file basenames, reported up by each
  // FileExplorer. Drives the sidebar asterisk and the quit-time dialog.
  const [dirtyFilesByView, setDirtyFilesByView] = useState<Record<string, string[]>>({});
  const dirtyFilesByViewRef = useRef<Record<string, string[]>>({});
  dirtyFilesByViewRef.current = dirtyFilesByView;
  // Imperative handles to each mounted FileExplorer, so "Save all" at quit
  // can flush every dirty buffer. Keyed by view-key.
  const explorerHandles = useRef<Map<string, FileExplorerHandle>>(new Map());
  // Quit prompt: list of { profile name, file names } with unsaved edits.
  // Non-null shows the modal; null hides it.
  const [quitPrompt, setQuitPrompt] = useState<{ profileName: string; files: string[] }[] | null>(null);
  const [agentSplitPercent, setAgentSplitPercent] = useState(50);
  // Parallel agents (Kanban-spawned worktree agents). Keyed by parallel agent id.
  const [parallelAgents, setParallelAgents] = useState<Map<string, ParallelAgent>>(new Map());
  // Which parallel-agent the user is viewing (PTY id `parallel:<id>`); null = parent profile
  const [selectedParallelId, setSelectedParallelId] = useState<string | null>(null);
  // The parallel-agent id whose Stop button was clicked — drives the
  // confirm-dialog asking whether to discard the agent's work or save
  // it as a WIP commit on its branch.
  const [stopParallelTarget, setStopParallelTarget] = useState<string | null>(null);

  // ── Agent session selection (right-click profile → start/resume) ──
  // Built-in agents only. The menu opens at the cursor; the picker lists
  // the agent's past sessions for the project. Starting a session uses the
  // profile's terminal when idle, or a worktree when it's already running.
  const [sessionMenu, setSessionMenu] = useState<{ profile: Profile; x: number; y: number } | null>(null);
  const [sessionPickerProfile, setSessionPickerProfile] = useState<Profile | null>(null);
  // Per-profile args consumed by TerminalPane on the next (in-place) PTY
  // creation, so a chosen session launches with `--resume <id>` (or fresh).
  const startupArgsRef = useRef<Map<string, string[]>>(new Map());

  const isBuiltinAgentProfile = useCallback(
    (p: Profile) => !!p.agentId && DEFAULT_AGENTS.some((a) => a.id === p.agentId),
    [],
  );

  // Scratchpad profiles created via the "Temp" button — their working
  // directory is an os.tmpdir() folder named by mkdtemp('vyb-agent-').
  const isTempProfile = useCallback(
    (p: Profile) => /[\\/]vyb-agent-[^\\/]*[\\/]?$/.test(p.workingDirectory),
    [],
  );

  const openSessionMenu = useCallback((e: React.MouseEvent, profile: Profile) => {
    e.preventDefault(); // suppress the native menu on any profile right-click
    // Sessions are built-in-agent-only; temp profiles additionally get
    // "Convert to project". Nothing to show otherwise.
    if (!isBuiltinAgentProfile(profile) && !isTempProfile(profile)) return;
    setSessionMenu({ profile, x: e.clientX, y: e.clientY });
  }, [isBuiltinAgentProfile, isTempProfile]);


  // Launch a session for `profile`: in the profile's own terminal when the
  // agent isn't running yet, otherwise in a fresh git worktree.
  const startAgentSession = useCallback((profile: Profile, sessionId: string | null, label: string) => {
    const agents = settingsRef.current.agents || DEFAULT_AGENTS;
    const resolved = resolveAgent(profile, agents);
    if (initialized.has(profile.id)) {
      // Already running → worktree session (persistent, user-closed).
      window.api.spawnParallelSession(profile.id, { sessionId, label }).then((res) => {
        if (res && 'id' in res) setSelectedParallelId(res.id);
        else if (res && 'error' in res) toastError(`Could not start session: ${res.error}`);
      }).catch((): void => { toastError('Could not start session.'); });
    } else {
      // Idle → start in place with the resume/new args.
      startupArgsRef.current.set(profile.id, buildSessionArgs(resolved.command, resolved.args, sessionId));
      handleSelectProfile(profile.id);
    }
  }, [initialized]);

  const consumeStartupArgs = useCallback((profileId: string): string[] | undefined => {
    const a = startupArgsRef.current.get(profileId);
    if (a) startupArgsRef.current.delete(profileId);
    return a;
  }, []);

  // Select a parallel agent row. For a session restored from a previous
  // run (phase 'stopped') this also respawns its agent inside the
  // surviving worktree — safe, because the agent's terminal is already
  // mounted (hidden) and listening, so no output is lost.
  const selectParallel = useCallback((id: string | null) => {
    setSelectedParallelId(id);
    if (!id) return;
    // Visiting the session acknowledges its unseen-update badge (same
    // semantics as handleSelectProfile for profile rows).
    setHasUpdates((prev) => {
      const key = `parallel:${id}`;
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    const agent = parallelAgents.get(id);
    if (agent?.phase === 'stopped') {
      window.api.resumeParallelSession(id).then((res) => {
        if (res && 'error' in res) toastError(`Could not resume session: ${res.error}`);
      }).catch((): void => { toastError('Could not resume session.'); });
    }
  }, [parallelAgents]);
  // When the user selects a profile whose working directory no longer
  // exists on disk, this holds the profileId so the modal below can
  // prompt for relocate / delete / cancel. The selection is deferred
  // until the modal resolves so we don't try to spawn an agent in a
  // missing directory.
  const [missingDirProfileId, setMissingDirProfileId] = useState<string | null>(null);
  // Track parallel agents whose `completed` state has been seen by the user (for soft-delete)
  const inspectedParallelRef = useRef<Set<string>>(new Set());
  const [changesVisible, setChangesVisible] = useState(false);
  const [changesWidth, setChangesWidth] = useState(50); // percent of agent pane
  const [gitPanelTab, setGitPanelTab] = useState<'changes' | 'tree' | 'branches' | 'compare'>('changes');
  const [focusedPane, setFocusedPane] = useState<{ pane: 'agent' | 'shell'; shellIndex: number }>({ pane: 'agent', shellIndex: 0 });
  const shellCountRef = useRef(1);
  const profileMemoryRef = useRef<ProfileMemoryMap>({});
  // When a file path is clicked in the agent terminal, we ensure Files is
  // visible and stash the resolved path here. FileExplorer reacts to changes
  // by opening the file in a tab. Stamped with a counter so re-clicks of the
  // same path still trigger the effect.
  const [pendingFileOpen, setPendingFileOpen] = useState<{ path: string; nonce: number; line?: number } | null>(null);
  // T-043 quick-open dialog. Cmd+P toggles. Independent of which
  // tab is currently active — opening a file via the picker pops
  // the Files tab open if it isn't already.
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  // T-044: Find-in-Files panel. Toggled by Cmd+Shift+F.
  const [findInFilesVisible, setFindInFilesVisible] = useState(false);
  // Width % of the docked Search panel (mirrors changesWidth for git).
  const [searchWidth, setSearchWidth] = useState(50);
  // Set by the Edit-menu items: tells the panel to focus (and whether to
  // expand the replace row). Nonce so repeat invocations re-trigger.
  const [findPanelRequest, setFindPanelRequest] = useState<{ withReplace: boolean; nonce: number; query?: string; wholeWord?: boolean } | null>(null);

  // Build the view key for the currently-active profile + parallel selection.
  // Parent: just the profileId. Parallel: `${profileId}|${parallelId}`.
  const activeViewKey = activeProfileId
    ? selectedParallelId
      ? `${activeProfileId}|${selectedParallelId}`
      : activeProfileId
    : null;

  // The currently-viewed working directory. For a selected parallel agent
  // this is the agent's worktree, so README/Files/Kanban panels operate on
  // the worktree's contents. Falls back to the profile's working dir.
  const selectedParallel = selectedParallelId ? parallelAgents.get(selectedParallelId) : null;
  const activeViewCwd = selectedParallel
    ? selectedParallel.worktreePath
    : profiles.find((p) => p.id === activeProfileId)?.workingDirectory || '';
  // Mirror into a ref so callbacks (openFolder, etc.) target the selected
  // session's worktree instead of the parent profile's directory.
  const activeViewCwdRef = useRef(activeViewCwd);
  activeViewCwdRef.current = activeViewCwd;

  // Derived: visible state for the currently-active view
  const filesVisible = activeViewKey ? filesViews.has(activeViewKey) : false;
  const kanbanVisible = activeViewKey ? kanbanViews.has(activeViewKey) : false;
  const webVisible = activeViewKey ? webViews.has(activeViewKey) : false;
  const [hasUpdates, setHasUpdates] = useState<Set<string>>(new Set());
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');

  // Prevent Electron default file drop behavior (navigating to file)
  useEffect(() => {
    const preventDrop = (e: DragEvent) => e.preventDefault();
    document.addEventListener('dragover', preventDrop);
    document.addEventListener('drop', preventDrop);
    return () => {
      document.removeEventListener('dragover', preventDrop);
      document.removeEventListener('drop', preventDrop);
    };
  }, []);

  // Tell main when the xterm terminal has focus, so it can drop the native
  // clipboard menu roles while typing in the terminal (xterm owns Cmd+C/V/X/A
  // there; a menu accelerator would otherwise swallow them). Anything outside
  // `.xterm` → roles restored, giving inputs / Monaco / CodeMirror / Excalidraw
  // the OS-default clipboard.
  useEffect(() => {
    let last = false;
    const report = () => {
      const el = document.activeElement as HTMLElement | null;
      const inTerminal = !!el?.closest('.xterm');
      if (inTerminal !== last) {
        last = inTerminal;
        window.api.setTerminalFocused(inTerminal);
      }
    };
    const onFocusIn = () => report();
    // focusout fires before the new element is focused; defer so
    // document.activeElement reflects the final target.
    const onFocusOut = () => setTimeout(report, 0);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  // T-043: Cmd+P (or Ctrl+P) opens the quick-open file picker. Global
  // — works regardless of which tab is active. We intercept before
  // anything else so the keystroke isn't passed through to xterm,
  // a focused input, or CodeMirror. Also wires Cmd+Shift+E for the
  // "Reveal in tree" action used by the FileExplorer toolbar.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'p' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setQuickOpenVisible((v) => !v);
      }
      if (key === 'f' && e.shiftKey) {
        // T-044 Find in Files. Stays out of xterm's way — xterm
        // doesn't bind Cmd+Shift+F. (Normally the Edit-menu accelerator
        // intercepts this first; this is the in-window fallback.) The
        // docked Search panel shares the right edge with Git.
        e.preventDefault();
        e.stopPropagation();
        setChangesVisible(false);
        setFindInFilesVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Load settings and profiles on mount
  useEffect(() => {
    window.api.loadSettings().then(async (loaded) => {
      // Workspaces migration + SELF-HEAL. The old behaviour ("if
      // workspaces is empty, create one Default") would silently wipe
      // named workspaces whenever some other writer dropped the
      // workspaces[] field — e.g. an older Vyb build sharing the same
      // userData dir. Instead, reconcile: ensure (a) at least one
      // workspace exists to host untagged entries, and (b) EVERY
      // workspaceId referenced by a profile or folder has a workspace
      // entry — re-adding any that went missing so their profiles
      // never become invisible. Original names of dropped workspaces
      // can't be recovered, but the grouping + profiles survive and
      // the user can rename. Needs profiles + layout to find the
      // referenced ids, so it loads them here (set into state by their
      // own loaders below — this read is just for reconciliation).
      const [reconProfiles, reconLayout] = await Promise.all([
        window.api.getProfiles().catch(() => [] as Profile[]),
        window.api.loadLayout().catch(() => ({ items: [], folders: [] } as SidebarLayout)),
      ]);
      const referenced = new Set<string>();
      for (const p of reconProfiles) if (p.workspaceId) referenced.add(p.workspaceId);
      for (const f of (reconLayout.folders ?? [])) if (f.workspaceId) referenced.add(f.workspaceId);

      const workspaces: Workspace[] = Array.isArray(loaded.workspaces) ? [...loaded.workspaces] : [];
      const existing = new Set(workspaces.map((w) => w.id));
      let changed = false;

      if (workspaces.length === 0) {
        workspaces.push({ id: `ws-${Date.now().toString(36)}`, name: 'Default' });
        existing.add(workspaces[0].id);
        changed = true;
      }
      let recoveredCount = 0;
      for (const id of referenced) {
        if (!existing.has(id)) {
          workspaces.push({ id, name: `Recovered ${++recoveredCount}` });
          existing.add(id);
          changed = true;
        }
      }
      // Focus, on launch, the workspace that owns the agent profile we'll
      // auto-select — the saved `lastActiveProfileId`, or the first profile
      // as a fallback — so the selected agent is actually visible in the
      // sidebar. (A profile with no workspaceId is a legacy/Default one.)
      const autoProfile =
        (loaded.lastActiveProfileId && reconProfiles.find((p) => p.id === loaded.lastActiveProfileId))
        || reconProfiles[0];
      const desiredWs = autoProfile?.workspaceId || workspaces[0]?.id;
      let activeWorkspaceId = loaded.activeWorkspaceId;
      if (desiredWs && existing.has(desiredWs)) {
        if (activeWorkspaceId !== desiredWs) {
          activeWorkspaceId = desiredWs;
          changed = true;
        }
      } else if (!activeWorkspaceId || !existing.has(activeWorkspaceId)) {
        activeWorkspaceId = workspaces[0].id;
        changed = true;
      }
      if (changed) {
        if (recoveredCount > 0) {
          console.warn(`[Vyb] reconstructed ${recoveredCount} missing workspace(s) referenced by profiles/folders`);
        }
        loaded = { ...loaded, workspaces, activeWorkspaceId };
        window.api.saveSettings(loaded).catch((): void => undefined);
      }
      setSettings(loaded);
      setSidebarWidth(loaded.sidebarWidth);
      setSidebarCompact(loaded.sidebarCompact === true);
      logicalSidebarWidthRef.current = loaded.sidebarCompact === true
        ? SIDEBAR_COMPACT_WIDTH
        : loaded.sidebarWidth;
      if (typeof loaded.agentSplitPercent === 'number') {
        setAgentSplitPercent(loaded.agentSplitPercent);
      }
      applyTheme(loaded.baseHue, loaded.darkness, loaded.textLightness, loaded.profileFontSize, {
        intensity: loaded.flameIntensity,
        spread: loaded.flameSpread,
        length: loaded.flameLength,
        speed: loaded.flameSpeed,
      }, loaded.profileFontWeight);

      // Restore per-profile function-tab + split-view layout. The
      // matching `running` sets are seeded too so the corresponding
      // overlay components mount on first render (they're kept
      // mounted with display:none when hidden — losing them would
      // discard the user's in-progress state like open file tabs).
      const remembered = loaded.openFunctionTabs;
      if (remembered) {
        const files = new Set<string>();
        const kanban = new Set<string>();
        const web = new Set<string>();
        const split = new Set<string>();
        const showChanged = new Set<string>();
        const splitOff = new Set<string>();
        for (const [key, state] of Object.entries(remembered)) {
          if (state?.files) files.add(key);
          if (state?.kanban) kanban.add(key);
          if (state?.web) web.add(key);
          if (state?.split) split.add(key);
          // split === false is the EXPLICIT "user turned split off" marker
          // (vs. absent = unset → follows settings.defaultSplitView).
          if (state?.split === false) splitOff.add(key);
          if (state?.showChanged) showChanged.add(key);
        }
        if (files.size > 0) {
          setFilesViews(files);
          setFilesRunning(new Set(files));
        }
        if (kanban.size > 0) {
          setKanbanViews(kanban);
          setKanbanRunning(new Set(kanban));
        }
        if (web.size > 0) {
          setWebViews(web);
          setWebRunning(new Set(web));
        }
        if (split.size > 0) setSplitViews(split);
        if (splitOff.size > 0) setSplitOffViews(splitOff);
        if (showChanged.size > 0) setShowChangedFilesViews(showChanged);
      }

      // Open file-explorer tabs are persisted separately because the
      // payload is larger than the boolean flags in openFunctionTabs.
      // Parallel-agent keys are already filtered out at write time.
      if (loaded.fileExplorerTabs && Object.keys(loaded.fileExplorerTabs).length > 0) {
        setFileExplorerTabs(loaded.fileExplorerTabs);
      }
    });

    window.api.loadLayout().then(setLayout);

    // Restore shell open states from profile memory
    window.api.loadProfileMemory().then((memory) => {
      profileMemoryRef.current = memory;
      const restored = new Set<string>();
      for (const [pid, mem] of Object.entries(memory)) {
        if (mem.shellOpen) restored.add(pid);
      }
      if (restored.size > 0) setShellOpenSet(restored);
    });

    Promise.all([window.api.getProfiles(), window.api.loadSettings()]).then(async ([loadedProfiles, loadedSettings]) => {
      setProfiles(loadedProfiles);
      if (loadedProfiles.length > 0) {
        const lastId = loadedSettings.lastActiveProfileId;
        const lastProfile = lastId ? loadedProfiles.find((p) => p.id === lastId) : null;
        if (lastProfile) {
          // Workspace focus is handled authoritatively by the settings /
          // workspace-recovery loader above, which focuses this same
          // auto-selected profile's workspace. Here we only restore the
          // profile selection itself (avoids a racy second writer to
          // activeWorkspaceId).
          const ok = await window.api.pathExists(lastProfile.workingDirectory).catch(() => true);
          if (ok) {
            setActiveProfileId(lastProfile.id);
          } else {
            // Working directory disappeared between sessions. Pop the
            // locate/delete modal up front so the user resolves it
            // before anything else tries to use the bad path. We
            // intentionally don't auto-activate the profile — that
            // would trigger the auto-init effect and try to spawn the
            // agent in the missing directory. The user can pick
            // another profile or resolve the dialog first.
            setMissingDirProfileId(lastProfile.id);
          }
        } else {
          setActiveProfileId(loadedProfiles[0].id);
        }
      }
    });

    // Seed the status map with whatever the main process currently knows.
    // This recovers the correct badge colours after a renderer reload (Vite HMR,
    // DevTools refresh) where main has live agents but the renderer state reset.
    window.api.queryStatuses().then((snap) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        for (const [pid, st] of Object.entries(snap)) {
          next.set(pid, st as AgentStatus);
        }
        return next;
      });
      setInitialized((prev) => {
        const next = new Set(prev);
        for (const pid of Object.keys(snap)) next.add(pid);
        return next;
      });
    });

    const unsubStatus = window.api.onStatusChange(({ profileId, status, hasNewContent }) => {
      setStatuses((prev) => {
        const next = new Map(prev);
        next.set(profileId, status as AgentStatus);

        // The bell for working→ready completions is now driven by the
        // delayed PROFILE_COMPLETION_CONFIRMED channel below — main holds it
        // for 5 s to filter out false-positive "done" transitions caused by
        // brief idle moments between Claude turns. We still surface
        // needs-input immediately since that's user-blocking.
        if (status === 'needs-input') {
          setHasUpdates((u) => {
            const updated = new Set(u);
            updated.add(profileId);
            return updated;
          });
        }

        return next;
      });

      // Auto-paste hook for parallel agents: as soon as the spawned CLI's
      // prompt is ready (status: 'ready' / 'needs-input'), drop the queued
      // task into the input. The `parallelAgentAutoRun` setting only
      // controls whether we *also* press Enter — when it's off the task
      // sits in the prompt for the user to review and submit manually.
      if (
        profileId.startsWith('parallel:') &&
        (status === 'ready' || status === 'needs-input')
      ) {
        const id = profileId.slice('parallel:'.length);
        const submit = settingsRef.current.parallelAgentAutoRun !== false;
        tryAutoRunParallelRef.current?.(id, submit);
      }
      // Reference hasNewContent so eslint doesn't flag it; it remains in the
      // payload for forward-compat / future renderers that want to bypass
      // the confirmation delay.
      void hasNewContent;
    });

    const unsubCompletion = window.api.onCompletionConfirmed(({ profileId }) => {
      // Main has confirmed the agent stayed ready for 5 s without going
      // back to working — this is a real completion. Light up the bell.
      setHasUpdates((u) => {
        const updated = new Set(u);
        updated.add(profileId);
        return updated;
      });
    });

    const unsubSettings = window.api.onOpenSettings(() => {
      setSettingsOpen(true);
    });

    // File → New Agent Profile: open the editor in create mode. The saved
    // profile lands in the active workspace (see handleSaveProfile).
    const unsubNewProfile = window.api.onMenuNewProfile(() => {
      setEditingProfile(null);
      setEditorOpen(true);
    });

    // Edit → Find in Files / Replace in Files: open the docked Search
    // panel (closing the Git panel — they share the right edge).
    const unsubFindInFiles = window.api.onMenuFindInFiles(({ withReplace }) => {
      setChangesVisible(false);
      setFindInFilesVisible(true);
      setFindPanelRequest({ withReplace, nonce: Date.now() });
    });

    // Handle notification click — switch to the profile (and parallel sub-
    // agent if any) that needs attention. Routes through `goToProfile`
    // so a profile in a different workspace also pulls the sidebar
    // over to that workspace; otherwise the user clicks the notification
    // and "nothing happens" because the selected profile is filtered
    // out of the currently-visible workspace.
    const unsubActivate = window.api.onActivateProfileRequest(({ profileId, parallelAgentId }) => {
      stoppedRef.current.delete(profileId);
      goToProfileRef.current(profileId);
      setSelectedParallelId(parallelAgentId);
      setHasUpdates((prev) => {
        if (!prev.has(profileId)) return prev;
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
    });

    const unsubOrdnaTask = window.api.onOrdnaTask((envelope) => {
      // Prefer the profile whose Ordna instance dispatched the task; fall back
      // to the active profile if the cwd lookup didn't find a match.
      const target = envelope.sourceProfileId ?? activeProfileIdRef.current;
      if (!target) {
        console.warn('Ordna task received but no active profile to receive it');
        return;
      }
      const payload = envelope.payload;

      // If the receiving profile has parallel-agent mode enabled, spawn a new
      // worktree+agent for this task instead of injecting into the main agent.
      const targetProfile = profilesRef.current.find((p) => p.id === target);
      if (targetProfile?.parallelAgentEnabled) {
        window.api
          .spawnParallelAgent(target, {
            id: payload.task.id,
            title: payload.task.title,
            filePath: payload.task.filePath,
          })
          .then((res) => {
            if ('error' in res) {
              console.error('spawn parallel agent failed:', res.error);
              return;
            }
            // Build the message with worktree-rewritten paths so the agent
            // never touches the parent repo.
            const message = buildOrdnaTaskMessage(payload, {
              worktreePath: res.worktreePath,
              branch: res.branch,
              parentRepoPath: res.parentRepoPath,
            });
            pendingParallelMessagesRef.current.set(res.id, message);
            setParallelAgents((prev) => new Map(prev).set(res.id, res));

            // Auto-paste fires from two sources: the status-change listener
            // (when 'ready' / 'needs-input' is detected) AND a 4 s fallback
            // timer. tryAutoRunParallel is idempotent — once it sends, it
            // deletes the pending message so the second trigger is a no-op.
            // The paste runs regardless of `parallelAgentAutoRun`; the
            // toggle only decides whether Enter is pressed to submit.
            const submit = settingsRef.current.parallelAgentAutoRun !== false;

            // Switch to the new parallel agent only when auto-submit is OFF
            // — that case wants the user to review the pasted task and
            // click ▶, so they need to see the new pane. With auto-submit
            // on, the agent runs autonomously and the user keeps their
            // current view (typically the Kanban board).
            if (!submit) {
              setSelectedParallelId(res.id);
            }

            const timer = setTimeout(() => {
              tryAutoRunParallel(res.id, submit);
            }, 4000);
            autoRunTimersRef.current.set(res.id, timer);
          });
        return;
      }

      // If the receiving view has split-pane enabled, the agent is
      // already visible on the left — closing the Kanban / Files /
      // Web overlay would just blank the right pane and flash a
      // jarring "where did my board go?" moment. Leave the right
      // pane as-is and only focus the agent so input lands there.
      // When split isn't on, fall back to the old behavior: hide
      // every overlay so the full agent surface comes forward.
      // Read the live split state via the ref — the listener was
      // mounted with empty deps so `splitViews` from the closure
      // would always be the initial empty Set, defeating the check.
      const targetIsSplit = splitViewsRef.current.has(target);
      if (!targetIsSplit) {
        const dropParent = (prev: Set<string>): Set<string> => {
          if (!prev.has(target)) return prev;
          const next = new Set(prev);
          next.delete(target);
          return next;
        };
        setKanbanViews(dropParent);
        setFilesViews(dropParent);
        setWebViews(dropParent);
      }
      // Drop back to the parent view so the user immediately sees the agent
      // they just dispatched to. Parallel sub-view selection also resets so
      // the typed message lands in the parent agent terminal.
      setSelectedParallelId(null);
      setEditorOpen(false);
      setSettingsOpen(false);
      setFocusedPane({ pane: 'agent', shellIndex: 0 });

      const message = buildOrdnaTaskMessage(payload);
      window.api.sendInput(target, message + '\r');
    });

    // Seed with any sessions restored from a previous run (persisted
    // worktree sessions come back as phase 'stopped'; selecting one
    // respawns its agent). Without this fetch the sidebar would only
    // learn about agents via change events.
    window.api.listParallelAgents().then((agents) => {
      if (!agents || agents.length === 0) return;
      setParallelAgents((prev) => {
        const next = new Map(prev);
        for (const a of agents) if (!next.has(a.id)) next.set(a.id, a);
        return next;
      });
    }).catch((): void => undefined);

    // Mirror parallel-agent state from main into the renderer
    const unsubParallelChange = window.api.onParallelAgentChange((agent) => {
      setParallelAgents((prev) => new Map(prev).set(agent.id, agent));
    });
    const unsubParallelExit = window.api.onParallelAgentExited((agent) => {
      setParallelAgents((prev) => {
        if (!prev.has(agent.id)) return prev;
        const next = new Map(prev);
        next.delete(agent.id);
        return next;
      });
      pendingParallelMessagesRef.current.delete(agent.id);
      const t = autoRunTimersRef.current.get(agent.id);
      if (t) {
        clearTimeout(t);
        autoRunTimersRef.current.delete(agent.id);
      }
      // Drop overlay/Kanban state for this parallel agent's view so a
      // re-spawn under the same id (or simply leaving the view) doesn't
      // resurrect stale state. Also stop its Ordna instance if we started one.
      const viewKey = `${agent.profileId}|${agent.id}`;
      const dropOne = (prev: Set<string>): Set<string> => {
        if (!prev.has(viewKey)) return prev;
        const next = new Set(prev);
        next.delete(viewKey);
        return next;
      };
      setFilesViews(dropOne);
      setKanbanViews(dropOne);
      setKanbanRunning((prev) => {
        if (!prev.has(viewKey)) return prev;
        window.api.stopOrdna(viewKey).catch((): void => undefined);
        const next = new Set(prev);
        next.delete(viewKey);
        return next;
      });
      // If the user was looking at this sub-agent, drop back to the parent profile
      setSelectedParallelId((curr) => (curr === agent.id ? null : curr));
    });

    // When an Ordna TUI process exits (e.g. user pressed `q`), close the
    // Kanban panel for that view and unmount its viewer entirely. The
    // instanceKey identifies which view (parent or a specific parallel).
    const unsubOrdnaExit = window.api.onOrdnaExited(({ instanceKey }) => {
      const drop = (prev: Set<string>): Set<string> => {
        if (!prev.has(instanceKey)) return prev;
        const next = new Set(prev);
        next.delete(instanceKey);
        return next;
      };
      setKanbanViews(drop);
      setKanbanRunning(drop);
    });

    return () => {
      unsubStatus();
      unsubCompletion();
      unsubSettings();
      unsubNewProfile();
      unsubFindInFiles();
      unsubActivate();
      unsubOrdnaTask();
      unsubOrdnaExit();
      unsubParallelChange();
      unsubParallelExit();
    };
  }, []);

  // Keep a ref to the active profile id so async listeners read the current value
  const activeProfileIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

  // `goToProfile` rebinds whenever profiles/workspaces change; the
  // notification-activate listener subscribes once on mount, so it
  // needs to call through a ref to always reach the latest version
  // (otherwise a notification fired after a workspace change would
  // route via the stale first-render handler and skip the switch).
  // The ref itself is declared here; it's updated by an effect placed
  // *after* `goToProfile`'s declaration further down the file.
  const goToProfileRef = useRef<(id: string) => void>(() => undefined);

  // File-token clicks from the agent terminal — open Files pane in the
  // current view and stash the resolved path for FileExplorer to consume.
  // Other overlays (README/Kanban) get hidden so the file is actually visible.
  useEffect(() => {
    const handleOpenFile = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; line?: number }>).detail;
      if (!detail?.path) return;
      if (activeViewKey) {
        const key = activeViewKey;
        setFilesViews((prev) => ensureInSet(prev, key));
        setFilesRunning((prev) => ensureInSet(prev, key));
        setKanbanViews((prev) => removeFromSet(prev, key));
        setWebViews((prev) => removeFromSet(prev, key));
      }
      setPendingFileOpen({ path: detail.path, nonce: Date.now(), line: detail.line });
    };
    window.addEventListener('open-file-in-explorer', handleOpenFile);
    return () => window.removeEventListener('open-file-in-explorer', handleOpenFile);
  }, [activeViewKey]);

  // Link clicks from the agent terminal — when the Web function is on,
  // TerminalPane dispatches this event instead of calling shell.openExternal
  // (see openTerminal in TerminalPane.tsx). We surface the embedded Web
  // tab for the active view and push the URL into the matching WebViewer
  // via the pendingWebNavigate state. Other right-pane overlays close so
  // the Web view is visible; split mode is respected — the URL lands on
  // the right pane there too.
  useEffect(() => {
    const handleOpenUrl = (e: Event) => {
      const detail = (e as CustomEvent<{ url: string }>).detail;
      if (!detail?.url) return;
      const key = activeViewKey;
      if (!key) return;
      setWebRunning((prev) => ensureInSet(prev, key));
      setWebViews((prev) => ensureInSet(prev, key));
      setKanbanViews((prev) => removeFromSet(prev, key));
      setFilesViews((prev) => removeFromSet(prev, key));
      setPendingWebNavigate({ key, url: detail.url, nonce: Date.now() });
    };
    window.addEventListener('open-url-in-browser', handleOpenUrl);
    return () => window.removeEventListener('open-url-in-browser', handleOpenUrl);
  }, [activeViewKey]);

  // Mirror profiles into a ref so the once-mounted onOrdnaTask listener can
  // look up profile.parallelAgentEnabled at hook-fire time.
  const profilesRef = useRef<Profile[]>([]);
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  // Aggregate unsaved files by profile (a profile may have a main view plus
  // parallel-agent views, keyed `profileId|parallelId`). Drives the sidebar
  // asterisk; the quit dialog rebuilds the same thing from the ref.
  const dirtyProfileIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [key, names] of Object.entries(dirtyFilesByView)) {
      if (names && names.length) ids.add(key.includes('|') ? key.slice(0, key.indexOf('|')) : key);
    }
    return ids;
  }, [dirtyFilesByView]);

  // Quit handshake: when main asks (Cmd+Q or window close), collect the
  // profiles with unsaved files. If none, allow the quit immediately;
  // otherwise show the Save all / Discard / Cancel dialog.
  useEffect(() => {
    return window.api.onAppBeforeQuit(() => {
      const byProfile = new Map<string, string[]>();
      for (const [key, paths] of Object.entries(dirtyFilesByViewRef.current)) {
        if (!paths || !paths.length) continue;
        const pid = key.includes('|') ? key.slice(0, key.indexOf('|')) : key;
        const arr = byProfile.get(pid) || [];
        // dirtyFilesByView stores absolute paths; the dialog shows basenames.
        for (const p of paths) {
          const base = p.split('/').pop() || p;
          if (!arr.includes(base)) arr.push(base);
        }
        byProfile.set(pid, arr);
      }
      if (byProfile.size === 0) {
        window.api.sendQuitDecision(true);
        return;
      }
      const prompts = [...byProfile.entries()].map(([pid, files]) => ({
        profileName: profilesRef.current.find((p) => p.id === pid)?.name || pid,
        files,
      }));
      setQuitPrompt(prompts);
    });
  }, []);

  const handleQuitSaveAll = useCallback(async () => {
    await Promise.all(
      [...explorerHandles.current.values()].map((h) => h.saveAll().catch((): void => undefined)),
    );
    setQuitPrompt(null);
    window.api.sendQuitDecision(true);
  }, []);
  const handleQuitDiscard = useCallback(() => {
    setQuitPrompt(null);
    window.api.sendQuitDecision(true);
  }, []);
  const handleQuitCancel = useCallback(() => {
    setQuitPrompt(null);
    window.api.sendQuitDecision(false);
  }, []);

  // Same shim for splitViews — the Ordna task listener is mounted once
  // (with `[]` deps), so a direct `splitViews.has(target)` inside the
  // listener would always read the initial empty Set. The ref tracks
  // the live state instead.
  const splitViewsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    splitViewsRef.current = splitViews;
  }, [splitViews]);

  // Mirror the selected parallel agent to the main process so it can suppress
  // notifications for the sub-agent the user is currently looking at.
  useEffect(() => {
    window.api.setSelectedParallelAgent(selectedParallelId);
  }, [selectedParallelId]);

  // Pending task messages awaiting paste into a freshly-spawned parallel agent.
  // Keyed by parallel agent id. The TerminalPane is responsible for writing
  // these once the agent's xterm.js mounts.
  const pendingParallelMessagesRef = useRef<Map<string, string>>(new Map());
  // Auto-run timers per parallel agent — fires after a short delay so the
  // agent CLI has time to render its prompt before we paste the task.
  const autoRunTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const submitParallelTask = useCallback((id: string) => {
    const ptyId = `parallel:${id}`;
    const t = autoRunTimersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      autoRunTimersRef.current.delete(id);
    }
    const msg = pendingParallelMessagesRef.current.get(id);
    if (msg) {
      window.api.sendInput(ptyId, msg + '\r');
      pendingParallelMessagesRef.current.delete(id);
    } else {
      window.api.sendInput(ptyId, '\r');
    }
  }, []);

  /** Auto-paste a queued task into a spawned parallel agent. Called by
   * both the 4 s fallback timer AND the status-change listener (which
   * fires when the agent CLI's prompt becomes ready). The dual trigger
   * covers the race where the fixed timer would have fired before the
   * CLI was accepting stdin: whichever signal arrives first pastes, and
   * the loser becomes a no-op since the pending message is deleted on
   * send. The `submit` flag controls whether to also press Enter — when
   * `parallelAgentAutoRun` is off the user wants the task pasted but
   * left in the prompt so they can review before submitting. */
  const tryAutoRunParallel = useCallback((id: string, submit: boolean) => {
    const msg = pendingParallelMessagesRef.current.get(id);
    if (!msg) return; // already sent (or never queued)
    const t = autoRunTimersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      autoRunTimersRef.current.delete(id);
    }
    const ptyId = `parallel:${id}`;
    // Paste body first. The CLI's auto-paste detection groups bytes that
    // arrive in rapid succession into a single paste, so a trailing \r in
    // the same chunk is treated as just another embedded newline rather
    // than a submit. Send Enter as a separate keystroke after a long
    // enough pause that the CLI has closed the paste boundary.
    window.api.sendInput(ptyId, msg);
    pendingParallelMessagesRef.current.delete(id);
    if (submit) {
      setTimeout(() => window.api.sendInput(ptyId, '\r'), 800);
    }
  }, []);
  // Mirror into a ref so the once-mounted onStatusChange listener (which
  // captured this scope on first render) can still call the current
  // version. useCallback([]) gives a stable identity, but using the ref
  // keeps the listener resilient to future refactors that change the deps.
  const tryAutoRunParallelRef = useRef(tryAutoRunParallel);
  useEffect(() => {
    tryAutoRunParallelRef.current = tryAutoRunParallel;
  }, [tryAutoRunParallel]);

  const cancelAutoRun = useCallback((id: string) => {
    const t = autoRunTimersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      autoRunTimersRef.current.delete(id);
    }
  }, []);

  // Soft-delete timers for parallel agents that have reached `completed`.
  // The agent auto-removes 30s after the user navigates AWAY from it (i.e.
  // they inspected it then moved on). If they come back, the timer is reset.
  const softDeleteTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    const timers = softDeleteTimersRef.current;
    for (const agent of parallelAgents.values()) {
      const isCompleted = agent.phase === 'completed';
      const isSelected = selectedParallelId === agent.id && activeProfileId === agent.profileId;
      const hasInspected = inspectedParallelRef.current.has(agent.id);
      if (isCompleted && isSelected) {
        inspectedParallelRef.current.add(agent.id);
        // Cancel pending destroy if user came back
        const t = timers.get(agent.id);
        if (t) {
          clearTimeout(t);
          timers.delete(agent.id);
        }
      } else if (isCompleted && hasInspected && !isSelected && !timers.has(agent.id)) {
        // Schedule auto-removal 30s after the user navigates away
        const t = setTimeout(() => {
          window.api.destroyParallelAgent(agent.id).catch((): void => undefined);
          timers.delete(agent.id);
        }, 30_000);
        timers.set(agent.id, t);
      }
    }
    return () => {
      // No cleanup on every render — timers persist across renders
    };
  }, [parallelAgents, selectedParallelId, activeProfileId]);
  useEffect(() => {
    return () => {
      for (const t of softDeleteTimersRef.current.values()) clearTimeout(t);
      softDeleteTimersRef.current.clear();
    };
  }, []);

  // Apply theme whenever settings change
  useEffect(() => {
    applyTheme(settings.baseHue, settings.darkness, settings.textLightness, settings.profileFontSize, {
      intensity: settings.flameIntensity,
      spread: settings.flameSpread,
      length: settings.flameLength,
      speed: settings.flameSpeed,
    }, settings.profileFontWeight);
  }, [settings]);

  // Sync active profile to main process for notification suppression + persist
  useEffect(() => {
    window.api.setActiveProfile(activeProfileId);
    if (activeProfileId) {
      window.api.saveSettings({ ...settings, lastActiveProfileId: activeProfileId });
    }
  }, [activeProfileId]);

  const handleSaveSettings = async (newSettings: AppSettings) => {
    await window.api.saveSettings(newSettings);
    setSettings(newSettings);
    setSettingsOpen(false);
  };

  // Workspace handlers. Mutations write through settings since workspaces
  // live there (one small array; not worth a separate file). Each one
  // saves immediately so a crash mid-edit doesn't lose the change.
  const handleSelectWorkspace = useCallback((workspaceId: string) => {
    if (!settings.workspaces.some((w) => w.id === workspaceId)) return;
    const next = { ...settings, activeWorkspaceId: workspaceId };
    setSettings(next);
    window.api.saveSettings(next).catch((): void => undefined);
  }, [settings]);

  const handleAddWorkspace = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ws: Workspace = {
      id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
    };
    const next = {
      ...settings,
      workspaces: [...settings.workspaces, ws],
      activeWorkspaceId: ws.id, // switch to the just-created one
    };
    setSettings(next);
    window.api.saveSettings(next).catch((): void => undefined);
  }, [settings]);

  const handleRenameWorkspace = useCallback((workspaceId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = {
      ...settings,
      workspaces: settings.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, name: trimmed } : w,
      ),
    };
    setSettings(next);
    window.api.saveSettings(next).catch((): void => undefined);
  }, [settings]);

  // Workspace settings modal (name + icon reference image) — same shape
  // as the folder-config save. Empty referenceImage clears the override.
  const handleUpdateWorkspace = useCallback((workspaceId: string, patch: { name?: string; referenceImage?: string }) => {
    const name = patch.name?.trim();
    const next = {
      ...settings,
      workspaces: settings.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              ...(name ? { name } : {}),
              // Only touch the reference when the key is present in the
              // patch; '' explicitly clears the override.
              ...('referenceImage' in patch
                ? { referenceImage: patch.referenceImage || undefined }
                : {}),
            }
          : w,
      ),
    };
    setSettings(next);
    window.api.saveSettings(next).catch((): void => undefined);
  }, [settings]);

  // Select a profile that may live in a different workspace than the
  // one currently shown — switches the sidebar to the profile's
  // workspace first so it's actually visible. Used by paths that can
  // land on an arbitrary profile: notification clicks (agent
  // completed / needs input), lastActiveProfileId restore on boot.
  // Sidebar / keyboard navigation don't need this — they can only
  // pick profiles already in the active workspace.
  const goToProfile = useCallback((profileId: string) => {
    const p = profiles.find((x) => x.id === profileId);
    if (!p) {
      setActiveProfileId(profileId);
      return;
    }
    // Legacy profiles without an explicit workspaceId belong to the
    // first (Default) workspace under the migration rules.
    const targetWs = p.workspaceId || settings.workspaces[0]?.id;
    if (targetWs && targetWs !== settings.activeWorkspaceId) {
      const next = { ...settings, activeWorkspaceId: targetWs };
      setSettings(next);
      window.api.saveSettings(next).catch((): void => undefined);
    }
    setActiveProfileId(profileId);
  }, [profiles, settings]);

  // Keep `goToProfileRef` (declared up near the other refs) tracking
  // the latest `goToProfile` so the once-mounted notification-activate
  // listener always sees current profile/workspace state.
  useEffect(() => {
    goToProfileRef.current = goToProfile;
  }, [goToProfile]);

  // Move a profile (or a folder + every profile inside it) into a
  // target workspace. Drag-and-drop from the sidebar lands here. A
  // folder move cascades to every member profile so the folder stays
  // self-contained — moving the folder doesn't leave its profiles
  // stranded in the source workspace. No-ops when the target is the
  // current workspace or the payload doesn't resolve.
  const handleMoveToWorkspace = useCallback(async (
    payload: { type: 'profile' | 'folder'; id: string },
    targetWorkspaceId: string,
  ) => {
    if (!settings.workspaces.some((w) => w.id === targetWorkspaceId)) return;

    if (payload.type === 'profile') {
      const target = profiles.find((p) => p.id === payload.id);
      if (!target || target.workspaceId === targetWorkspaceId) return;
      const updated = profiles.map((p) =>
        p.id === payload.id ? { ...p, workspaceId: targetWorkspaceId } : p,
      );
      setProfiles(updated);
      window.api.saveProfiles(updated).catch((): void => undefined);
      return;
    }

    // Folder move — tag the folder and every member profile.
    const folder = layout.folders.find((f) => f.id === payload.id);
    if (!folder || folder.workspaceId === targetWorkspaceId) return;
    const memberIds = new Set(folder.profileIds);
    const updatedFolders = layout.folders.map((f) =>
      f.id === payload.id ? { ...f, workspaceId: targetWorkspaceId } : f,
    );
    const updatedProfiles = profiles.map((p) =>
      memberIds.has(p.id) ? { ...p, workspaceId: targetWorkspaceId } : p,
    );
    const newLayout = { ...layout, folders: updatedFolders };
    setLayout(newLayout);
    setProfiles(updatedProfiles);
    await Promise.all([
      window.api.saveLayout(newLayout).catch((): void => undefined),
      window.api.saveProfiles(updatedProfiles).catch((): void => undefined),
    ]);
  }, [settings.workspaces, profiles, layout]);

  // Delete a workspace. If it contains profiles / folders (explicit
  // workspaceId match), they are reassigned to the first remaining
  // workspace — no data loss. Refuses to delete the last workspace.
  const handleDeleteWorkspace = useCallback(async (workspaceId: string) => {
    if (settings.workspaces.length <= 1) return; // always keep at least one
    const remaining = settings.workspaces.filter((w) => w.id !== workspaceId);
    const fallbackId = remaining[0].id;

    // Reassign profiles tagged with the deleted workspace.
    const movedProfiles = profiles.map((p) =>
      p.workspaceId === workspaceId ? { ...p, workspaceId: fallbackId } : p,
    );
    if (movedProfiles.some((p, i) => p !== profiles[i])) {
      setProfiles(movedProfiles);
      window.api.saveProfiles(movedProfiles).catch((): void => undefined);
    }
    // Reassign folders too. Items don't carry workspaceId themselves;
    // they reference profiles/folders which already moved.
    const movedFolders = layout.folders.map((f) =>
      f.workspaceId === workspaceId ? { ...f, workspaceId: fallbackId } : f,
    );
    if (movedFolders.some((f, i) => f !== layout.folders[i])) {
      const movedLayout = { ...layout, folders: movedFolders };
      setLayout(movedLayout);
      window.api.saveLayout(movedLayout).catch((): void => undefined);
    }
    const next = {
      ...settings,
      workspaces: remaining,
      activeWorkspaceId: settings.activeWorkspaceId === workspaceId
        ? fallbackId
        : settings.activeWorkspaceId,
    };
    setSettings(next);
    window.api.saveSettings(next).catch((): void => undefined);
  }, [settings, profiles, layout]);

  const handleBatchGenerateIcons = useCallback(async () => {
    if (batchGenerating) return;
    const withoutIcons = profiles.filter((p) => !p.icon);
    if (withoutIcons.length === 0) return;

    setBatchGenerating(true);
    let done = 0;

    for (const profile of withoutIcons) {
      done++;
      setBatchProgress(`${done}/${withoutIcons.length}: ${profile.name}`);
      try {
        const iconPath = await window.api.generateIcon(profile.id, profile.name);
        if (iconPath) {
          // Update the profile with the new icon
          setProfiles((prev) => {
            const updated = prev.map((p) =>
              p.id === profile.id ? { ...p, icon: iconPath } : p,
            );
            window.api.saveProfiles(updated);
            return updated;
          });
          setIconRevision((r) => r + 1);
        }
      } catch (err) {
        console.error(`Failed to generate icon for ${profile.name}:`, err);
      }
    }

    setBatchGenerating(false);
    setBatchProgress('');
  }, [batchGenerating, profiles]);

  /** Kick off an icon generation for a profile that may or may not yet
   * exist in `profiles`. Runs in the background — ProfileEditor calls
   * this and immediately returns control to the user, who can Save and
   * close. When the generation resolves, we update the matching profile
   * (if it exists by then) and dispatch a window event so an open
   * ProfileEditor for the same id can refresh its preview. */
  const handleStartIconGeneration = useCallback((profileId: string, name: string) => {
    setPendingIconGenerations((prev) => {
      const next = new Set(prev);
      next.add(profileId);
      return next;
    });
    window.api.generateIcon(profileId, name)
      .then((iconPath) => {
        if (!iconPath) return;
        setProfiles((prev) => {
          const exists = prev.some((p) => p.id === profileId);
          if (!exists) {
            // Profile wasn't saved (dialog cancelled). Icon file lingers
            // on disk but is harmless — orphans are tiny and Settings →
            // Icons can sweep them later.
            return prev;
          }
          const updated = prev.map((p) => p.id === profileId ? { ...p, icon: iconPath } : p);
          window.api.saveProfiles(updated);
          return updated;
        });
        setIconRevision((r) => r + 1);
        window.dispatchEvent(new CustomEvent('profile-icon-ready', { detail: { profileId, iconPath } }));
      })
      .catch((err) => {
        console.error('icon generation failed', err);
        window.dispatchEvent(new CustomEvent('profile-icon-failed', { detail: { profileId, error: String(err) } }));
      })
      .finally(() => {
        setPendingIconGenerations((prev) => {
          if (!prev.has(profileId)) return prev;
          const next = new Set(prev);
          next.delete(profileId);
          return next;
        });
      });
  }, []);

  const initializeProfile = useCallback(
    (profileId: string) => {
      if (initialized.has(profileId)) return;
      const profile = profiles.find((p) => p.id === profileId);
      // Remote-agent profiles (Hermes over Telegram) have no PTY/xterm —
      // the chat pane connects on its own. Keeping them out of
      // `initialized` also hides the stop/reload PTY controls.
      if (profile && !profile.remoteAgent) {
        setInitialized((prev) => new Set(prev).add(profileId));
      }
    },
    [profiles, initialized],
  );

  // Lazy check: before selecting a profile, verify its working
  // directory still exists. If it doesn't, defer the selection and
  // open the locate/delete modal — the actual selection then happens
  // either when the user picks a new folder (continues with the new
  // path) or is cancelled (no-op). Always returns true for an existing
  // path so callers can use it as an inline guard.
  const verifyProfileDir = useCallback(async (profileId: string): Promise<boolean> => {
    const p = profiles.find((x) => x.id === profileId);
    if (!p) return false;
    const ok = await window.api.pathExists(p.workingDirectory).catch(() => true);
    if (!ok) {
      setMissingDirProfileId(profileId);
      return false;
    }
    return true;
  }, [profiles]);

  const handleSelectProfile = useCallback(
    async (profileId: string) => {
      if (!(await verifyProfileDir(profileId))) return;
      // User-initiated selection clears the stopped flag — reinit will proceed
      stoppedRef.current.delete(profileId);
      setActiveProfileId(profileId);
      initializeProfile(profileId);
      setHasUpdates((prev) => {
        if (!prev.has(profileId)) return prev;
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
    },
    [initializeProfile, verifyProfileDir],
  );

  // Auto-init active profile — debounced so rapid keyboard nav doesn't init every profile
  const autoInitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeProfileId || profiles.length === 0) return;

    // If already initialized, no need to debounce
    if (initialized.has(activeProfileId)) return;

    // If user explicitly stopped this profile, don't auto-init until they re-select or reload
    if (stoppedRef.current.has(activeProfileId)) return;

    if (autoInitRef.current) clearTimeout(autoInitRef.current);
    autoInitRef.current = setTimeout(() => {
      initializeProfile(activeProfileId);
    }, 500);

    return () => {
      if (autoInitRef.current) clearTimeout(autoInitRef.current);
    };
  }, [activeProfileId, profiles, initializeProfile, initialized]);

  const handleAddProfile = () => {
    setEditingProfile(null);
    setEditorOpen(true);
  };

  const handleEditProfile = (profile: Profile) => {
    setEditingProfile(profile);
    setEditorOpen(true);
  };

  const handleSaveProfile = async (saved: Profile) => {
    // Tag new profiles with the currently-active workspace so they
    // appear in the sidebar immediately. Edits to existing profiles
    // keep their workspaceId untouched.
    let updated: Profile[];
    const existing = profiles.find((p) => p.id === saved.id);
    if (existing) {
      // Merge rather than replace: the editor's payload only carries the
      // fields it owns (name, icon, dir, agent, parallel flags, command,
      // args). Spreading the existing profile first preserves fields the
      // editor never sees — notably `workspaceId` and `statusPatterns` —
      // which a wholesale replace would silently drop, sending the
      // profile back to the Default workspace.
      updated = profiles.map((p) => (p.id === saved.id ? { ...p, ...saved } : p));
    } else {
      const withWs: Profile = saved.workspaceId
        ? saved
        : { ...saved, workspaceId: settings.activeWorkspaceId };
      updated = [...profiles, withWs];
    }
    await window.api.saveProfiles(updated);
    setProfiles(updated);
    setEditorOpen(false);
    setIconRevision((r) => r + 1);

    setActiveProfileId(saved.id);
    if (!initialized.has(saved.id)) {
      initializeProfile(saved.id);
    }
  };

  const handleStopProfile = useCallback(async (profileId: string) => {
    // Mark as stopped to prevent auto-init
    stoppedRef.current.add(profileId);
    // Destroy the PTY
    await window.api.destroyTerminal(profileId);
    // Close any shell terminals for this profile
    setShellOpenSet((prev) => {
      if (!prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.delete(profileId);
      return next;
    });
    // Drop Kanban panel and viewer for the parent view + every parallel
    // sub-view of this profile so the user starts clean on reload. Also
    // stop the underlying Ordna instance for each so we don't leak ports
    // or PTYs.
    const dropForProfile = (prev: Set<string>): Set<string> => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (k === profileId || k.startsWith(`${profileId}|`)) {
          changed = true;
          continue;
        }
        next.add(k);
      }
      return changed ? next : prev;
    };
    setKanbanViews(dropForProfile);
    setKanbanRunning((prev) => {
      for (const k of prev) {
        if (k === profileId || k.startsWith(`${profileId}|`)) {
          window.api.stopOrdna(k).catch((): void => undefined);
        }
      }
      return dropForProfile(prev);
    });
    // Remove from initialized set — TerminalPane will dispose the xterm.js instance
    setInitialized((prev) => {
      if (!prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.delete(profileId);
      return next;
    });
    // Reset status to offline
    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(profileId, 'offline');
      return next;
    });
  }, []);

  const handleReloadProfile = useCallback(async (profileId: string) => {
    await handleStopProfile(profileId);
    // Clear the stopped flag so auto-init works for this profile again
    stoppedRef.current.delete(profileId);
    // Re-initialize after a short delay to let cleanup settle
    setTimeout(() => {
      setInitialized((prev) => new Set(prev).add(profileId));
    }, 100);
  }, [handleStopProfile]);

  // Convert a temp scratchpad profile into a real project: move EVERYTHING
  // in the temp dir (dotfiles included) into a user-picked folder, point
  // the profile there, and restart its agent in the new location.
  const convertTempProfile = useCallback(async (profile: Profile) => {
    const dest = await window.api.selectDirectory();
    if (!dest) return;
    // Stop the agent first — its cwd is about to be emptied, and the
    // restart below must spawn in the new directory.
    await handleStopProfile(profile.id);
    const res = await window.api.moveDirContents(profile.workingDirectory, dest);
    if (!res.ok) {
      toastError(`Convert failed: ${res.error ?? 'could not move files'}`);
      // Contents are untouched (all-or-nothing) — restart in place.
      stoppedRef.current.delete(profile.id);
      setTimeout(() => setInitialized((prev) => new Set(prev).add(profile.id)), 100);
      return;
    }
    const updated = profilesRef.current.map((p) =>
      p.id === profile.id ? { ...p, workingDirectory: dest } : p);
    await window.api.saveProfiles(updated);
    setProfiles(updated);
    // Restart the agent in the new project directory.
    stoppedRef.current.delete(profile.id);
    setTimeout(() => setInitialized((prev) => new Set(prev).add(profile.id)), 100);
  }, [handleStopProfile]);

  const handleDeleteProfile = async (profileId: string) => {
    const updated = profiles.filter((p) => p.id !== profileId);
    await window.api.saveProfiles(updated);
    setProfiles(updated);
    setEditorOpen(false);

    // Drop overlay state for the removed profile (parent view + every
    // parallel sub-view it owned).
    const dropForProfile = (prev: Set<string>): Set<string> => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (k === profileId || k.startsWith(`${profileId}|`)) {
          changed = true;
          continue;
        }
        next.add(k);
      }
      return changed ? next : prev;
    };
    setFilesViews(dropForProfile);
    setKanbanViews(dropForProfile);
    setKanbanRunning((prev) => {
      for (const k of prev) {
        if (k === profileId || k.startsWith(`${profileId}|`)) {
          window.api.stopOrdna(k).catch((): void => undefined);
        }
      }
      return dropForProfile(prev);
    });

    if (activeProfileId === profileId) {
      setActiveProfileId(updated.length > 0 ? updated[0].id : null);
    }
  };

  const activeProfile = profiles.find((p) => p.id === activeProfileId) || null;

  const handleLayoutChange = useCallback((newLayout: SidebarLayout) => {
    setLayout(newLayout);
    window.api.saveLayout(newLayout);
  }, []);

  // Debounce saving pane sizes to settings
  const savePaneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Clear the main-process Edit menu state when no FileExplorer is on
  // screen. Persistent FileExplorers only push menu state while visible,
  // so without this the menu would keep advertising the last file as
  // editable after the user switches away from the Files tab.
  useEffect(() => {
    if (!filesVisible) {
      window.api.setEditMenuState({ hasFile: false, canSave: false });
    }
  }, [filesVisible]);

  // Sweep open views of a function the user just disabled in Settings →
  // Functions. Without this, an already-open Kanban / Web overlay would
  // stay onscreen even though its tab disappears from the command bar.
  useEffect(() => {
    if (settings.functionKanbanEnabled === false) {
      setKanbanViews(new Set());
      setKanbanRunning(new Set());
    }
  }, [settings.functionKanbanEnabled]);
  useEffect(() => {
    if (settings.functionWebEnabled === false) {
      setWebViews(new Set());
      setWebRunning(new Set());
    }
  }, [settings.functionWebEnabled]);

  const savePaneSizes = useCallback(
    (patch: Partial<AppSettings>) => {
      if (savePaneTimerRef.current) clearTimeout(savePaneTimerRef.current);
      savePaneTimerRef.current = setTimeout(() => {
        const updated = { ...settingsRef.current, ...patch };
        setSettings(updated);
        window.api.saveSettings(updated);
      }, 500);
    },
    [],
  );

  // T-047: editor font-size CSS variable. Drives both FileExplorer's
  // CodeMirror theme and the README edit-mode CodeMirror via a single
  // `--cm-editor-font-size` custom property on :root. Reads from
  // settings; the keyboard shortcuts (Cmd+= / Cmd+- / Cmd+0) call
  // adjustEditorFontSize below to bump and persist.
  useEffect(() => {
    const size = Math.max(8, Math.min(32, settings.editorFontSize ?? 12));
    document.documentElement.style.setProperty('--cm-editor-font-size', `${size}px`);
  }, [settings.editorFontSize]);

  // File-tree row font size (Files view) — same CSS-variable pattern.
  useEffect(() => {
    const size = Math.max(9, Math.min(20, settings.fileTreeFontSize ?? 12));
    document.documentElement.style.setProperty('--file-tree-font-size', `${size}px`);
  }, [settings.fileTreeFontSize]);

  const adjustEditorFontSize = useCallback((delta: number) => {
    const current = settingsRef.current.editorFontSize ?? 12;
    // delta === 0 is the "reset to default" path. Otherwise clamp
    // to the spec's 8/32 floor + ceiling.
    const next = delta === 0 ? 12 : Math.max(8, Math.min(32, current + delta));
    if (next === current) return;
    savePaneSizes({ editorFontSize: next });
  }, [savePaneSizes]);

  // Persist which function tabs were open + whether split-view was
  // on, keyed by parent-profile view (parallel-agent keys are
  // session-bound and skipped). Stays in sync with the four overlay
  // Sets via this effect; debounced through `savePaneSizes` so a
  // burst of toggles only writes once.
  useEffect(() => {
    const profileIds = new Set(profiles.map((p) => p.id));
    const acc: Record<string, { files?: boolean; kanban?: boolean; web?: boolean; split?: boolean; showChanged?: boolean }> = {};
    const collect = (set: Set<string>, key: 'files' | 'kanban' | 'web' | 'split' | 'showChanged') => {
      for (const k of set) {
        // Parallel-agent view keys contain '|' — skip them so we
        // don't persist state for views that don't exist on next
        // launch. Also drop refs to deleted profiles.
        if (k.includes('|')) continue;
        if (!profileIds.has(k)) continue;
        if (!acc[k]) acc[k] = {};
        acc[k][key] = true;
      }
    };
    collect(filesViews, 'files');
    collect(kanbanViews, 'kanban');
    collect(webViews, 'web');
    collect(splitViews, 'split');
    collect(showChangedFilesViews, 'showChanged');
    // Explicit "split off" choices persist as split:false so the
    // defaultSplitView setting never re-applies to them (tri-state:
    // true / false / absent-means-follow-default).
    for (const k of splitOffViews) {
      if (k.includes('|') || !profileIds.has(k)) continue;
      if (!acc[k]) acc[k] = {};
      acc[k].split = false;
    }
    const current = settingsRef.current.openFunctionTabs || {};
    if (JSON.stringify(current) === JSON.stringify(acc)) return;
    savePaneSizes({ openFunctionTabs: acc });
  }, [filesViews, kanbanViews, webViews, splitViews, splitOffViews, showChangedFilesViews, profiles, savePaneSizes]);

  // Persist the FileExplorer open-tab snapshot. Separate effect because
  // the payload (arrays of absolute paths) is larger than the booleans
  // tracked above and shouldn't pollute that change-detection diff.
  useEffect(() => {
    const profileIds = new Set(profiles.map((p) => p.id));
    const acc: Record<string, { paths: string[]; activePath?: string }> = {};
    for (const [k, v] of Object.entries(fileExplorerTabs)) {
      if (k.includes('|')) continue;
      if (!profileIds.has(k)) continue;
      if (!v || !v.paths || v.paths.length === 0) continue;
      acc[k] = v.activePath ? { paths: v.paths, activePath: v.activePath } : { paths: v.paths };
    }
    const current = settingsRef.current.fileExplorerTabs || {};
    if (JSON.stringify(current) === JSON.stringify(acc)) return;
    savePaneSizes({ fileExplorerTabs: acc });
  }, [fileExplorerTabs, profiles, savePaneSizes]);

  /** Persist a Web tab's current URL back to settings.webUrls so it
   * survives a Vyb restart. Debounced via savePaneSizes. */
  const handleWebUrlChange = useCallback((key: string, url: string) => {
    const current = settingsRef.current.webUrls || {};
    if (current[key] === url) return;
    savePaneSizes({ webUrls: { ...current, [key]: url } });
  }, [savePaneSizes]);

  // Track an unclamped "logical width" that accumulates each mousemove
  // delta from ResizeHandle. The visible width + compact flag are derived
  // from it. Without this, deltas that would push the visible width past
  // a clamp boundary (EXPANDED_MIN or COMPACT_WIDTH) get silently
  // discarded, so the snap only ever fires when a single mousemove event
  // crosses the threshold in one shot — i.e., a fast jerk of the mouse.
  // With the logical ref, small per-frame deltas compose normally and
  // the snap fires the moment the cumulative drag crosses the threshold.
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const sidebarCompactRef = useRef(sidebarCompact);
  sidebarCompactRef.current = sidebarCompact;
  const logicalSidebarWidthRef = useRef<number>(
    sidebarCompact ? SIDEBAR_COMPACT_WIDTH : sidebarWidth,
  );

  const handleSidebarResize = useCallback(
    (delta: number) => {
      const logical = Math.max(
        SIDEBAR_COMPACT_WIDTH,
        Math.min(SIDEBAR_EXPANDED_MAX, logicalSidebarWidthRef.current + delta),
      );
      logicalSidebarWidthRef.current = logical;

      const nextCompact = logical < SIDEBAR_SNAP_THRESHOLD;
      if (nextCompact !== sidebarCompactRef.current) {
        sidebarCompactRef.current = nextCompact;
        setSidebarCompact(nextCompact);
        savePaneSizes({ sidebarCompact: nextCompact });
      }
      if (!nextCompact) {
        const visible = Math.max(SIDEBAR_EXPANDED_MIN, logical);
        if (visible !== sidebarWidthRef.current) {
          sidebarWidthRef.current = visible;
          setSidebarWidth(visible);
          savePaneSizes({ sidebarWidth: visible });
        }
      }
    },
    [savePaneSizes],
  );

  const [agentPercent, setAgentPercent] = useState(DEFAULT_SETTINGS.terminalSplitPercent);
  // Sync local split state from saved settings (initial load + external changes)
  useEffect(() => {
    setAgentPercent(settings.terminalSplitPercent);
  }, [settings.terminalSplitPercent]);
  const splitRef = useRef<HTMLDivElement>(null);
  const handleTerminalSplitResize = useCallback(
    (delta: number) => {
      const container = splitRef.current;
      if (!container) return;
      const totalHeight = container.clientHeight;
      if (totalHeight === 0) return;
      const deltaPercent = (delta / totalHeight) * 100;
      setAgentPercent((p) => {
        const next = Math.max(20, Math.min(80, p + deltaPercent));
        savePaneSizes({ terminalSplitPercent: next });
        return next;
      });
    },
    [savePaneSizes],
  );
  // Track which profiles have ever had shell opened (so previously-opened
  // shells stay mounted across switches)
  // Shell state is keyed by VIEW (activeViewKey): a profile's parent view
  // uses the profileId, a selected session uses `${profileId}|${parallelId}`
  // — so a session gets its own shells, rooted in its worktree, separate
  // from the parent profile's shells.
  const shellOpenedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (activeViewKey && shellOpenSet.has(activeViewKey)) {
      shellOpenedRef.current.add(activeViewKey);
    }
  }, [activeViewKey, shellOpenSet]);

  // Build ordered list of profile IDs for keyboard navigation
  // Stable identity for TerminalPane's `profiles` prop. An inline
  // `profiles.filter(...)` would produce a NEW array on every App render;
  // TerminalPane's show/hide effect depends on `profiles` and calls
  // `terminal.focus()` when it re-runs, so an unstable identity made every
  // unrelated state change (dirty-file updates, nav overlay, incoming
  // Telegram messages) steal focus into the agent terminal.
  const terminalProfiles = useMemo(() => profiles.filter((p) => !p.remoteAgent), [profiles]);

  const effectiveLayout = useMemo(() => {
    const ids: string[] = [];
    // Flatten layout into ordered profile IDs (top-level + folder contents)
    if (layout.items) {
      const folderMap = new Map((layout.folders || []).map((f) => [f.id, f]));
      for (const item of layout.items) {
        if (item.type === 'profile') {
          ids.push(item.profileId);
        } else if (item.type === 'folder') {
          const folder = folderMap.get(item.folderId);
          if (folder) {
            for (const pid of folder.profileIds) ids.push(pid);
          }
        }
      }
    }
    // Add any profiles not in layout
    for (const p of profiles) {
      if (!ids.includes(p.id)) ids.push(p.id);
    }
    return ids;
  }, [layout, profiles]);

  // Helpers for the per-profile overlay sets
  const toggleInSet = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const removeFromSet = (set: Set<string>, id: string): Set<string> => {
    if (!set.has(id)) return set;
    const next = new Set(set);
    next.delete(id);
    return next;
  };
  const ensureInSet = (set: Set<string>, id: string): Set<string> => {
    if (set.has(id)) return set;
    const next = new Set(set);
    next.add(id);
    return next;
  };

  // Command bar action builders — keyed by activeViewKey so parallel agents
  // and their parent profile each have independent overlay state.

  // Single source of truth for which main-view tab the user is on.
  // 'agent'  → no overlay, terminal is in front.
  // 'files'  → FileExplorer overlay.
  // 'kanban' → KanbanViewer overlay (its KanbanRunning entry stays put
  //   when the user moves to a different tab, so Ordna keeps running
  //   in the background).
  const selectTab = useCallback((tab: 'agent' | 'files' | 'kanban' | 'web') => {
    const key = activeViewKey;
    if (!key) return;

    // Helper to set exactly one of files/kanban/web as the right pane.
    // Each path-type maintains a `*Running` set so its mount persists
    // even after we hide it — switching tabs only changes which view
    // has `hidden=false`, not what's mounted.
    const setSoleOverlay = (which: 'files' | 'kanban' | 'web') => {
      setFilesViews((prev) => which === 'files' ? ensureInSet(prev, key) : removeFromSet(prev, key));
      setKanbanViews((prev) => which === 'kanban' ? ensureInSet(prev, key) : removeFromSet(prev, key));
      setWebViews((prev) => which === 'web' ? ensureInSet(prev, key) : removeFromSet(prev, key));
      if (which === 'files') setFilesRunning((prev) => ensureInSet(prev, key));
      if (which === 'kanban') setKanbanRunning((prev) => ensureInSet(prev, key));
      if (which === 'web') setWebRunning((prev) => ensureInSet(prev, key));
    };

    // In split mode the Agent pane is permanently on the left; tapping
    // Agent is a no-op. Other tabs switch the RIGHT pane.
    if (splitViews.has(key)) {
      if (tab === 'agent') return;
      setSoleOverlay(tab);
      return;
    }
    if (tab === 'agent') {
      setFilesViews((prev) => removeFromSet(prev, key));
      setKanbanViews((prev) => removeFromSet(prev, key));
      setWebViews((prev) => removeFromSet(prev, key));
      return;
    }
    setSoleOverlay(tab);
  }, [activeViewKey, splitViews]);

  // Keyboard-nav targets — same-tab presses are no-ops, so ⌘1 from
  // Files goes to Agent and from Agent stays on Agent.
  const goAgent = useCallback(() => selectTab('agent'), [selectTab]);
  const goFiles = useCallback(() => selectTab('files'), [selectTab]);
  const goKanban = useCallback(() => selectTab('kanban'), [selectTab]);
  const goWeb = useCallback(() => selectTab('web'), [selectTab]);

  // Derived current tab — the Agent tab is the default whenever no
  // overlay is active.
  const activeTab: 'agent' | 'files' | 'kanban' | 'web' = filesVisible ? 'files'
    : kanbanVisible ? 'kanban'
    : webVisible ? 'web'
    : 'agent';
  const shellOpen = activeViewKey ? shellOpenSet.has(activeViewKey) : false;
  // Split mode is per-view-key, so each profile AND each parallel session
  // remembers its own split state. For a session the LEFT pane is the
  // session's own terminal (ParallelAgentTerminal) instead of the main
  // TerminalPane (see the hidden/splitWidth wiring below).
  const splitMode = !!(activeViewKey && splitViews.has(activeViewKey));

  const toggleSplit = useCallback(() => {
    const key = activeViewKey;
    if (!key) return;
    setSplitViews((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        // Exiting split — drop back to agent-only and clear every
        // right-pane overlay so the user gets the "original" view.
        // Record the EXPLICIT off so defaultSplitView never re-applies.
        next.delete(key);
        setSplitOffViews((p) => ensureInSet(p, key));
        setFilesViews((p) => removeFromSet(p, key));
        setKanbanViews((p) => removeFromSet(p, key));
        setWebViews((p) => removeFromSet(p, key));
      } else {
        // Entering split — guarantee one of Files/Kanban/Web is the right pane.
        next.add(key);
        setSplitOffViews((p) => removeFromSet(p, key));
        if (!filesViews.has(key) && !kanbanViews.has(key) && !webViews.has(key)) {
          setFilesViews((p) => ensureInSet(p, key));
          setFilesRunning((p) => ensureInSet(p, key));
        }
      }
      return next;
    });
  }, [activeViewKey, filesViews, kanbanViews, webViews]);

  // View → Toggle Split View (and its Cmd+\ accelerator). The listener
  // mounts once; the ref keeps it pointed at the latest toggleSplit
  // closure (which depends on the active view key).
  const toggleSplitRef = useRef(toggleSplit);
  toggleSplitRef.current = toggleSplit;
  useEffect(() => window.api.onMenuToggleSplit(() => toggleSplitRef.current()), []);

  // ⇧F12 Find All References (editor action in lib/monaco-definitions.ts):
  // open the Search panel pre-filled with the symbol as a whole-word query.
  useEffect(() => {
    const handler = (e: Event) => {
      const { query } = (e as CustomEvent<{ query?: string }>).detail || {};
      if (!query) return;
      setChangesVisible(false);
      setFindInFilesVisible(true);
      setFindPanelRequest({ withReplace: false, nonce: Date.now(), query, wholeWord: true });
    };
    window.addEventListener('vyb-find-references', handler);
    return () => window.removeEventListener('vyb-find-references', handler);
  }, []);

  // Cmd+click go-to-definition landed on a file that isn't open in the
  // editor: Monaco's editor opener (lib/monaco-definitions.ts) raises
  // this event, and we route it through the same open-tab-at-line flow
  // Find-in-Files results use.
  useEffect(() => {
    const handler = (e: Event) => {
      const { path, line } = (e as CustomEvent<{ path?: string; line?: number }>).detail || {};
      if (!path) return;
      if (activeViewKey) {
        const key = activeViewKey;
        setFilesViews((prev) => ensureInSet(prev, key));
        setFilesRunning((prev) => ensureInSet(prev, key));
        setKanbanViews((prev) => removeFromSet(prev, key));
        setWebViews((prev) => removeFromSet(prev, key));
      }
      setPendingFileOpen({ path, nonce: Date.now(), line: line ?? 1 });
    };
    window.addEventListener('vyb-open-definition', handler);
    return () => window.removeEventListener('vyb-open-definition', handler);
  }, [activeViewKey]);

  // defaultSplitView: a parent-profile view activated with NO remembered
  // split choice (neither explicit-on nor explicit-off) starts in split.
  // Materialized into splitViews so from then on it persists exactly like
  // a hand-toggled split (the setting only seeds first use).
  useEffect(() => {
    const key = activeViewKey;
    if (!key || key.includes('|')) return; // parent profiles only
    if (settings.defaultSplitView !== true) return;
    if (splitViews.has(key) || splitOffViews.has(key)) return;
    setSplitViews((prev) => ensureInSet(prev, key));
    if (!filesViews.has(key) && !kanbanViews.has(key) && !webViews.has(key)) {
      setFilesViews((p) => ensureInSet(p, key));
      setFilesRunning((p) => ensureInSet(p, key));
    }
  }, [activeViewKey, settings.defaultSplitView, splitViews, splitOffViews, filesViews, kanbanViews, webViews]);

  const agentSplitRef = useRef<HTMLDivElement>(null);
  // ── Divider snap (subtle magnetic alignment) ──────────────────────
  // The agent|editor split divider (top) and the shell-terminal dividers
  // (bottom) are vertical lines stacked in the same width space. While
  // dragging one, it snaps when it lines up with one from the other row.
  // The raw (cursor-following) position is tracked per drag so the snap
  // is escapable — drag past the threshold and it releases.
  const SNAP_PX = 8;
  const shellDividersRef = useRef<number[]>([]);
  const reportShellDividers = useCallback((positions: number[]) => {
    shellDividersRef.current = positions;
  }, []);
  const agentSplitPercentRef = useRef(agentSplitPercent);
  agentSplitPercentRef.current = agentSplitPercent;
  // splitMode/shellOpen are derived ABOVE this block — mirror them here
  // (safe: refs assigned during render, read only inside event handlers).
  const splitModeRef = useRef(false);
  splitModeRef.current = splitMode;
  const shellOpenRef = useRef(false);
  shellOpenRef.current = shellOpen;
  const agentSplitRawRef = useRef<number | null>(null);

  const snapValue = (value: number, targets: number[], thresholdPct: number): number => {
    for (const t of targets) {
      if (Math.abs(value - t) <= thresholdPct) return t;
    }
    return value;
  };

  const handleAgentSplitResize = useCallback((delta: number) => {
    const container = agentSplitRef.current;
    if (!container) return;
    const totalWidth = container.clientWidth;
    if (totalWidth === 0) return;
    const deltaPct = (delta / totalWidth) * 100;
    const raw = Math.max(20, Math.min(80,
      (agentSplitRawRef.current ?? agentSplitPercentRef.current) + deltaPct));
    agentSplitRawRef.current = raw;
    // Snap only to the shells actually visible below; a closed shell pane
    // must not leave stale magnetic targets behind.
    const targets = shellOpenRef.current ? shellDividersRef.current : [];
    const next = snapValue(raw, targets, (SNAP_PX / totalWidth) * 100);
    setAgentSplitPercent(next);
    savePaneSizes({ agentSplitPercent: next });
  }, [savePaneSizes]);

  const handleAgentSplitResizeEnd = useCallback(() => {
    agentSplitRawRef.current = null;
  }, []);

  // Snap targets for a shell divider being dragged: the split divider
  // above it (when split mode is showing one).
  const getShellSnapTargets = useCallback((): number[] => {
    return splitModeRef.current ? [agentSplitPercentRef.current] : [];
  }, []);

  const toggleShell = useCallback(() => {
    if (!activeViewKey) return;
    setShellOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(activeViewKey)) next.delete(activeViewKey);
      else next.add(activeViewKey);
      return next;
    });
  }, [activeViewKey]);

  // Persist profile memory when shell state changes
  const memSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (memSaveTimerRef.current) clearTimeout(memSaveTimerRef.current);
    memSaveTimerRef.current = setTimeout(() => {
      const memory = { ...profileMemoryRef.current };
      for (const p of profiles) {
        if (!memory[p.id]) memory[p.id] = { shellOpen: false, shellCount: 1 };
        memory[p.id].shellOpen = shellOpenSet.has(p.id);
      }
      profileMemoryRef.current = memory;
      window.api.saveProfileMemory(memory);
    }, 500);
    return () => {
      if (memSaveTimerRef.current) clearTimeout(memSaveTimerRef.current);
    };
  }, [shellOpenSet, profiles]);

  const openFolder = useCallback(() => {
    // Worktree-aware: opens the selected session's worktree when one is
    // active, else the active profile's directory.
    const dir = activeViewCwdRef.current;
    if (dir) window.api.openInFinder(dir);
  }, []);

  const toggleGit = useCallback(() => {
    setGitPanelTab('changes');
    // Git and Search share the docked right edge — opening one closes
    // the other.
    setFindInFilesVisible(false);
    setChangesVisible((v) => !v);
  }, []);

  const navActions = useMemo(() => {
    // Keep this in sync with CommandBar.tsx button order:
    //   Agent(0) Files(1) [Kanban] [Web] | Terminal Git | Folder
    // Kanban / Web are skipped from the array when their feature flag is
    // off, so downstream indices shift accordingly. External apps are NOT
    // numbered — they live in the Apps dropdown (mouse-only) to save space.
    const kanbanOn = settings.functionKanbanEnabled !== false;
    const webOn = settings.functionWebEnabled !== false;
    const actions: Array<() => void> = [goAgent, goFiles];
    const labels: string[] = ['Agent', 'Files'];
    if (kanbanOn) { actions.push(goKanban); labels.push('Kanban'); }
    if (webOn) { actions.push(goWeb); labels.push('Web'); }
    actions.push(toggleShell, toggleGit, openFolder);
    labels.push('Terminal', 'Git', 'Folder');
    return { actions, labels };
  }, [goAgent, goFiles, goKanban, goWeb, toggleShell, toggleGit, openFolder, settings.functionKanbanEnabled, settings.functionWebEnabled]);

  // Keyboard profile navigation — only updates visual selection.
  // The auto-init effect (2s debounce) handles terminal initialization.
  const navSelectProfile = useCallback(async (profileId: string) => {
    if (!(await verifyProfileDir(profileId))) return;
    stoppedRef.current.delete(profileId);
    setActiveProfileId(profileId);
    window.api.setActiveProfile(profileId);
    setHasUpdates((prev) => {
      if (!prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.delete(profileId);
      return next;
    });
  }, [verifyProfileDir]);

  const navActive = useKeyNav({
    settings,
    commandBarActions: navActions.actions,
    commandBarLabels: navActions.labels,
    onProfileUp: () => {
      const idx = effectiveLayout.indexOf(activeProfileId || '');
      if (idx > 0) navSelectProfile(effectiveLayout[idx - 1]);
    },
    onProfileDown: () => {
      const idx = effectiveLayout.indexOf(activeProfileId || '');
      if (idx < effectiveLayout.length - 1) navSelectProfile(effectiveLayout[idx + 1]);
    },
    onPaneLeft: () => {
      if (!activeProfileId) return;
      const shellOpen = activeViewKey ? shellOpenSet.has(activeViewKey) : false;
      if (!shellOpen) return;
      const count = shellCountRef.current;

      if (focusedPane.pane === 'shell') {
        if (focusedPane.shellIndex > 0) {
          // Move to previous shell terminal
          setFocusedPane({ pane: 'shell', shellIndex: focusedPane.shellIndex - 1 });
        } else {
          // At first shell, go to agent
          setFocusedPane({ pane: 'agent', shellIndex: 0 });
        }
      }
    },
    onPaneRight: () => {
      if (!activeProfileId) return;
      const shellOpen = activeViewKey ? shellOpenSet.has(activeViewKey) : false;
      if (!shellOpen) return;
      const count = shellCountRef.current;

      if (focusedPane.pane === 'agent') {
        // Go to first shell
        setFocusedPane({ pane: 'shell', shellIndex: 0 });
      } else if (focusedPane.pane === 'shell') {
        if (focusedPane.shellIndex < count - 1) {
          // Move to next shell terminal
          setFocusedPane({ pane: 'shell', shellIndex: focusedPane.shellIndex + 1 });
        }
      }
    },
  });

  // Dictation — send transcript to the focused terminal
  const handleTranscript = useCallback((text: string) => {
    if (!activeProfileId) return;
    if (focusedPane.pane === 'agent') {
      window.api.sendInput(activeProfileId, text);
    }
    // For shell pane, we'd need the shell ID — for now just send to agent
  }, [activeProfileId, focusedPane]);

  const dictation = useDictation({
    lang: settings.dictationLang,
    mode: settings.dictationMode,
    onTranscript: handleTranscript,
  });

  // Hotkey for dictation: Ctrl+D (not Cmd — macOS swallows keyup with Cmd held)
  const dictHoldActiveRef = useRef(false);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.metaKey && e.key === 'D') {
        e.preventDefault();
        if (settings.dictationMode === 'hold') {
          if (!dictHoldActiveRef.current) {
            dictHoldActiveRef.current = true;
            dictation.startListening();
          }
        } else {
          dictation.toggleListening();
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (settings.dictationMode === 'hold' && dictHoldActiveRef.current) {
        if (e.key === 'D' || e.key === 'd' || e.key === 'Shift' || e.key === 'Control') {
          dictHoldActiveRef.current = false;
          dictation.stopListening();
        }
      }
    };
    const handleBlur = () => {
      if (dictHoldActiveRef.current) {
        dictHoldActiveRef.current = false;
        dictation.stopListening();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [settings.dictationMode, dictation]);

  return (
    <div
      className={`app${sidebarCompact ? ' app-sidebar-compact' : ''}`}
      style={{
        gridTemplateColumns: `${sidebarCompact ? SIDEBAR_COMPACT_WIDTH : sidebarWidth}px auto 1fr`,
      }}
    >
      <div className="titlebar">
        {window.api.platform !== 'darwin' && (
          // Windows/Linux: the custom (frameless) title bar hides the
          // native menu bar, so render File/Edit/View buttons that pop
          // the matching native submenu. macOS keeps the system menu bar.
          <div className="titlebar-menu">
            {['File', 'Edit', 'View'].map((label) => (
              <button
                key={label}
                type="button"
                className="titlebar-menu-btn"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  window.api.popupMenu(label, r.left, r.bottom);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {activeProfile && (
          <>
            <span className="titlebar-name">{activeProfile.name}</span>
            <span className="titlebar-path" title={activeViewCwd}>
              {activeViewCwd.replace(/^\/Users\/[^/]+/, '~')}
            </span>
          </>
        )}
      </div>
      <Sidebar
        profiles={profiles}
        activeProfileId={activeProfileId}
        statuses={statuses}
        layout={layout}
        iconRevision={iconRevision}
        hasUpdates={hasUpdates}
        dirtyProfileIds={dirtyProfileIds}
        navActive={navActive}
        onLayoutChange={handleLayoutChange}
        onSelectProfile={handleSelectProfile}
        onEditProfile={handleEditProfile}
        onAddProfile={handleAddProfile}
        onStopProfile={handleStopProfile}
        onReloadProfile={handleReloadProfile}
        onProfileContextMenu={openSessionMenu}
        workspaces={settings.workspaces}
        activeWorkspaceId={settings.activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        onAddWorkspace={handleAddWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
        onUpdateWorkspace={handleUpdateWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
        onMoveToWorkspace={handleMoveToWorkspace}
        initialized={initialized}
        showAgentBadge={settings.showAgentBadge !== false}
        parallelAgents={[...parallelAgents.values()]}
        selectedParallelId={selectedParallelId}
        pendingIconGenerations={pendingIconGenerations}
        onSelectParallel={selectParallel}
        onRunParallel={(id) => submitParallelTask(id)}
        onStopParallel={(id) => {
          // Show a confirmation dialog so an accidental Stop click doesn't
          // silently throw away an agent's branch+work. The dialog lets
          // the user pick between "Discard" (drop the branch) and the
          // default "Save WIP" (commit anything outstanding so the work
          // can be recovered later via the branch).
          cancelAutoRun(id);
          setStopParallelTarget(id);
        }}
      />
      <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
      <div className="main-area">
        <CommandBar
          profile={activeProfile}
          workingDirectory={activeViewCwd}
          shellOpen={shellOpen}
          activeTab={activeTab}
          onSelectTab={selectTab}
          onToggleShell={toggleShell}
          onToggleGit={toggleGit}
          gitActive={changesVisible}
          splitActive={splitMode}
          onToggleSplit={toggleSplit}
          agentSplitPercent={agentSplitPercent}
          kanbanEnabled={settings.functionKanbanEnabled !== false}
          webEnabled={settings.functionWebEnabled !== false}
          externalApps={settings.externalApps || []}
          filesShowChanges={activeViewKey ? showChangedFilesViews.has(activeViewKey) : false}
          onSetFilesShowChanges={(next) => {
            const key = activeViewKey;
            if (!key) return;
            setShowChangedFilesViews((prev) => {
              if (prev.has(key) === next) return prev;
              const out = new Set(prev);
              if (next) out.add(key); else out.delete(key);
              return out;
            });
          }}
          navActive={navActive}
          showActionLabels={settings.showActionLabels === true}
          dictationListening={dictation.listening}
          dictationSupported={dictation.supported}
          dictationInterim={dictation.interim}
          dictationMode={settings.dictationMode}
          onDictationToggle={dictation.toggleListening}
          onDictationStart={dictation.startListening}
          onDictationStop={dictation.stopListening}
        />
        {/* Vertical split: top half hosts whichever main view is active
            (Agent terminal / Files / Kanban / parallel-agent terminal); the
            bottom half is the per-profile shell terminal split, which is
            shared across all tabs and toggled via the Terminal button. */}
        <div className="terminal-split" ref={splitRef}>
          <div
            className={`main-content-top${splitMode ? ' is-split' : ''}`}
            ref={agentSplitRef}
            style={
              shellOpen
                ? {
                    height: `${agentPercent}%`,
                    display: 'flex',
                    flexDirection: splitMode ? 'row' : 'column',
                    position: 'relative',
                    minHeight: 0,
                    overflow: 'hidden',
                  }
                : {
                    flex: 1,
                    display: 'flex',
                    flexDirection: splitMode ? 'row' : 'column',
                    position: 'relative',
                    minHeight: 0,
                    overflow: 'hidden',
                  }
            }
          >
            {/* TerminalPane first so flex-direction:row puts it on the
                left in split mode. In normal mode it lives at the top of
                the flex column (hidden when Files/Kanban is selected). */}
            <TerminalPane
              profiles={terminalProfiles}
              activeProfileId={activeProfileId}
              initialized={initialized}
              shellOpen={shellOpen}
              hidden={selectedParallelId !== null || !!activeProfile?.remoteAgent || (!splitMode && (filesVisible || kanbanVisible || webVisible))}
              settings={settings}
              focusedPane={focusedPane}
              navActive={navActive}
              splitWidth={splitMode && !selectedParallelId ? agentSplitPercent : null}
              webEnabled={settings.functionWebEnabled !== false}
              consumeStartupArgs={consumeStartupArgs}
            />
            {splitMode && (
              <ResizeHandle direction="horizontal" onResize={handleAgentSplitResize} onResizeEnd={handleAgentSplitResizeEnd} />
            )}
            {/* Mount one FileExplorer per view in filesRunning. Same
                persist-in-background pattern as Kanban / Web — keeps open
                tabs and unsaved edits alive when switching profiles or
                hiding the tab. The active instance gets pendingOpenPath
                wired up so file-link clicks from the terminal route here. */}
            {[...filesRunning].map((key) => {
              const sepIdx = key.indexOf('|');
              const profileId = sepIdx === -1 ? key : key.slice(0, sepIdx);
              const parallelId = sepIdx === -1 ? null : key.slice(sepIdx + 1);
              const p = profiles.find((pp) => pp.id === profileId);
              if (!p) return null;
              let cwd = p.workingDirectory;
              if (parallelId) {
                const pa = parallelAgents.get(parallelId);
                if (!pa) return null;
                cwd = pa.worktreePath;
              }
              const visible = key === activeViewKey && filesViews.has(key);
              return (
                <FileExplorer
                  key={key}
                  ref={(h) => {
                    if (h) explorerHandles.current.set(key, h);
                    else explorerHandles.current.delete(key);
                  }}
                  workingDirectory={cwd}
                  hidden={!visible}
                  onDirtyChange={(names) => {
                    setDirtyFilesByView((prev) => {
                      const cur = prev[key] || [];
                      if (cur.length === names.length && cur.every((n, i) => n === names[i])) return prev;
                      const out = { ...prev };
                      if (names.length === 0) delete out[key];
                      else out[key] = names;
                      return out;
                    });
                  }}
                  pendingOpenPath={visible ? pendingFileOpen : null}
                  onPendingOpenHandled={() => setPendingFileOpen(null)}
                  formatOnSave={settings.formatOnSave === true}
                  trimWhitespaceOnSave={settings.trimWhitespaceOnSave === true}
                  finalNewlineOnSave={settings.finalNewlineOnSave === true}
                  stickyScroll={settings.editorStickyScroll !== false}
                  showHiddenFiles={settings.showHiddenFiles !== false}
                  editorEngine={settings.editorEngine ?? 'monaco'}
                  editorFontSize={settings.editorFontSize ?? 12}
                  diffContextLines={settings.diffContextLines ?? 6}
                  showChangedOnly={showChangedFilesViews.has(key)}
                  onShowChangedOnlyChange={(next) => {
                    setShowChangedFilesViews((prev) => {
                      const cur = prev.has(key);
                      if (cur === next) return prev;
                      const out = new Set(prev);
                      if (next) out.add(key); else out.delete(key);
                      return out;
                    });
                  }}
                  initialTabs={fileExplorerTabs[key]}
                  onTabsChange={(paths, activePath) => {
                    setFileExplorerTabs((prev) => {
                      const next: { paths: string[]; activePath?: string } | undefined =
                        paths.length === 0
                          ? undefined
                          : activePath
                            ? { paths, activePath }
                            : { paths };
                      const cur = prev[key];
                      if (JSON.stringify(cur) === JSON.stringify(next)) return prev;
                      const out = { ...prev };
                      if (next === undefined) delete out[key];
                      else out[key] = next;
                      return out;
                    });
                  }}
                  onAdjustEditorFontSize={adjustEditorFontSize}
                />
              );
            })}
            {/* Mount one KanbanViewer per view in kanbanRunning. The set persists
                across tab close — clicking the Kanban button to hide just removes
                the view from kanbanViews, leaving the viewer mounted and Ordna
                alive in the background. The viewer is shown only when its view
                matches the active view AND the Kanban tab is the active overlay.
                View key format: parent = `${profileId}`, parallel = `${profileId}|${parallelId}`. */}
            {[...kanbanRunning].map((key) => {
              const sepIdx = key.indexOf('|');
              const profileId = sepIdx === -1 ? key : key.slice(0, sepIdx);
              const parallelId = sepIdx === -1 ? null : key.slice(sepIdx + 1);
              const p = profiles.find((pp) => pp.id === profileId);
              if (!p) return null;
              let cwd = p.workingDirectory;
              if (parallelId) {
                const pa = parallelAgents.get(parallelId);
                if (!pa) return null; // parallel gone — viewer will be unmounted next render
                cwd = pa.worktreePath;
              }
              const visible = key === activeViewKey && kanbanViews.has(key);
              return (
                <KanbanViewer
                  key={key}
                  instanceKey={key}
                  profileId={p.id}
                  cwd={cwd}
                  settings={settings}
                  hidden={!visible}
                />
              );
            })}
            {/* Mount one WebViewer per view in webRunning — same persist-
                in-background pattern as Kanban. View key includes the
                parallel-agent id so each agent gets its own page. */}
            {[...webRunning].map((key) => {
              const visible = key === activeViewKey && webViews.has(key);
              const nav = pendingWebNavigate && pendingWebNavigate.key === key
                ? { url: pendingWebNavigate.url, nonce: pendingWebNavigate.nonce }
                : null;
              // Per-view saved URL wins; otherwise fall back to the
              // user's configured default landing page.
              const saved = settings.webUrls?.[key];
              const initialUrl = saved && saved.length > 0
                ? saved
                : (settings.webDefaultUrl || 'https://duckduckgo.com/');
              return (
                <WebViewer
                  key={key}
                  instanceKey={key}
                  initialUrl={initialUrl}
                  hidden={!visible}
                  pendingNavigate={nav}
                  onUrlChange={handleWebUrlChange}
                />
              );
            })}
            {/* Mount one ParallelAgentTerminal per parallel agent so each PTY's
                xterm.js stays alive and switching between them is just CSS.
                The selected session is shown; in split mode it becomes the
                LEFT pane (negative flex order pulls it ahead of the resize
                handle + right-pane overlay) at agentSplitPercent width. */}
            {[...parallelAgents.values()].map((sa) => {
              const isSelected = selectedParallelId === sa.id && activeProfileId === sa.profileId;
              return (
                <ParallelAgentTerminal
                  key={sa.id}
                  agent={sa}
                  settings={settings}
                  hidden={!isSelected || (!splitMode && (filesVisible || kanbanVisible || webVisible))}
                  splitWidth={isSelected && splitMode ? agentSplitPercent : null}
                />
              );
            })}
            {/* Remote-agent chat panes (Hermes over Telegram) — one per
                remote profile, persistent like the other panes. Takes the
                agent slot; in split mode it becomes the LEFT pane. */}
            {profiles.filter((p) => p.remoteAgent).map((p) => {
              const isActive = p.id === activeProfileId && selectedParallelId === null;
              return (
                <RemoteChatPane
                  key={p.id}
                  profile={p}
                  hidden={!isActive || (!splitMode && (filesVisible || kanbanVisible || webVisible))}
                  splitWidth={isActive && splitMode ? agentSplitPercent : null}
                />
              );
            })}
          </div>
          {shellOpen && (
            <ResizeHandle direction="vertical" onResize={handleTerminalSplitResize} />
          )}
          <div
            className="terminal-pane shell-pane"
            style={
              shellOpen
                ? { height: `${100 - agentPercent}%`, display: 'block' }
                : { display: 'none' }
            }
          >
            {[
              // One shell view per profile (parent), plus one per parallel
              // session — each session keyed by its viewKey and rooted in
              // its worktree, so its shells are isolated and land in the
              // worktree dir (the session behaves like a regular profile).
              ...profiles.map((p) => ({ key: p.id, cwd: p.workingDirectory, isSession: false })),
              ...[...parallelAgents.values()].map((a) => ({
                key: `${a.profileId}|${a.id}`, cwd: a.worktreePath, isSession: true,
              })),
            ].map((v) => {
              const isVisible = shellOpenSet.has(v.key) && v.key === activeViewKey;
              const wasOpened = shellOpenedRef.current.has(v.key);
              if (!wasOpened && !isVisible) return null;
              return (
                <div
                  key={v.key}
                  style={{ display: isVisible ? 'block' : 'none', width: '100%', height: '100%' }}
                >
                  <ShellPane
                    profileId={v.key}
                    workingDirectory={v.cwd}
                    hidden={!isVisible}
                    settings={settings}
                    webEnabled={settings.functionWebEnabled !== false}
                    getSnapTargets={getShellSnapTargets}
                    onDividersChange={reportShellDividers}
                    onAllClosed={() => {
                      setShellOpenSet((prev) => {
                        const next = new Set(prev);
                        next.delete(v.key);
                        return next;
                      });
                      setFocusedPane({ pane: 'agent', shellIndex: 0 });
                    }}
                    focused={isVisible && focusedPane.pane === 'shell'}
                    focusedIndex={focusedPane.shellIndex}
                    navActive={navActive && isVisible}
                    navFocusedPane={focusedPane}
                    onShellCountChange={(count) => {
                      if (v.key === activeViewKey) shellCountRef.current = count;
                      // Persist shell count for profiles only; sessions are
                      // transient worktrees and aren't restored across launches.
                      if (!v.isSession && count > 0) {
                        const memory = { ...profileMemoryRef.current };
                        if (!memory[v.key]) memory[v.key] = { shellOpen: true, shellCount: 1 };
                        memory[v.key].shellCount = count;
                        profileMemoryRef.current = memory;
                        window.api.saveProfileMemory(memory);
                      }
                    }}
                    initialShellCount={(!v.isSession && profileMemoryRef.current[v.key]?.shellCount) || 1}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {changesVisible && activeProfile && (
          <GitChangesPanel
            workingDirectory={activeViewCwd}
            widthPercent={changesWidth}
            onWidthChange={setChangesWidth}
            onClose={() => setChangesVisible(false)}
            activeTab={gitPanelTab}
            onTabChange={setGitPanelTab}
            pullStrategy={settings.pullStrategy ?? 'merge'}
            pushTagsStrategy={settings.pushTagsStrategy ?? 'off'}
            diffViewMode={settings.diffViewMode ?? 'unified'}
            onDiffViewModeChange={(mode) => savePaneSizes({ diffViewMode: mode })}
            showAuthorAvatars={settings.showAuthorAvatars ?? true}
          />
        )}
        {findInFilesVisible && activeProfile && (
          <FindInFilesPanel
            workingDirectory={activeViewCwd}
            widthPercent={searchWidth}
            onWidthChange={setSearchWidth}
            onClose={() => setFindInFilesVisible(false)}
            openRequest={findPanelRequest}
            dirtyPaths={activeViewKey ? (dirtyFilesByView[activeViewKey] ?? []) : []}
            onOpenResult={(absolutePath, line) => {
              if (activeViewKey) {
                const key = activeViewKey;
                setFilesViews((prev) => ensureInSet(prev, key));
                setFilesRunning((prev) => ensureInSet(prev, key));
                setKanbanViews((prev) => removeFromSet(prev, key));
                setWebViews((prev) => removeFromSet(prev, key));
              }
              setPendingFileOpen({ path: absolutePath, nonce: Date.now(), line });
            }}
          />
        )}
      </div>
      <StatusBar
        profile={activeProfile && selectedParallel
          ? { ...activeProfile, workingDirectory: activeViewCwd }
          : activeProfile}
        onToggleChanges={() => {
          // Toggle off only if the panel is already open on this tab;
          // otherwise open (or switch from the tree tab) and keep it open.
          if (changesVisible && gitPanelTab === 'changes') {
            setChangesVisible(false);
          } else {
            setGitPanelTab('changes');
            setFindInFilesVisible(false);
            setChangesVisible(true);
          }
        }}
        onBranchClick={() => {
          if (changesVisible && gitPanelTab === 'tree') {
            setChangesVisible(false);
          } else {
            setGitPanelTab('tree');
            setFindInFilesVisible(false);
            setChangesVisible(true);
          }
        }}
      />
      {editorOpen && (
        <ProfileEditor
          profile={editingProfile}
          agents={settings.agents || []}
          onSave={handleSaveProfile}
          onDelete={handleDeleteProfile}
          onClose={() => setEditorOpen(false)}
          onStartIconGeneration={handleStartIconGeneration}
          pendingIconGenerations={pendingIconGenerations}
        />
      )}
      {quickOpenVisible && activeProfile && (
        <QuickOpenDialog
          workingDirectory={activeViewCwd}
          onClose={() => setQuickOpenVisible(false)}
          onPick={(relativePath, line) => {
            setQuickOpenVisible(false);
            // Make sure the Files tab is open + mounted before the
            // pendingFileOpen ref fires, otherwise the FileExplorer
            // won't see it.
            if (activeViewKey) {
              const key = activeViewKey;
              setFilesViews((prev) => ensureInSet(prev, key));
              setFilesRunning((prev) => ensureInSet(prev, key));
              setKanbanViews((prev) => removeFromSet(prev, key));
              setWebViews((prev) => removeFromSet(prev, key));
            }
            // Resolve against the view's cwd (worktree for a session) — the
            // picker listed files relative to that same directory.
            const absolute = `${activeViewCwd.replace(/\/+$/, '')}/${relativePath}`;
            setPendingFileOpen({ path: absolute, nonce: Date.now(), line });
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setSettingsOpen(false)}
          batchGenerating={batchGenerating}
          batchProgress={batchProgress}
          onBatchGenerate={handleBatchGenerateIcons}
          profilesWithoutIcons={profiles.filter((p) => !p.icon).length}
        />
      )}
      {/* Progressive hotkey HUD — holding ⌘/⌃/⌥ reveals the available
          shortcuts; adding modifiers narrows the list. Opt-in (default off)
          via Settings → Functions. Self-manages visibility from live
          modifier state. */}
      {settings.hotkeyHintsEnabled === true && (
        <HotkeyHints navModifierKey={settings.navModifierKey} commandBarLabels={navActions.labels} />
      )}
      {/* Unsaved-files dialog shown before quitting (Cmd+Q / window close)
          when any profile has unsaved editor buffers. Save all flushes
          every dirty buffer; Discard quits anyway; Cancel keeps the app
          open. The main process waits on the decision via APP_QUIT_DECISION. */}
      {quitPrompt && (
        <div className="modal-overlay" onClick={handleQuitCancel}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Unsaved Changes</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                You have unsaved changes in {quitPrompt.length === 1 ? 'this profile' : 'these profiles'}:
              </p>
              <ul style={{ fontSize: 13, lineHeight: 1.5, margin: 0, paddingLeft: 18 }}>
                {quitPrompt.map((p) => (
                  <li key={p.profileName}>
                    <strong>{p.profileName}</strong>
                    <span style={{ color: 'var(--c-subtext0)' }}> — {p.files.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={handleQuitCancel}>Cancel</button>
                <button className="delete-btn" onClick={handleQuitDiscard}>Discard &amp; Quit</button>
                <button className="save-btn" onClick={handleQuitSaveAll}>Save all &amp; Quit</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Missing working-directory dialog. Triggered by the lazy
          verifyProfileDir check on selection (or at app boot when
          restoring lastActiveProfileId). The user can relocate the
          folder (updates profile.workingDirectory + re-runs the
          selection that triggered the modal), delete the profile,
          or cancel and leave things untouched. */}
      {missingDirProfileId && (() => {
        const target = profiles.find((p) => p.id === missingDirProfileId);
        if (!target) return null;
        const close = () => setMissingDirProfileId(null);
        const relocate = async () => {
          const picked = await window.api.selectDirectory();
          if (!picked) return; // user cancelled the native picker
          const updated = profiles.map((p) =>
            p.id === target.id ? { ...p, workingDirectory: picked } : p,
          );
          await window.api.saveProfiles(updated);
          setProfiles(updated);
          setMissingDirProfileId(null);
          // Run the normal selection path on the now-valid profile so
          // the agent terminal spins up against the new directory.
          setActiveProfileId(target.id);
          initializeProfile(target.id);
        };
        const deleteIt = async () => {
          setMissingDirProfileId(null);
          await handleDeleteProfile(target.id);
        };
        return (
          <div className="modal-overlay" onClick={close}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Project folder not found</h3>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                  The working directory for <strong>{target.name}</strong> doesn&apos;t exist on disk:
                </p>
                <pre style={{
                  fontSize: 12,
                  background: 'var(--c-mantle)',
                  padding: '6px 8px',
                  borderRadius: 4,
                  border: '1px solid var(--c-surface0)',
                  color: 'var(--c-overlay1)',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>{target.workingDirectory}</pre>
                <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--c-overlay0)', marginTop: 10 }}>
                  Did you move it to a new location, or should this profile be removed?
                </p>
              </div>
              <div className="modal-footer">
                <button className="cancel-btn" onClick={close}>Cancel</button>
                <div className="modal-footer-right">
                  <button className="delete-btn" onClick={deleteIt}>Delete profile</button>
                  <button className="save-btn" onClick={relocate}>Locate folder…</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      {stopParallelTarget && (() => {
        const target = parallelAgents.get(stopParallelTarget);
        const closeDialog = () => setStopParallelTarget(null);
        const stopWith = (discardWork: boolean) => {
          const id = stopParallelTarget;
          setStopParallelTarget(null);
          window.api.destroyParallelAgent(id, discardWork).catch((): void => undefined);
        };
        return (
          <div className="modal-overlay" onClick={closeDialog}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Stop parallel agent</h3>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                  Stopping <strong>{target?.taskTitle || target?.taskId || 'this agent'}</strong>.
                  What should happen to its work?
                </p>
                <ul style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--c-overlay0)', marginLeft: 16 }}>
                  <li><strong>Save WIP</strong> — commits any uncommitted changes onto the agent&apos;s branch (<code>{target?.branch}</code>) so you can recover the work later. The worktree directory is removed.</li>
                  <li><strong>Discard</strong> — throws away the work and deletes the branch. Use this if you started the agent by mistake.</li>
                </ul>
              </div>
              <div className="modal-footer">
                <button className="cancel-btn" onClick={closeDialog}>Cancel</button>
                <div className="modal-footer-right">
                  <button className="delete-btn" onClick={() => stopWith(true)}>Discard</button>
                  <button className="save-btn" onClick={() => stopWith(false)}>Save WIP</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      {sessionMenu && (
        <>
          {/* click-away catcher */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
            onClick={() => setSessionMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setSessionMenu(null); }}
          />
          <div
            className="file-context-menu"
            style={{ position: 'fixed', left: sessionMenu.x, top: sessionMenu.y, zIndex: 1000 }}
          >
            {isBuiltinAgentProfile(sessionMenu.profile) && (
              <>
                <button
                  className="file-ctx-item"
                  onClick={() => { const p = sessionMenu.profile; setSessionMenu(null); setSessionPickerProfile(p); }}
                >
                  Start from session…
                </button>
                <button
                  className="file-ctx-item"
                  onClick={() => { const p = sessionMenu.profile; setSessionMenu(null); startAgentSession(p, null, 'New session'); }}
                >
                  New session
                </button>
              </>
            )}
            {isTempProfile(sessionMenu.profile) && (
              <>
                {isBuiltinAgentProfile(sessionMenu.profile) && <div className="file-ctx-divider" />}
                <button
                  className="file-ctx-item"
                  title="Move everything in the temp folder (hidden files included) into a folder you pick, then point this profile there"
                  onClick={() => { const p = sessionMenu.profile; setSessionMenu(null); convertTempProfile(p); }}
                >
                  Convert to project…
                </button>
              </>
            )}
          </div>
        </>
      )}
      {sessionPickerProfile && (() => {
        const p = sessionPickerProfile;
        const resolved = resolveAgent(p, settings.agents || DEFAULT_AGENTS);
        const agentName = (settings.agents || DEFAULT_AGENTS).find((a) => a.id === p.agentId)?.name || resolved.command;
        return (
          <SessionPickerDialog
            agentName={agentName}
            agentCommand={resolved.command}
            workingDirectory={p.workingDirectory}
            running={initialized.has(p.id)}
            onClose={() => setSessionPickerProfile(null)}
            onStart={(sessionId, label) => { setSessionPickerProfile(null); startAgentSession(p, sessionId, label); }}
          />
        );
      })()}
      <ToastContainer />
    </div>
  );
}
