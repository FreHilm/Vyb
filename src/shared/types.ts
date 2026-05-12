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
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  DIALOG_SELECT_FILE: 'dialog:selectFile',
  DIALOG_CREATE_TEMP_DIR: 'dialog:createTempDir',
  SETTINGS_LOAD: 'settings:load',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_OPEN_DIALOG: 'settings:openDialog',
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
  GIT_LOG: 'git:log',
  GIT_LIST_REFS: 'git:listRefs',
  GIT_CHECKOUT_COMMIT: 'git:checkoutCommit',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_DISCARD_FILE: 'git:discardFile',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_MERGE: 'git:merge',
  GIT_MERGE_ABORT: 'git:mergeAbort',
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
