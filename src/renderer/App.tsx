import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandBar } from './components/CommandBar';
import { TerminalPane } from './components/TerminalPane';
import { ShellPane } from './components/ShellPane';
import { ProfileEditor } from './components/ProfileEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { ResizeHandle } from './components/ResizeHandle';
import { FileExplorer } from './components/FileExplorer';
import { KanbanViewer } from './components/KanbanViewer';
import { ParallelAgentTerminal } from './components/ParallelAgentTerminal';
import { StatusBar } from './components/StatusBar';
import { GitChangesPanel } from './components/GitChangesPanel';
import { useKeyNav } from './components/KeyNav';
import { useDictation } from './components/Dictation';
import { Profile, AgentStatus, AppSettings, DEFAULT_SETTINGS, SidebarLayout, GitStatus, GitCommit, GitRef, GitCheckoutResult, GitCommitResult, GitOpResult, GitMergeResult, GitRebaseResult, GitCreatePrResult, GitStash, ExternalApp, FileEntry, ProfileMemoryMap, OrdnaTaskEnvelope, ParallelAgent, EditMenuAction, EditMenuState } from '../shared/types';
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
      createTerminal: (profileId: string, profile: Profile) => Promise<void>;
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
      openExternal: (command: string, folderPath: string) => Promise<void>;
      createShellTerminal: (terminalId: string, cwd: string) => Promise<void>;
      onShellExited: (
        callback: (payload: { terminalId: string }) => void,
      ) => () => void;
      selectDirectory: () => Promise<string | null>;
      selectFile: () => Promise<string | null>;
      createTempDir: () => Promise<string>;
      loadSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<void>;
      onOpenSettings: (callback: () => void) => () => void;
      platform: string;
      getGitStatus: (cwd: string) => Promise<GitStatus>;
      ackTerminalData: (profileId: string, bytes: number) => void;
      gitFetch: (cwd: string) => Promise<boolean>;
      getGitChangedFiles: (cwd: string) => Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]>;
      getGitFileDiff: (cwd: string, filePath: string, staged?: boolean) => Promise<string>;
      getGitLog: (cwd: string, limit: number) => Promise<GitCommit[]>;
      getGitRefs: (cwd: string) => Promise<GitRef[]>;
      gitCheckoutCommit: (cwd: string, sha: string) => Promise<GitCheckoutResult>;
      gitStage: (cwd: string, filePath: string) => Promise<boolean>;
      gitUnstage: (cwd: string, filePath: string) => Promise<boolean>;
      gitCommit: (cwd: string, subject: string, description: string) => Promise<GitCommitResult>;
      gitPush: (cwd: string) => Promise<GitOpResult>;
      gitPull: (cwd: string) => Promise<GitOpResult>;
      gitMerge: (cwd: string, sourceRef: string) => Promise<GitMergeResult>;
      gitMergeAbort: (cwd: string) => Promise<GitOpResult>;
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
      readFile: (filePath: string) => Promise<string | null>;
      saveFile: (filePath: string, content: string) => Promise<boolean>;
      deleteFile: (targetPath: string) => Promise<boolean>;
      renameFile: (oldPath: string, newPath: string) => Promise<boolean>;
      copyFile: (srcPath: string, destPath: string) => Promise<boolean>;
      createDir: (dirPath: string) => Promise<boolean>;
      createFile: (filePath: string) => Promise<boolean>;
      saveFileAs: (content: string, defaultPath: string) => Promise<string | null>;
      resolveFilePath: (workingDir: string, token: string) => Promise<string | null>;
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
      destroyParallelAgent: (id: string) => Promise<void>;
      listParallelAgents: (profileId?: string) => Promise<ParallelAgent[]>;
      finishParallelAgent: (id: string) => Promise<void>;
      onParallelAgentChange: (callback: (agent: ParallelAgent) => void) => () => void;
      onParallelAgentExited: (callback: (agent: ParallelAgent) => void) => () => void;
      setEditMenuState: (state: EditMenuState) => void;
      onEditMenuAction: (callback: (action: EditMenuAction) => void) => () => void;
    };
  }
}

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
  const [iconRevision, setIconRevision] = useState(0);
  const [shellOpenSet, setShellOpenSet] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [layout, setLayout] = useState<SidebarLayout>({ items: [], folders: [] });
  // Overlay visibility is per-VIEW so each parallel agent has its own state
  // independent of the parent profile and its siblings. View key is the
  // profileId for the parent view, or `${profileId}|${parallelId}` for a
  // parallel agent's view. The parent view's key is just `${profileId}` so
  // existing behavior (open Files on profile A, switch to B, switch back —
  // Files reappears) is preserved.
  const [filesViews, setFilesViews] = useState<Set<string>>(new Set());
  // kanbanViews = views whose Kanban tab is currently SHOWN (overlay active).
  // kanbanRunning = views whose KanbanViewer is mounted and whose Ordna
  // instance is alive in the background. kanbanRunning ⊇ kanbanViews.
  // Closing the Kanban tab only removes from kanbanViews, so re-opening
  // shows the existing Ordna view without reloading.
  const [kanbanViews, setKanbanViews] = useState<Set<string>>(new Set());
  const [kanbanRunning, setKanbanRunning] = useState<Set<string>>(new Set());
  // Parallel agents (Kanban-spawned worktree agents). Keyed by parallel agent id.
  const [parallelAgents, setParallelAgents] = useState<Map<string, ParallelAgent>>(new Map());
  // Which parallel-agent the user is viewing (PTY id `parallel:<id>`); null = parent profile
  const [selectedParallelId, setSelectedParallelId] = useState<string | null>(null);
  // Track parallel agents whose `completed` state has been seen by the user (for soft-delete)
  const inspectedParallelRef = useRef<Set<string>>(new Set());
  const [changesVisible, setChangesVisible] = useState(false);
  const [changesWidth, setChangesWidth] = useState(50); // percent of agent pane
  const [gitPanelTab, setGitPanelTab] = useState<'changes' | 'tree' | 'branches'>('changes');
  const [focusedPane, setFocusedPane] = useState<{ pane: 'agent' | 'shell'; shellIndex: number }>({ pane: 'agent', shellIndex: 0 });
  const shellCountRef = useRef(1);
  const profileMemoryRef = useRef<ProfileMemoryMap>({});
  const [filesCloseRequested, setFilesCloseRequested] = useState(false);
  // When a file path is clicked in the agent terminal, we ensure Files is
  // visible and stash the resolved path here. FileExplorer reacts to changes
  // by opening the file in a tab. Stamped with a counter so re-clicks of the
  // same path still trigger the effect.
  const [pendingFileOpen, setPendingFileOpen] = useState<{ path: string; nonce: number } | null>(null);

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

  // Derived: visible state for the currently-active view
  const filesVisible = activeViewKey ? filesViews.has(activeViewKey) : false;
  const kanbanVisible = activeViewKey ? kanbanViews.has(activeViewKey) : false;
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

  // Cmd/Ctrl + C/V/X/A in HTML text fields. We can't add the standard Edit
  // menu role items because their OS-level accelerators (on macOS) intercept
  // Cmd+C from xterm.js terminals. Without the menu items, those shortcuts
  // also stop reaching plain HTML inputs/textareas — so we wire them up here
  // at the renderer level for inputs only. xterm.js terminals are skipped:
  // they have their own handler in makeTerminalKeyHandler.
  useEffect(() => {
    const isTextField = (el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement => {
      if (!el || !(el instanceof HTMLElement)) return false;
      // Skip xterm.js — its hidden helper textarea has class `xterm-helper-textarea`
      // and any DOM inside `.xterm` belongs to it.
      if (el.classList.contains('xterm-helper-textarea')) return false;
      if (el.closest('.xterm')) return false;
      // Skip CodeMirror (contentEditable). CodeMirror has its own keymap that
      // owns Cmd+C/V/X — we must NOT preventDefault on it.
      if (el.closest('.cm-editor')) return false;
      const tag = el.tagName;
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        // Editable input types only (skip checkbox, radio, button, etc.)
        return ['text', 'search', 'url', 'email', 'password', 'tel', 'number', ''].includes(type);
      }
      if (tag === 'TEXTAREA') return true;
      // Other contentEditable surfaces (rich text editors, etc.) — let the
      // browser handle Cmd+C/V/X natively rather than reimplementing here.
      return false;
    };

    const insertAtCursor = (el: HTMLInputElement | HTMLTextAreaElement, text: string): void => {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      const next = before + text + after;
      // Use the property setter that React sees as a real input event
      const setter = Object.getOwnPropertyDescriptor(
        el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      const cursor = start + text.length;
      el.setSelectionRange(cursor, cursor);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (!['c', 'v', 'x', 'a', 'z'].includes(key)) return;
      const target = e.target;

      // Cmd+C anywhere outside text fields, xterm and CodeMirror — copy
      // the current window selection if any. Without this, selecting text
      // in the rendered README (or any other read-only DOM) and pressing
      // Cmd+C is a no-op, because there's no Edit-menu Copy role to
      // intercept the key (we omitted it deliberately to keep terminal
      // selection working).
      if (key === 'c' && !isTextField(target)) {
        if (target instanceof HTMLElement && (target.closest('.xterm') || target.closest('.cm-editor'))) {
          return;
        }
        const sel = window.getSelection();
        const selected = sel?.toString() ?? '';
        if (selected) {
          e.preventDefault();
          navigator.clipboard.writeText(selected).catch((): void => undefined);
        }
        return;
      }

      if (!isTextField(target)) return;
      const el = target as HTMLInputElement | HTMLTextAreaElement;

      // Number inputs don't support selectionStart/end (the spec excludes them).
      // Reading those throws InvalidStateError in Chromium, so we route number
      // inputs through full-value operations.
      const isNumber = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'number';

      const setValue = (next: string): void => {
        const setter = Object.getOwnPropertyDescriptor(
          el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        if (setter) setter.call(el, next);
        else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };

      if (key === 'z') {
        // Undo / redo. The browser maintains an input-level undo stack —
        // execCommand still drives it on inputs/textareas in Chromium even
        // though the API is deprecated. CodeMirror is excluded by isTextField.
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'redo' : 'undo');
        return;
      }

      if (key === 'a') {
        e.preventDefault();
        try {
          el.select();
        } catch { /* number inputs throw on .select() too */ }
        return;
      }

      // Selection range — gracefully handle number inputs (no selection API)
      let start = 0;
      let end = el.value.length;
      let selected = '';
      try {
        const s = el.selectionStart;
        const en = el.selectionEnd;
        if (s !== null && en !== null && !isNumber) {
          start = s;
          end = en;
        }
      } catch { /* number inputs */ }
      selected = el.value.slice(start, end);

      if (key === 'c') {
        // For number inputs (or when nothing is selected), copy the whole value
        const text = selected || (isNumber ? el.value : '');
        if (!text) return;
        e.preventDefault();
        navigator.clipboard.writeText(text).catch((): void => undefined);
        return;
      }

      if (key === 'x') {
        const text = selected || (isNumber ? el.value : '');
        if (!text) return;
        e.preventDefault();
        navigator.clipboard.writeText(text).catch((): void => undefined);
        if (isNumber) setValue('');
        else insertAtCursor(el, '');
        return;
      }

      if (key === 'v') {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) return;
            if (isNumber) {
              // Replace the number value (no insertion-point support)
              setValue(text);
            } else {
              insertAtCursor(el, text);
            }
          })
          .catch((): void => undefined);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Load settings and profiles on mount
  useEffect(() => {
    window.api.loadSettings().then((loaded) => {
      setSettings(loaded);
      setSidebarWidth(loaded.sidebarWidth);
      applyTheme(loaded.baseHue, loaded.darkness, loaded.textLightness, loaded.profileFontSize, {
        intensity: loaded.flameIntensity,
        spread: loaded.flameSpread,
        length: loaded.flameLength,
        speed: loaded.flameSpeed,
      }, loaded.profileFontWeight);
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

    Promise.all([window.api.getProfiles(), window.api.loadSettings()]).then(([loadedProfiles, loadedSettings]) => {
      setProfiles(loadedProfiles);
      if (loadedProfiles.length > 0) {
        const lastId = loadedSettings.lastActiveProfileId;
        const restored = lastId && loadedProfiles.some((p) => p.id === lastId);
        setActiveProfileId(restored ? lastId : loadedProfiles[0].id);
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

    // Handle notification click — switch to the profile (and parallel sub-
    // agent if any) that needs attention.
    const unsubActivate = window.api.onActivateProfileRequest(({ profileId, parallelAgentId }) => {
      stoppedRef.current.delete(profileId);
      setActiveProfileId(profileId);
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
            // never touches the parent repo. The manager returns the resolved
            // parent path, so we don't have to expand `~` in the renderer.
            const message = buildOrdnaTaskMessage(payload, {
              worktreePath: res.worktreePath,
              branch: res.branch,
              parentRepoPath: res.parentRepoPath,
            });
            pendingParallelMessagesRef.current.set(res.id, message);
            setParallelAgents((prev) => new Map(prev).set(res.id, res));
            // Auto-select so the user immediately sees the new sub-agent
            setSelectedParallelId(res.id);

            // Schedule auto-submit unless the user disabled it. We wait long
            // enough for the agent CLI (claude/codex/gemini) to print its
            // prompt — pasting too early can land in a startup banner.
            if (settingsRef.current.parallelAgentAutoRun !== false) {
              const timer = setTimeout(() => {
                submitParallelTask(res.id);
              }, 2500);
              autoRunTimersRef.current.set(res.id, timer);
            }
          });
        return;
      }

      // Close every overlay for the receiving profile's parent view so the
      // agent terminal becomes visible. Files uses the close-requested dance
      // to respect unsaved changes. Parallel sub-views are untouched.
      const dropParent = (prev: Set<string>): Set<string> => {
        if (!prev.has(target)) return prev;
        const next = new Set(prev);
        next.delete(target);
        return next;
      };
      setKanbanViews(dropParent);
      setFilesCloseRequested(true);
      // Drop back to the parent view so the user immediately sees the agent
      // they just dispatched to.
      setSelectedParallelId(null);
      setEditorOpen(false);
      setSettingsOpen(false);
      setFocusedPane({ pane: 'agent', shellIndex: 0 });

      const message = buildOrdnaTaskMessage(payload);
      window.api.sendInput(target, message + '\r');
    });

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

  // File-token clicks from the agent terminal — open Files pane in the
  // current view and stash the resolved path for FileExplorer to consume.
  // Other overlays (README/Kanban) get hidden so the file is actually visible.
  useEffect(() => {
    const handleOpenFile = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (!detail?.path) return;
      if (activeViewKey) {
        const key = activeViewKey;
        setFilesViews((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        setKanbanViews((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
      setPendingFileOpen({ path: detail.path, nonce: Date.now() });
    };
    window.addEventListener('open-file-in-explorer', handleOpenFile);
    return () => window.removeEventListener('open-file-in-explorer', handleOpenFile);
  }, [activeViewKey]);

  // Mirror profiles into a ref so the once-mounted onOrdnaTask listener can
  // look up profile.parallelAgentEnabled at hook-fire time.
  const profilesRef = useRef<Profile[]>([]);
  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

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

  const initializeProfile = useCallback(
    (profileId: string) => {
      if (initialized.has(profileId)) return;
      const profile = profiles.find((p) => p.id === profileId);
      if (profile) {
        setInitialized((prev) => new Set(prev).add(profileId));
      }
    },
    [profiles, initialized],
  );

  const handleSelectProfile = useCallback(
    (profileId: string) => {
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
    [initializeProfile],
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
    let updated: Profile[];
    const existing = profiles.find((p) => p.id === saved.id);
    if (existing) {
      updated = profiles.map((p) => (p.id === saved.id ? saved : p));
    } else {
      updated = [...profiles, saved];
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

  const handleSidebarResize = useCallback(
    (delta: number) => {
      setSidebarWidth((w) => {
        const next = Math.max(160, Math.min(500, w + delta));
        savePaneSizes({ sidebarWidth: next });
        return next;
      });
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
  const shellOpenedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (activeProfileId && shellOpenSet.has(activeProfileId)) {
      shellOpenedRef.current.add(activeProfileId);
    }
  }, [activeProfileId, shellOpenSet]);

  // Build ordered list of profile IDs for keyboard navigation
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
  const selectTab = useCallback((tab: 'agent' | 'files' | 'kanban') => {
    const key = activeViewKey;
    if (!key) return;
    if (tab === 'agent') {
      if (filesViews.has(key)) setFilesCloseRequested(true);
      setKanbanViews((prev) => removeFromSet(prev, key));
      return;
    }
    if (tab === 'files') {
      setFilesViews((prev) => ensureInSet(prev, key));
      setKanbanViews((prev) => removeFromSet(prev, key));
      return;
    }
    // tab === 'kanban'
    setKanbanViews((prev) => ensureInSet(prev, key));
    setKanbanRunning((prev) => ensureInSet(prev, key));
    if (filesViews.has(key)) setFilesCloseRequested(true);
  }, [activeViewKey, filesViews]);

  // Keyboard-nav targets — same-tab presses are no-ops, so ⌘1 from
  // Files goes to Agent and from Agent stays on Agent.
  const goAgent = useCallback(() => selectTab('agent'), [selectTab]);
  const goFiles = useCallback(() => selectTab('files'), [selectTab]);
  const goKanban = useCallback(() => selectTab('kanban'), [selectTab]);

  // Derived current tab — the Agent tab is the default whenever no
  // overlay is active.
  const activeTab: 'agent' | 'files' | 'kanban' = filesVisible ? 'files'
    : kanbanVisible ? 'kanban'
    : 'agent';
  const shellOpen = activeProfileId ? shellOpenSet.has(activeProfileId) : false;

  const toggleShell = useCallback(() => {
    if (!activeProfileId) return;
    setShellOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(activeProfileId)) next.delete(activeProfileId);
      else next.add(activeProfileId);
      return next;
    });
  }, [activeProfileId]);

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
    if (activeProfile) window.api.openInFinder(activeProfile.workingDirectory);
  }, [activeProfile]);

  const navActions = useMemo(() => {
    // Keep this in sync with CommandBar.tsx button order:
    // Tabs: Agent(0) Files(1) Kanban(2) | Terminal(3) | Mic | Folder(4) | external(5+)
    const actions = [goAgent, goFiles, goKanban, toggleShell, openFolder];
    const labels = ['Agent', 'Files', 'Kanban', 'Terminal', 'Folder'];
    for (const app of settings.externalApps || []) {
      const cmd = app.command;
      const wd = activeProfile?.workingDirectory || '';
      actions.push(() => window.api.openExternal(cmd, wd));
      labels.push(app.name);
    }
    return { actions, labels };
  }, [goAgent, goFiles, goKanban, toggleShell, openFolder, settings.externalApps, activeProfile]);

  // Keyboard profile navigation — only updates visual selection.
  // The auto-init effect (2s debounce) handles terminal initialization.
  const navSelectProfile = useCallback((profileId: string) => {
    stoppedRef.current.delete(profileId);
    setActiveProfileId(profileId);
    window.api.setActiveProfile(profileId);
    setHasUpdates((prev) => {
      if (!prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.delete(profileId);
      return next;
    });
  }, []);

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
      const shellOpen = shellOpenSet.has(activeProfileId);
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
      const shellOpen = shellOpenSet.has(activeProfileId);
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
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px auto 1fr` }}>
      <div className="titlebar">
        {activeProfile && (
          <>
            <span className="titlebar-name">{activeProfile.name}</span>
            <span className="titlebar-path" title={activeProfile.workingDirectory}>
              {activeProfile.workingDirectory.replace(/^\/Users\/[^/]+/, '~')}
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
        navActive={navActive}
        onLayoutChange={handleLayoutChange}
        onSelectProfile={handleSelectProfile}
        onEditProfile={handleEditProfile}
        onAddProfile={handleAddProfile}
        onStopProfile={handleStopProfile}
        onReloadProfile={handleReloadProfile}
        initialized={initialized}
        showAgentBadge={settings.showAgentBadge !== false}
        parallelAgents={[...parallelAgents.values()]}
        selectedParallelId={selectedParallelId}
        onSelectParallel={(id) => setSelectedParallelId(id)}
        onRunParallel={(id) => submitParallelTask(id)}
        onStopParallel={(id) => {
          cancelAutoRun(id);
          window.api.destroyParallelAgent(id).catch((): void => undefined);
        }}
      />
      <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
      <div className="main-area">
        <CommandBar
          profile={activeProfile}
          shellOpen={shellOpen}
          activeTab={activeTab}
          onSelectTab={selectTab}
          onToggleShell={toggleShell}
          externalApps={settings.externalApps || []}
          navActive={navActive}
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
            className="main-content-top"
            style={
              shellOpen
                ? { height: `${agentPercent}%`, display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0, overflow: 'hidden' }
                : { flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0, overflow: 'hidden' }
            }
          >
            {filesVisible && activeProfile && (
              <FileExplorer
                workingDirectory={activeViewCwd || activeProfile.workingDirectory}
                closeRequested={filesCloseRequested}
                onCloseHandled={(proceed) => {
                  setFilesCloseRequested(false);
                  if (proceed && activeViewKey) {
                    setFilesViews((prev) => {
                      if (!prev.has(activeViewKey)) return prev;
                      const next = new Set(prev);
                      next.delete(activeViewKey);
                      return next;
                    });
                  }
                }}
                pendingOpenPath={pendingFileOpen}
                onPendingOpenHandled={() => setPendingFileOpen(null)}
              />
            )}
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
            {/* Mount one ParallelAgentTerminal per parallel agent so each PTY's
                xterm.js stays alive and switching between them is just CSS. */}
            {[...parallelAgents.values()].map((sa) => (
              <ParallelAgentTerminal
                key={sa.id}
                agent={sa}
                settings={settings}
                hidden={!(selectedParallelId === sa.id && activeProfileId === sa.profileId && !filesVisible && !kanbanVisible)}
              />
            ))}
            <TerminalPane
              profiles={profiles}
              activeProfileId={activeProfileId}
              initialized={initialized}
              shellOpen={shellOpen}
              hidden={filesVisible || kanbanVisible || selectedParallelId !== null}
              settings={settings}
              focusedPane={focusedPane}
              navActive={navActive}
            />
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
            {profiles.map((p) => {
              const isVisible = shellOpen && p.id === activeProfileId;
              const wasOpened = shellOpenedRef.current.has(p.id);
              if (!wasOpened && !isVisible) return null;
              return (
                <div
                  key={p.id}
                  style={{ display: isVisible ? 'block' : 'none', width: '100%', height: '100%' }}
                >
                  <ShellPane
                    profileId={p.id}
                    workingDirectory={p.workingDirectory}
                    hidden={!isVisible}
                    settings={settings}
                    onAllClosed={() => {
                      if (!activeProfileId) return;
                      setShellOpenSet((prev) => {
                        const next = new Set(prev);
                        next.delete(activeProfileId);
                        return next;
                      });
                      setFocusedPane({ pane: 'agent', shellIndex: 0 });
                    }}
                    focused={isVisible && focusedPane.pane === 'shell'}
                    focusedIndex={focusedPane.shellIndex}
                    navActive={navActive && isVisible}
                    navFocusedPane={focusedPane}
                    onShellCountChange={(count) => {
                      if (p.id === activeProfileId) shellCountRef.current = count;
                      if (count > 0) {
                        const memory = { ...profileMemoryRef.current };
                        if (!memory[p.id]) memory[p.id] = { shellOpen: true, shellCount: 1 };
                        memory[p.id].shellCount = count;
                        profileMemoryRef.current = memory;
                        window.api.saveProfileMemory(memory);
                      }
                    }}
                    initialShellCount={profileMemoryRef.current[p.id]?.shellCount || 1}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {changesVisible && activeProfile && (
          <GitChangesPanel
            workingDirectory={activeProfile.workingDirectory}
            widthPercent={changesWidth}
            onWidthChange={setChangesWidth}
            onClose={() => setChangesVisible(false)}
            activeTab={gitPanelTab}
            onTabChange={setGitPanelTab}
          />
        )}
      </div>
      <StatusBar
        profile={activeProfile}
        onToggleChanges={() => {
          setGitPanelTab('changes');
          setChangesVisible((v) => !v);
        }}
        onBranchClick={() => {
          setGitPanelTab('tree');
          setChangesVisible(true);
        }}
      />
      {editorOpen && (
        <ProfileEditor
          profile={editingProfile}
          agents={settings.agents || []}
          onSave={handleSaveProfile}
          onDelete={handleDeleteProfile}
          onClose={() => setEditorOpen(false)}
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
    </div>
  );
}
