export type AgentStatus = 'ready' | 'working' | 'needs-input' | 'offline';

export interface StatusPatterns {
  ready: string[];
  needsInput: string[];
}

export interface Profile {
  id: string;
  name: string;
  icon: string;
  workingDirectory: string;
  command: string;       // kept for backwards compat — used if agentId is missing
  args: string[];        // kept for backwards compat
  agentId?: string;      // references AgentConfig.id from settings
  statusPatterns?: StatusPatterns;
  /** When true, Kanban tasks dispatched against this profile spawn a new
   * isolated worktree + agent instead of being injected into the main agent. */
  parallelAgentEnabled?: boolean;
  /** When a parallel agent for this profile finishes (task marked
   * `status: done`), automatically commit, push the branch, and open a PR
   * via `gh`. Per-profile so different repos can use different policies. */
  parallelAgentAutoPush?: boolean;
  /** Workspace this profile belongs to. Required after first launch — a
   * migration on load assigns any profile missing this field to the
   * Default workspace. Optional in the type only so the migration step
   * can read pre-migration files cleanly. */
  workspaceId?: string;
}

/** A Workspace is a top-level grouping of Agent Profiles. The sidebar
 * shows one workspace at a time and the workspace dropdown switches
 * between them. The "directories" of a workspace are derived from the
 * working directories of its profiles — no separate field. */
export interface Workspace {
  id: string;
  name: string;
}

export interface ProfileMemory {
  shellOpen: boolean;
  shellCount: number;
}

export interface ProfileMemoryMap {
  [profileId: string]: ProfileMemory;
}

export interface AppSettings {
  baseHue: number; // 0-360, default 240 (purple), 360 = grayscale
  darkness: number; // 0-100, default 0. Scales lightness down toward black.
  textLightness: number; // 0-100, default 50. Controls UI text brightness.
  profileFontSize: number; // 10-20, default 14
  agentFontSize: number; // 10-24, default 12
  shellFontSize: number; // 10-24, default 10
  // Font weights — 100..900. Defaults match CSS `normal` / `bold`.
  // The non-bold weight applies to ordinary text; the *Bold variant
  // applies whenever the renderer is asked to draw bold (xterm only —
  // the profile sidebar treats both numbers as "weight" and ignores Bold).
  profileFontWeight: number;     // sidebar profile rows (default 400)
  profileFontWeightBold: number; // unused for sidebar but kept for symmetry
  agentFontWeight: number;       // xterm agent terminal (default 400)
  agentFontWeightBold: number;   // xterm agent bold (default 700)
  shellFontWeight: number;       // xterm shell terminal (default 400)
  shellFontWeightBold: number;   // xterm shell bold (default 700)
  iconProvider: 'gemini' | 'openai'; // Which AI to use for icon generation
  geminiModel: string; // Gemini model for image generation
  geminiApiKey: string; // Google Gemini API key
  openaiModel: string; // OpenAI model for image generation
  openaiApiKey: string; // OpenAI API key
  iconPromptPrefix: string; // Universe/style description for generated icons
  iconReferenceImage: string; // Path to reference image for style consistency
  sidebarWidth: number; // pixels, default 250 — the "expanded" width
  /** When true, the sidebar renders in a narrow icon-only mode. Drives the
   * snap behaviour: dragging the resizer below ~110 px snaps to compact;
   * dragging back above ~110 px from compact snaps to the saved
   * `sidebarWidth`. */
  sidebarCompact: boolean;
  terminalSplitPercent: number; // agent pane %, default 67
  /** Width % of the agent pane when split-with-Files/Kanban mode is on.
   * Per-profile split-mode on/off is in-memory (splitViews Set); the
   * width itself is shared across profiles. */
  agentSplitPercent: number;
  agents: AgentConfig[];
  externalApps: ExternalApp[];
  navModifierKey: 'meta' | 'alt'; // Modifier key for quick navigation
  dictationMode: 'toggle' | 'hold'; // toggle = click start/stop, hold = hold button to dictate
  dictationLang: string; // BCP 47 language code e.g. 'en-US'
  lastActiveProfileId: string; // Restored on app launch
  /** Workspaces — top-level groupings of agent profiles. Always has at
   * least one entry (a migration creates "Default" on first launch and
   * assigns any pre-existing profiles to it). */
  workspaces: Workspace[];
  /** ID of the currently-visible workspace in the sidebar. */
  activeWorkspaceId: string;
  gpuAcceleration: 'auto' | 'canvas' | 'off'; // Terminal rendering: auto tries WebGL, canvas skips WebGL, off disables GPU
  flameIntensity: number; // 0-100, default 9. Controls flame brightness/opacity.
  flameSpread: number; // 0-100, default 26. Controls horizontal spread of flame spikes.
  flameLength: number; // 0-100, default 64. Controls how far flames extend from edge.
  flameSpeed: number; // 0-100, default 23. Controls animation speed.
  showAgentBadge: boolean; // Show agent logo badge on profile items
  /** When true, command-bar action buttons (Terminal, Mic, Folder) render
   * with a text label next to the icon. False = icon-only. External app
   * buttons are unaffected — they always show their name. */
  showActionLabels: boolean;
  ordnaMode: 'web' | 'tui'; // Kanban mode for Ordna integration
  ordnaHookPort: number; // Local HTTP port for receiving Ordna agent hooks
  ordnaHookToken: string; // Random shared secret for the X-Token header
  /** When true, the prefixed Kanban task message is sent into a freshly
   * spawned parallel agent automatically after a short delay. When false,
   * the task waits in the agent's prompt until the user clicks ▶ Run. */
  parallelAgentAutoRun: boolean;
  /** Per-function feature flags (Settings → Functions). When disabled,
   * the corresponding tab is hidden from the command bar and any open
   * view of that kind is closed. Both default to true. */
  functionKanbanEnabled: boolean;
  functionWebEnabled: boolean;
  /** Default Pull strategy used by the panel's primary Pull button.
   * 'merge' = plain `git pull` (the current behaviour).
   * 'rebase' = `git pull --rebase` (linear history).
   * 'ask' = primary button opens the chevron menu so the user picks
   * each time. */
  pullStrategy: 'merge' | 'rebase' | 'ask';
  /** What plain Push does about tags by default. The dropdown always
   * offers the explicit "Push with tags" / "Push reachable tags" items
   * regardless. */
  pushTagsStrategy: 'off' | 'reachable' | 'all';
  /** Rendering mode for diff hunks in the Git panel:
   * 'unified' = single column, lines coloured red/green (GitHub default)
   * 'split' = side-by-side, removed left, added right, context paired */
  diffViewMode: 'unified' | 'split';
  /** T-038: show gravatar-resolved author avatars in the commit graph.
   * When off, the graph falls back to plain text-only author columns.
   * Default on; off-line / blocked-egress users can disable it. */
  showAuthorAvatars: boolean;
  /** T-045: run Prettier on every file save. Default off so save
   * stays a pure flush-to-disk for users who don't want their
   * formatting touched. */
  formatOnSave: boolean;
  /** T-046: render sticky scope headers inside the editor viewport.
   * (The breadcrumbs row that originally lived alongside this was
   * removed — the file tab already shows the filename and the
   * "Reveal in tree" button covers the path-jump use case.) */
  editorStickyScroll: boolean;
  /** Show dotfile / hidden entries in the file tree. Default on so
   * `.gitignore`, `.env`, `.vscode/`, etc. are visible. Toggling
   * off hides anything whose name starts with a dot. */
  showHiddenFiles: boolean;
  /** T-047: editor font size in pixels. Cmd+= / Cmd+- / Cmd+0 in
   * a focused CodeMirror buffer adjust this; Settings → Appearance
   * has a manual input. Default 13 — matches the previous hard-
   * coded value before this setting existed. */
  editorFontSize: number;
  /** Which editor backs the file view. 'monaco' (the VS Code editor) is the
   * default and covers plain editing, the inline diff, blame, and markdown
   * editing. 'codemirror' is the legacy fallback. See docs/MONACO_MIGRATION.md. */
  editorEngine?: 'codemirror' | 'monaco';
  /** Context lines kept on each side of a change when the Monaco diff's
   * "collapse unchanged lines" toggle is on. Default 6. */
  diffContextLines?: number;
  /** Fire OS notifications when an agent finishes (working→ready) or needs
   * input. Default on; `false` disables them. */
  notificationsEnabled?: boolean;
  /** Show the progressive hotkey HUD (hold a modifier to reveal matching
   * shortcuts). Default off — opt-in via Settings. */
  hotkeyHintsEnabled?: boolean;
  /** Default landing page for a Web tab that has never been navigated.
   * Once a view has a saved URL in `webUrls`, this is ignored. Free-form
   * text — non-URL input is interpreted as a DuckDuckGo search at click
   * time (same normalisation as the address bar). */
  webDefaultUrl: string;
  /** Per-view last URL for the in-app browser, keyed by viewKey
   * (`profileId` for parents, `profileId|parallelId` for parallel agents).
   * Lets the Web tab restore the page the user was on after an app
   * restart. Combined with the webview's `persist:` partition this also
   * means cookies / logins survive. */
  webUrls: Record<string, string>;
  /** Per-profile snapshot of which function tabs (Files / Kanban /
   * Web) were open and whether split view was enabled when Vyb last
   * quit. Restored on launch so the user lands back in the same
   * layout. Parallel-agent views are session-bound and not persisted
   * here — only parent profile IDs appear as keys. */
  openFunctionTabs: Record<string, {
    files?: boolean;
    kanban?: boolean;
    web?: boolean;
    split?: boolean;
    /** FileExplorer's "show only git-changed files" toggle, per profile. */
    showChanged?: boolean;
  }>;
  /** Per-profile snapshot of the FileExplorer's open file tabs. Paths
   * are absolute. `activePath` is the tab that should be focused on
   * restore (must appear in `paths`). Same per-viewKey shape as
   * openFunctionTabs; parallel-agent keys (containing '|') are not
   * persisted. */
  fileExplorerTabs?: Record<string, { paths: string[]; activePath?: string }>;
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Extra CLI args injected only when the agent is started by a parallel
   * (Kanban-dispatched) worktree spawn. Lets each agent run with a
   * permissive auto-approve mode in that isolated context. */
  permissionModeArgs?: string[];
}

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    args: ['--continue'],
    permissionModeArgs: ['--permission-mode', 'acceptEdits'],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    args: ['resume'],
    permissionModeArgs: ['--full-auto'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    command: 'gemini',
    args: ['--resume'],
    permissionModeArgs: ['--approval-mode', 'yolo'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: [],
    permissionModeArgs: [],
  },
];

export interface ExternalApp {
  id: string;
  name: string;
  icon: string; // icon key from APP_ICONS (e.g. 'code', 'gitBranch')
  command: string; // e.g. 'open -a "Visual Studio Code" "{path}"' — use {path} as placeholder
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseHue: 360,
  darkness: 0,
  textLightness: 12,
  profileFontSize: 14,
  agentFontSize: 11,
  shellFontSize: 10,
  profileFontWeight: 300,
  profileFontWeightBold: 500,
  agentFontWeight: 100,
  agentFontWeightBold: 300,
  shellFontWeight: 100,
  shellFontWeightBold: 300,
  iconProvider: 'gemini',
  geminiModel: 'gemini-3.1-flash-image-preview',
  geminiApiKey: '',
  openaiModel: 'gpt-image-1',
  openaiApiKey: '',
  iconPromptPrefix: 'A minimal, modern flat icon with a dark background, clean geometric shapes, suitable as a project avatar',
  iconReferenceImage: '',
  sidebarWidth: 250,
  sidebarCompact: false,
  terminalSplitPercent: 67,
  agentSplitPercent: 50,
  agents: [...DEFAULT_AGENTS],
  externalApps: [
    { id: 'vscode', name: 'VS Code', icon: 'vscode', command: 'open -a "Visual Studio Code" "{path}"' },
    { id: 'fork', name: 'Fork', icon: 'gitBranch', command: 'open -a Fork "{path}"' },
  ],
  navModifierKey: 'meta',
  dictationMode: 'toggle',
  dictationLang: 'en-US',
  lastActiveProfileId: '',
  // Workspaces default to empty here; App.tsx runs a migration on
  // first launch that creates a Default workspace and assigns all
  // existing profiles + folders to it.
  workspaces: [],
  activeWorkspaceId: '',
  gpuAcceleration: 'auto',
  flameIntensity: 9,
  flameSpread: 26,
  flameLength: 64,
  flameSpeed: 23,
  showAgentBadge: true,
  showActionLabels: false,
  ordnaMode: 'web',
  ordnaHookPort: 9876,
  ordnaHookToken: '',
  parallelAgentAutoRun: true,
  functionKanbanEnabled: true,
  functionWebEnabled: true,
  pullStrategy: 'merge',
  pushTagsStrategy: 'off',
  diffViewMode: 'unified',
  showAuthorAvatars: true,
  formatOnSave: false,
  editorStickyScroll: true,
  showHiddenFiles: true,
  editorFontSize: 13,
  editorEngine: 'monaco',
  diffContextLines: 6,
  notificationsEnabled: true,
  hotkeyHintsEnabled: false,
  webDefaultUrl: 'https://duckduckgo.com/',
  webUrls: {},
  openFunctionTabs: {},
  fileExplorerTabs: {},
};

/** Resolve the command and args for a profile, looking up the agent config if set */
export function resolveAgent(profile: Profile, agents: AgentConfig[]): { command: string; args: string[] } {
  if (profile.agentId) {
    const agent = agents.find((a) => a.id === profile.agentId);
    if (agent) return { command: agent.command, args: [...agent.args] };
  }
  // Backwards compat: use profile's own command/args
  return { command: profile.command, args: [...profile.args] };
}

export interface SidebarFolder {
  id: string;
  name: string;
  isOpen: boolean;
  profileIds: string[];
  /** Optional path to a reference image for AI icon generation. When set,
   * profiles inside this folder use it instead of the global
   * `settings.iconReferenceImage`. Empty / undefined → fall back to the
   * global setting. */
  referenceImage?: string;
  /** Workspace this folder belongs to. Same migration story as
   * Profile.workspaceId — populated for new folders, backfilled to the
   * Default workspace on first load for pre-existing folders. */
  workspaceId?: string;
}

export type SidebarItem =
  | { type: 'profile'; profileId: string }
  | { type: 'folder'; folderId: string };

export interface SidebarLayout {
  items: SidebarItem[];
  folders: SidebarFolder[];
}

export const IPC_CHANNELS = {
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DESTROY: 'terminal:destroy',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_ACK: 'terminal:ack',
  SHELL_TERMINAL_CREATE: 'shell-terminal:create',
  SHELL_TERMINAL_EXITED: 'shell-terminal:exited',
  PROFILES_LOAD: 'profiles:load',
  PROFILES_SAVE: 'profiles:save',
  PROFILE_STATUS_CHANGE: 'profile:status-change',
  PROFILE_COMPLETION_CONFIRMED: 'profile:completion-confirmed',
  PROFILE_STATUS_QUERY: 'profile:status-query',
  SHELL_SHOW_IN_FOLDER: 'shell:showInFolder',
  SHELL_OPEN_VSCODE: 'shell:openVSCode',
  SHELL_OPEN_FORK: 'shell:openFork',
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  SHELL_OPEN_URL: 'shell:openUrl',
  /** Embed DevTools for a target `<webview>` (by webContentsId) into a
   * second `<webview>` (host) so the DevTools panel renders inline
   * inside the in-app browser instead of opening a separate window. */
  WEBVIEW_OPEN_DEVTOOLS: 'webview:openDevTools',
  WEBVIEW_CLOSE_DEVTOOLS: 'webview:closeDevTools',
  /** Register a webview's webContentsId so the main process attaches a
   * context-menu listener to it. Idempotent per target. */
  WEBVIEW_REGISTER_CONTEXT_MENU: 'webview:registerContextMenu',
  /** Renderer-bound: main fires this when the user picks "Inspect
   * Element" from the context menu. Payload: `{ targetId, x, y }`. */
  WEBVIEW_INSPECT_REQUEST: 'webview:inspectRequest',
  /** Renderer asks main to call inspectElement(x, y) on the target
   * webContents — used after the embedded DevTools host has been
   * wired up so the inspector highlights the right element. */
  WEBVIEW_INSPECT_AT: 'webview:inspectAt',
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  DIALOG_SELECT_FILE: 'dialog:selectFile',
  DIALOG_CREATE_TEMP_DIR: 'dialog:createTempDir',
  /** Returns true if the absolute path exists on disk. Used to detect
   * agent profiles whose working directory has been moved/deleted so
   * the user can be prompted to relocate or remove the profile. */
  FS_PATH_EXISTS: 'fs:pathExists',
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_OPEN_DIALOG: 'settings:openDialog',
  // Quit handshake: main asks the renderer to check for unsaved editor
  // buffers before closing; renderer replies with the user's decision.
  APP_BEFORE_QUIT: 'app:beforeQuit',
  APP_QUIT_DECISION: 'app:quitDecision',
  PROFILE_SET_ACTIVE: 'profile:setActive',
  PROFILE_ACTIVATE_REQUEST: 'profile:activateRequest',
  GENERATE_ICON: 'icon:generate',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_SAVE: 'layout:save',
  README_LOAD: 'readme:load',
  GIT_STATUS: 'git:status',
  GIT_FETCH: 'git:fetch',
  GIT_CHANGED_FILES: 'git:changedFiles',
  GIT_FILE_DIFF: 'git:fileDiff',
  /** Returns the contents of `filePath` at HEAD as a string, or null if
   * the file isn't tracked at HEAD. Used to drive the unified inline
   * diff view in the file editor. */
  GIT_FILE_AT_HEAD: 'git:fileAtHead',
  GIT_LOG: 'git:log',
  GIT_LIST_REFS: 'git:listRefs',
  GIT_CHECKOUT_COMMIT: 'git:checkoutCommit',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_AMEND_COMMIT: 'git:amendCommit',
  GIT_REWORD_HEAD: 'git:rewordHead',
  GIT_HEAD_INFO: 'git:headInfo',
  GIT_PUSH_FORCE_LEASE: 'git:pushForceLease',
  GIT_PULL_REBASE: 'git:pullRebase',
  GIT_COMPARE_FILES: 'git:compareFiles',
  GIT_COMPARE_FILE_DIFF: 'git:compareFileDiff',
  GIT_SHOW_STAGE: 'git:showStage',
  GIT_APPLY_PATCH: 'git:applyPatch',
  GIT_FILE_LOG: 'git:fileLog',
  GIT_FILE_LOG_DIFF: 'git:fileLogDiff',
  GIT_BLAME_FILE: 'git:blameFile',
  GIT_GET_SIGN_COMMITS: 'git:getSignCommits',
  GIT_SET_SIGN_COMMITS: 'git:setSignCommits',
  GIT_COMMIT_SIGNATURES: 'git:commitSignatures',
  GIT_LIST_REMOTES: 'git:listRemotes',
  GIT_ADD_REMOTE: 'git:addRemote',
  GIT_RENAME_REMOTE: 'git:renameRemote',
  GIT_SET_REMOTE_URL: 'git:setRemoteUrl',
  GIT_REMOVE_REMOTE: 'git:removeRemote',
  GIT_REMOTE_TRACKING_BRANCHES: 'git:remoteTrackingBranches',
  GIT_LIST_WORKTREES: 'git:listWorktrees',
  GIT_REMOVE_WORKTREE: 'git:removeWorktree',
  GIT_REFLOG: 'git:reflog',
  GIT_BISECT_START: 'git:bisectStart',
  GIT_BISECT_MARK: 'git:bisectMark',
  GIT_BISECT_RESET: 'git:bisectReset',
  GIT_BISECT_STATUS: 'git:bisectStatus',
  GIT_LFS_INFO: 'git:lfsInfo',
  GIT_LFS_LIST_LOCKS: 'git:lfsListLocks',
  GIT_LFS_LOCK: 'git:lfsLock',
  GIT_LFS_UNLOCK: 'git:lfsUnlock',
  GIT_LFS_FETCH: 'git:lfsFetch',
  GIT_LFS_PRUNE: 'git:lfsPrune',
  GIT_SUBMODULES_LIST: 'git:submodulesList',
  GIT_SUBMODULE_INIT: 'git:submoduleInit',
  GIT_SUBMODULE_UPDATE: 'git:submoduleUpdate',
  GIT_SUBMODULE_SYNC: 'git:submoduleSync',
  GIT_REBASE_INTERACTIVE: 'git:rebaseInteractive',
  FILE_LIST_PROJECT: 'file:listProject',
  FILE_SEARCH_IN_FILES: 'file:searchInFiles',
  FILE_FORMAT: 'file:format',
  GIT_DISCARD_FILE: 'git:discardFile',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_MERGE: 'git:merge',
  GIT_MERGE_ABORT: 'git:mergeAbort',
  GIT_MERGE_PREVIEW: 'git:mergePreview',
  GIT_CHECKOUT_OURS_THEIRS: 'git:checkoutOursTheirs',
  GIT_LIST_STASHES: 'git:listStashes',
  GIT_STASH_SAVE: 'git:stashSave',
  GIT_STASH_APPLY: 'git:stashApply',
  GIT_STASH_POP: 'git:stashPop',
  GIT_STASH_DROP: 'git:stashDrop',
  GIT_CREATE_BRANCH: 'git:createBranch',
  GIT_DELETE_BRANCH: 'git:deleteBranch',
  GIT_DELETE_REMOTE_BRANCH: 'git:deleteRemoteBranch',
  GIT_DELETE_TAG: 'git:deleteTag',
  GIT_REBASE: 'git:rebase',
  GIT_REBASE_ABORT: 'git:rebaseAbort',
  GIT_REBASE_CONTINUE: 'git:rebaseContinue',
  GIT_SET_UPSTREAM: 'git:setUpstream',
  GIT_UNSET_UPSTREAM: 'git:unsetUpstream',
  GIT_RENAME_BRANCH: 'git:renameBranch',
  GIT_ADD_WORKTREE: 'git:addWorktree',
  GIT_CREATE_PR: 'git:createPr',
  GIT_CREATE_TAG: 'git:createTag',
  GIT_CHERRY_PICK: 'git:cherryPick',
  GIT_CHERRY_PICK_ABORT: 'git:cherryPickAbort',
  GIT_CHERRY_PICK_CONTINUE: 'git:cherryPickContinue',
  GIT_REVERT: 'git:revert',
  GIT_REVERT_ABORT: 'git:revertAbort',
  GIT_REVERT_CONTINUE: 'git:revertContinue',
  GIT_RESET: 'git:reset',
  FILE_LIST_DIR: 'file:listDir',
  FILE_READ: 'file:read',
  FILE_SAVE: 'file:save',
  FILE_DELETE: 'file:delete',
  FILE_WATCH_START: 'file:watchStart',
  FILE_WATCH_STOP: 'file:watchStop',
  FILE_WATCH_CHANGE: 'file:watchChange',
  /** Returns true if a directory is too large / cloud-heavy to scan
   * comfortably (home dir, Dropbox/Drive roots, 50k+ files). Drives a
   * one-time warning when a profile points at such a directory. */
  FILE_DIR_IS_LARGE: 'file:dirIsLarge',
  FILE_RENAME: 'file:rename',
  FILE_COPY: 'file:copy',
  FILE_CREATE_DIR: 'file:createDir',
  FILE_CREATE: 'file:create',
  FILE_SAVE_AS: 'file:saveAs',
  FILE_RESOLVE_PATH: 'file:resolvePath',
  BACKUP_EXPORT: 'backup:export',
  BACKUP_IMPORT: 'backup:import',
  TRANSCRIBE_AUDIO: 'audio:transcribe',
  PROFILE_MEMORY_LOAD: 'profileMemory:load',
  PROFILE_MEMORY_SAVE: 'profileMemory:save',
  SCROLLBACK_LOAD: 'scrollback:load',
  SCROLLBACK_SAVE: 'scrollback:save',
  ORDNA_START: 'ordna:start',
  ORDNA_STOP: 'ordna:stop',
  ORDNA_GET_WEB_URL: 'ordna:getWebUrl',
  ORDNA_TASK_RECEIVED: 'ordna:taskReceived',
  ORDNA_HOOK_INFO: 'ordna:hookInfo',
  ORDNA_EXITED: 'ordna:exited',
  EDIT_MENU_ACTION: 'editMenu:action',
  EDIT_MENU_STATE: 'editMenu:state',
  // Renderer tells main whether the xterm terminal currently has focus, so
  // the native clipboard menu roles can be dropped while it does (xterm owns
  // Cmd+C/V/X/A itself; a menu accelerator would otherwise swallow them).
  TERMINAL_FOCUS_CHANGED: 'terminal:focusChanged',
  /** Pop the native application menu as a dropdown — used by the
   * in-app menu button on Windows/Linux where the custom title bar
   * hides the native menu bar. */
  MENU_POPUP: 'menu:popup',
  TITLEBAR_SET_OVERLAY: 'titlebar:setOverlay',
  PARALLEL_AGENT_SPAWN: 'parallel:spawn',
  PARALLEL_AGENT_DESTROY: 'parallel:destroy',
  PARALLEL_AGENT_LIST: 'parallel:list',
  PARALLEL_AGENT_FINISH: 'parallel:finish',
  PARALLEL_AGENT_CHANGE: 'parallel:change',
  PARALLEL_AGENT_EXITED: 'parallel:exited',
  PARALLEL_AGENT_SET_SELECTED: 'parallel:setSelected',
} as const;

export type ParallelAgentPhase =
  | 'starting'      // worktree being created, PTY about to spawn
  | 'awaiting'      // task message inserted, waiting for user to Run
  | 'running'       // PTY running task
  | 'completed'     // agent reached ready after working; PR may be open
  | 'pushing'       // commit + push + gh pr create in flight
  | 'failed';       // worktree, push, or PR creation failed

export interface ParallelAgent {
  id: string;            // unique id, used as PTY id `parallel:<id>`
  profileId: string;     // owning profile
  taskId: string;        // Ordna task id (e.g. T-014)
  taskTitle: string;
  branch: string;        // e.g. agent/T-014-make-open-tab-local
  worktreePath: string;  // absolute path of the isolated worktree
  parentRepoPath: string; // absolute path of the parent repo the worktree was created from
  phase: ParallelAgentPhase;
  prUrl?: string;
  errorMessage?: string;
  createdAt: number;
}

export interface OrdnaTask {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  priority: 'high' | 'medium' | 'low' | null;
  tags: string[];
  depends_on: string[];
  created_at: string;
  updated_at: string;
  sections: { heading: string; level: number; content: string }[];
  rawContent: string;
  filePath: string;
}

export interface OrdnaTaskPayload {
  action: 'agent';
  task: OrdnaTask;
  context: { tasksDir: string; cwd: string; schema: string };
}

export interface OrdnaTaskEnvelope {
  /** The profile whose Ordna instance dispatched this task (resolved by cwd). */
  sourceProfileId: string | null;
  payload: OrdnaTaskPayload;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type EditMenuAction =
  | 'save'
  | 'saveAs'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'find';

export interface EditMenuState {
  /** Whether a non-image file is currently open in the editor (i.e. menu items
   * other than Save should be enabled). */
  hasFile: boolean;
  /** Whether the active file has unsaved changes (Save item enabled). */
  canSave: boolean;
}

export interface GitChangedFile {
  path: string;
  added: number;   // lines added
  deleted: number; // lines deleted
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  staged: boolean;
}

export interface GitCommit {
  sha: string;          // full 40-char SHA
  parents: string[];    // parent SHAs
  author: string;       // author name
  email: string;        // author email
  date: string;         // ISO 8601 author date
  subject: string;      // first line of commit message
  /** T-042 GPG signature status. Single-character code from git's
   * `%G?` placeholder. Absent / 'N' = unsigned (omitted from the
   * object to keep memory low on large repos). 'G' = good, 'B' = bad,
   * 'U' = good but unknown validity, 'X' = good but expired,
   * 'Y' = good but expired key, 'R' = good but revoked key,
   * 'E' = signature can't be checked. */
  sigStatus?: string;
  /** Signer name from `%GS` when a signature was present. */
  sigSigner?: string;
}

/** Per-line blame record returned by `git:blameFile` (T-027). One
 * entry per line of the working-copy file at the time of the call.
 * `sha` is the commit that last touched the line; uncommitted local
 * changes appear with the special sentinel `0000000000000000000000000000000000000000`. */
export interface GitBlameLine {
  lineNumber: number;   // 1-based line in the current file
  sha: string;
  shortSha: string;
  author: string;
  authorTime: string;   // ISO 8601
  summary: string;      // first line of the commit message
}

/** T-039: one submodule entry. Status comes from the leading char of
 * `git submodule status`:
 *   ' ' clean, '-' not initialised, '+' SHA differs from index,
 *   'U' merge conflict. */
export interface GitSubmodule {
  path: string;
  /** Currently checked-out SHA (or expected SHA if uninitialised). */
  sha: string;
  shortSha: string;
  /** Friendly status: 'clean' / 'modified' / 'uninitialised' / 'conflict'. */
  status: 'clean' | 'modified' | 'uninitialised' | 'conflict';
  /** `git describe` output when available (e.g. tag/branch the SHA
   * points at). Empty when not initialised. */
  describe?: string;
  /** Configured URL from `.gitmodules` for this submodule (best-effort). */
  url?: string;
}

/** T-040: presence + summary of Git LFS in the current repo. Returned
 * by `git:lfsInfo`. When `available` is false, the LFS section in the
 * Branches tab shows a "not installed" empty state instead of action
 * buttons. */
export interface GitLfsInfo {
  /** `git lfs version` succeeded — the CLI extension is on PATH. */
  available: boolean;
  /** The repo's `.gitattributes` declares one or more LFS patterns. */
  configured: boolean;
  /** Sample of paths tracked by LFS in the working tree (first 50). */
  trackedSample: string[];
  /** Total tracked file count if known. */
  trackedCount: number;
}

/** T-040: one lock returned by `git lfs locks`. */
export interface GitLfsLock {
  id: string;
  path: string;
  owner: string;
  lockedAt?: string;
}

/** T-044: one match from `file:searchInFiles`. Multiple matches on
 * the same line collapse into one entry — `line` is the full source
 * line, `matchStart`/`matchEnd` mark just the first occurrence. */
export interface FileSearchMatch {
  /** Path relative to the search cwd, using forward slashes. */
  path: string;
  /** 1-based line number. */
  lineNumber: number;
  /** Full text of the matched line (truncated at 500 chars). */
  line: string;
  matchStart: number;
  matchEnd: number;
}

export interface FileSearchResult {
  matches: FileSearchMatch[];
  /** True when the result was capped (more matches existed). */
  truncated: boolean;
  /** True when the underlying tool (ripgrep) wasn't available;
   * UI can show a "install ripgrep for faster search" hint. */
  fallbackUsed: boolean;
  error?: string;
}

export interface FileSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Comma- or newline-separated globs; only files matching at
   * least one glob are searched. */
  include?: string;
  /** Comma- or newline-separated globs; files matching any are
   * skipped. */
  exclude?: string;
}

/** T-041: state of an in-progress `git bisect` session. `inProgress`
 * is false when there's no active bisect — all other fields are
 * meaningless in that case. */
export interface GitBisectStatus {
  inProgress: boolean;
  /** The commit the user is currently testing (HEAD during bisect). */
  currentSha?: string;
  currentSubject?: string;
  /** How many "good" / "bad" marks have been recorded so far. */
  goodCount: number;
  badCount: number;
  /** Estimated remaining bisect steps. -1 when git hasn't yet narrowed
   * to a bisectable range (e.g. only one side marked). */
  stepsRemaining: number;
  /** When git has identified the first-bad commit, its SHA. The
   * banner switches to a result view at this point. */
  foundSha?: string;
  foundSubject?: string;
}

/** T-036: one entry from `git reflog`. Used by the Tree tab's
 * Reflog view as a recovery aid — every state HEAD (or another ref)
 * has held in the local history is reachable via these SHAs even if
 * no branch points at them anymore. */
export interface GitReflogEntry {
  sha: string;
  shortSha: string;
  /** Selector like `HEAD@{2}` — git's stable handle for this entry. */
  selector: string;
  /** Reflog subject from `%gs`: "commit", "reset: moving to abc",
   * "checkout: moving from main to feature", etc. */
  action: string;
  /** ISO 8601 author date of the commit the reflog entry points at. */
  time: string;
  /** Commit subject (first line of the commit message). */
  subject: string;
}

/** T-035: a working tree linked to the repo. Returned by
 * `git:listWorktrees`. Includes the repo's main worktree (where
 * `.git` is a directory, not a file) plus any linked worktrees added
 * via `git worktree add`. */
export interface GitWorktree {
  path: string;            // absolute filesystem path
  branch?: string;         // short branch name; undefined when detached
  head: string;            // commit SHA the worktree is at
  isMain: boolean;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockedReason?: string;
  /** True when the worktree path lives under Vyb's `parallel-agents/`
   * directory — owned by the parallel-agent dispatcher. The UI shows
   * these dimmed and disables Remove to protect in-flight agents. */
  isSystemManaged: boolean;
}

/** T-034: configured remote in `.git/config`. Distinct from a
 * remote-tracking ref (those are GitRef entries with type='remote').
 * A remote can exist without any fetched branches yet, in which case
 * the Branches tab still renders an empty folder for it. */
export interface GitRemote {
  name: string;
  fetchUrl: string;
  /** May equal `fetchUrl` when there's no separate push URL set. */
  pushUrl: string;
}

export interface GitRef {
  name: string;          // short name (e.g. "main", "origin/main", "v1.0.0")
  fullName: string;      // full ref (e.g. "refs/heads/main")
  sha: string;           // commit SHA the ref points to
  type: 'local' | 'remote' | 'tag';
  remote?: string;       // for type='remote': the remote name (e.g. "origin")
  isHead: boolean;       // is this the current HEAD?
}

export interface GitCheckoutResult {
  ok: boolean;
  /** When `ok` is false: 'dirty' (working tree has changes), 'failed' (git error), or 'not-git'. */
  error?: 'dirty' | 'failed' | 'not-git';
  /** Underlying git error message when `error: 'failed'`. */
  message?: string;
}

export interface GitCommitResult {
  ok: boolean;
  /** Underlying git error message when commit failed (empty subject, hook
   * rejection, no staged changes, etc.). */
  message?: string;
}

/** Generic ok/error result for push, pull, and other one-shot git
 * operations whose only meaningful failure mode is "git said no". */
export interface GitOpResult {
  ok: boolean;
  message?: string;
  /** True when push succeeded but git had to publish the branch
   * (i.e. the branch had no upstream and we used `-u origin <branch>`). */
  publishedUpstream?: boolean;
}

export interface GitStash {
  /** Stash index (0 = newest). */
  index: number;
  /** Ref like `stash@{0}`. */
  ref: string;
  /** First-line message git stored for the stash. */
  message: string;
  /** Branch the stash was created on (parsed from message), if known. */
  branch: string;
}

export interface GitMergeResult {
  ok: boolean;
  /** Specific failure modes the UI surfaces differently:
   *   - 'dirty'    : working tree has uncommitted changes — can't merge.
   *   - 'conflict' : merge started but produced conflicts; left in-progress.
   *   - 'self'     : tried to merge a branch into itself.
   *   - 'detached' : current HEAD is detached, no branch to merge into.
   *   - 'invalid'  : source ref name didn't pass our shell-safety check.
   *   - 'failed'   : any other git error — `message` carries the stderr. */
  error?: 'dirty' | 'conflict' | 'self' | 'detached' | 'invalid' | 'not-git' | 'failed';
  message?: string;
  /** Files left in conflict state when error === 'conflict'. */
  conflictedFiles?: string[];
}

/** Result shape for `git rebase` / `git rebase --continue`. Mirrors
 * GitMergeResult: 'conflict' means the rebase is left in-progress so
 * the user can resolve in their shell and click Continue. */
export interface GitRebaseResult {
  ok: boolean;
  error?: 'dirty' | 'conflict' | 'self' | 'detached' | 'invalid' | 'not-git' | 'failed';
  message?: string;
  conflictedFiles?: string[];
}

/** Dry-run merge prediction via `git merge-tree --write-tree` (T-060).
 * `supported` is false on git too old for `--write-tree` (< 2.38); the
 * UI then just says preview isn't available. When `ok` + `supported`,
 * `clean` says whether the merge would apply without conflicts and
 * `conflictedFiles` lists the paths that would conflict. */
export interface GitMergePreviewResult {
  ok: boolean;
  supported?: boolean;
  clean?: boolean;
  conflictedFiles?: string[];
  error?: 'invalid' | 'not-git' | 'failed';
  message?: string;
}

/** PR-creation result. `url` is the URL gh prints on success. */
export interface GitCreatePrResult {
  ok: boolean;
  url?: string;
  message?: string;
}

export interface GitStatus {
  isGit: boolean;
  branch: string;
  modified: number;
  staged: number;
  untracked: number;
  ahead: number;
  behind: number;
  stashes: number;
  lastCommit: string;
  remoteUrl: string; // HTTPS URL to the repo (GitHub, GitLab, etc.)
  /** True while a merge is in progress (i.e. .git/MERGE_HEAD exists). */
  mergeInProgress: boolean;
  /** Best-effort source-branch name parsed from .git/MERGE_MSG, or empty. */
  mergeFromBranch: string;
  /** True while a rebase is in progress (.git/rebase-apply or rebase-merge exists). */
  rebaseInProgress: boolean;
  /** Branch being rebased (parsed from .git/rebase-{apply,merge}/head-name). */
  rebaseHeadName: string;
  /** Short SHA of the commit being rebased onto, or its name if resolvable. */
  rebaseOnto: string;
  /** True while a `git cherry-pick` is mid-conflict (.git/CHERRY_PICK_HEAD). */
  cherryPickInProgress: boolean;
  /** True while a `git revert` is mid-conflict (.git/REVERT_HEAD). */
  revertInProgress: boolean;
  /** Paths git is reporting as conflicted (`UU`, `AA`, `DD`, `AU`, `UA`, etc.). */
  conflictedFiles: string[];
}
