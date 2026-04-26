import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandBar } from './components/CommandBar';
import { TerminalPane } from './components/TerminalPane';
import { ProfileEditor } from './components/ProfileEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { ResizeHandle } from './components/ResizeHandle';
import { ReadmeViewer } from './components/ReadmeViewer';
import { FileExplorer } from './components/FileExplorer';
import { KanbanViewer } from './components/KanbanViewer';
import { ParallelAgentTerminal } from './components/ParallelAgentTerminal';
import { StatusBar } from './components/StatusBar';
import { GitChangesPanel } from './components/GitChangesPanel';
import { useKeyNav } from './components/KeyNav';
import { useDictation } from './components/Dictation';
import { Profile, AgentStatus, AppSettings, DEFAULT_SETTINGS, SidebarLayout, GitStatus, ExternalApp, FileEntry, ProfileMemoryMap, OrdnaTaskEnvelope, ParallelAgent } from '../shared/types';
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
        callback: (payload: { profileId: string; data: string }) => void,
      ) => () => void;
      onStatusChange: (
        callback: (payload: { profileId: string; status: string }) => void,
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
      loadSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<void>;
      onOpenSettings: (callback: () => void) => () => void;
      platform: string;
      getGitStatus: (cwd: string) => Promise<GitStatus>;
      ackTerminalData: (profileId: string, bytes: number) => void;
      gitFetch: (cwd: string) => Promise<boolean>;
      getGitChangedFiles: (cwd: string) => Promise<{ path: string; added: number; deleted: number; status: string; staged: boolean }[]>;
      getGitFileDiff: (cwd: string, filePath: string) => Promise<string>;
      listDir: (dirPath: string) => Promise<FileEntry[]>;
      readFile: (filePath: string) => Promise<string | null>;
      saveFile: (filePath: string, content: string) => Promise<boolean>;
      deleteFile: (targetPath: string) => Promise<boolean>;
      renameFile: (oldPath: string, newPath: string) => Promise<boolean>;
      copyFile: (srcPath: string, destPath: string) => Promise<boolean>;
      createDir: (dirPath: string) => Promise<boolean>;
      createFile: (filePath: string) => Promise<boolean>;
      saveFileAs: (content: string, defaultPath: string) => Promise<string | null>;
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
        profileId: string,
        mode: 'web' | 'tui',
      ) => Promise<{ webUrl?: string; tuiPtyId?: string; error?: string }>;
      stopOrdna: (profileId: string) => Promise<void>;
      getOrdnaInstance: (
        profileId: string,
      ) => Promise<{ mode: 'web' | 'tui'; webUrl: string | null; tuiPtyId: string | null } | null>;
      getOrdnaHookInfo: () => Promise<{ url: string; port: number }>;
      onOrdnaTask: (callback: (envelope: OrdnaTaskEnvelope) => void) => () => void;
      onOrdnaExited: (callback: (payload: { profileId: string }) => void) => () => void;
      spawnParallelAgent: (
        profileId: string,
        task: { id: string; title: string; filePath?: string },
      ) => Promise<ParallelAgent | { error: string }>;
      destroyParallelAgent: (id: string) => Promise<void>;
      listParallelAgents: (profileId?: string) => Promise<ParallelAgent[]>;
      finishParallelAgent: (id: string) => Promise<void>;
      onParallelAgentChange: (callback: (agent: ParallelAgent) => void) => () => void;
      onParallelAgentExited: (callback: (agent: ParallelAgent) => void) => () => void;
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
  // Overlay visibility is per-profile so switching profiles preserves the open tab
  const [readmeProfiles, setReadmeProfiles] = useState<Set<string>>(new Set());
  const [filesProfiles, setFilesProfiles] = useState<Set<string>>(new Set());
  // kanbanProfiles = profiles whose Kanban tab is currently SHOWN (overlay
  // active). kanbanRunning = profiles whose KanbanViewer is mounted and whose
  // Ordna instance is alive in the background. kanbanRunning ⊇ kanbanProfiles.
  // Closing the Kanban tab only removes from kanbanProfiles, so re-opening
  // shows the existing Ordna view without reloading.
  const [kanbanProfiles, setKanbanProfiles] = useState<Set<string>>(new Set());
  const [kanbanRunning, setKanbanRunning] = useState<Set<string>>(new Set());
  // Parallel agents (Kanban-spawned worktree agents). Keyed by parallel agent id.
  const [parallelAgents, setParallelAgents] = useState<Map<string, ParallelAgent>>(new Map());
  // Which parallel-agent the user is viewing (PTY id `parallel:<id>`); null = parent profile
  const [selectedParallelId, setSelectedParallelId] = useState<string | null>(null);
  // Track parallel agents whose `completed` state has been seen by the user (for soft-delete)
  const inspectedParallelRef = useRef<Set<string>>(new Set());
  const [hasReadme, setHasReadme] = useState(false);
  const [changesVisible, setChangesVisible] = useState(false);
  const [changesWidth, setChangesWidth] = useState(50); // percent of agent pane
  const [focusedPane, setFocusedPane] = useState<{ pane: 'agent' | 'shell'; shellIndex: number }>({ pane: 'agent', shellIndex: 0 });
  const shellCountRef = useRef(1);
  const profileMemoryRef = useRef<ProfileMemoryMap>({});
  const [filesCloseRequested, setFilesCloseRequested] = useState(false);

  // Derived: visible state for the currently-active profile
  const readmeVisible = activeProfileId ? readmeProfiles.has(activeProfileId) : false;
  const filesVisible = activeProfileId ? filesProfiles.has(activeProfileId) : false;
  const kanbanVisible = activeProfileId ? kanbanProfiles.has(activeProfileId) : false;
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
      });
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

    const unsubStatus = window.api.onStatusChange(({ profileId, status }) => {
      setStatuses((prev) => {
        const prevStatus = prev.get(profileId);
        const next = new Map(prev);
        next.set(profileId, status as AgentStatus);

        // Mark non-active profiles as having updates when task completes or needs input
        if (
          (status === 'ready' && prevStatus === 'working') ||
          (status === 'needs-input')
        ) {
          setHasUpdates((u) => {
            const updated = new Set(u);
            updated.add(profileId);
            return updated;
          });
        }

        return next;
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

      // Close every overlay for the receiving profile so the agent terminal
      // becomes visible. Files uses the close-requested dance to respect
      // unsaved changes.
      setReadmeProfiles((prev) => {
        if (!prev.has(target)) return prev;
        const next = new Set(prev);
        next.delete(target);
        return next;
      });
      setKanbanProfiles((prev) => {
        if (!prev.has(target)) return prev;
        const next = new Set(prev);
        next.delete(target);
        return next;
      });
      setFilesCloseRequested(true);
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
      // If the user was looking at this sub-agent, drop back to the parent profile
      setSelectedParallelId((curr) => (curr === agent.id ? null : curr));
    });

    // When an Ordna TUI process exits (e.g. user pressed `q`), close the
    // Kanban panel for that profile and unmount its viewer entirely.
    const unsubOrdnaExit = window.api.onOrdnaExited(({ profileId }) => {
      const drop = (prev: Set<string>): Set<string> => {
        if (!prev.has(profileId)) return prev;
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      };
      setKanbanProfiles(drop);
      setKanbanRunning(drop);
    });

    return () => {
      unsubStatus();
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
    });
  }, [settings]);

  // Sync active profile to main process for notification suppression + persist
  useEffect(() => {
    window.api.setActiveProfile(activeProfileId);
    if (activeProfileId) {
      window.api.saveSettings({ ...settings, lastActiveProfileId: activeProfileId });
    }
  }, [activeProfileId]);

  // Check if active profile has a README
  useEffect(() => {
    const profile = profiles.find((p) => p.id === activeProfileId);
    if (!profile) {
      setHasReadme(false);
      return;
    }
    window.api.loadReadme(profile.workingDirectory).then((md) => {
      setHasReadme(md !== null);
    });
  }, [activeProfileId, profiles]);

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
    // Stop the Ordna instance for this profile if any (web server / TUI PTY)
    window.api.stopOrdna(profileId).catch((): void => undefined);
    // Close any shell terminals for this profile
    setShellOpenSet((prev) => {
      if (!prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.delete(profileId);
      return next;
    });
    // Drop Kanban panel and viewer so the user starts clean on reload
    const drop = (prev: Set<string>): Set<string> => {
      if (!prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.delete(profileId);
      return next;
    };
    setKanbanProfiles(drop);
    setKanbanRunning(drop);
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

    // Drop overlay state for the removed profile
    const drop = (prev: Set<string>): Set<string> => {
      if (!prev.has(profileId)) return prev;
      const next = new Set(prev);
      next.delete(profileId);
      return next;
    };
    setReadmeProfiles(drop);
    setFilesProfiles(drop);
    setKanbanProfiles(drop);
    setKanbanRunning(drop);

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

  const handleTerminalSplitChange = useCallback(
    (percent: number) => {
      savePaneSizes({ terminalSplitPercent: percent });
    },
    [savePaneSizes],
  );

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

  // Command bar action builders
  const toggleReadme = useCallback(() => {
    const id = activeProfileId;
    if (!id) return;
    if (filesProfiles.has(id)) setFilesCloseRequested(true);
    setKanbanProfiles((prev) => removeFromSet(prev, id));
    setReadmeProfiles((prev) => toggleInSet(prev, id));
  }, [activeProfileId, filesProfiles]);

  const toggleFiles = useCallback(() => {
    const id = activeProfileId;
    if (!id) return;
    if (filesProfiles.has(id)) {
      setFilesCloseRequested(true);
    } else {
      setFilesProfiles((prev) => ensureInSet(prev, id));
      setReadmeProfiles((prev) => removeFromSet(prev, id));
      setKanbanProfiles((prev) => removeFromSet(prev, id));
    }
  }, [activeProfileId, filesProfiles]);

  const toggleKanban = useCallback(() => {
    const id = activeProfileId;
    if (!id) return;
    const opening = !kanbanProfiles.has(id);
    if (opening) {
      // Show the Kanban tab and ensure its viewer is mounted (idempotent —
      // existing Ordna instance is reused if already running).
      setKanbanProfiles((prev) => ensureInSet(prev, id));
      setKanbanRunning((prev) => ensureInSet(prev, id));
      if (filesProfiles.has(id)) setFilesCloseRequested(true);
      setReadmeProfiles((prev) => removeFromSet(prev, id));
    } else {
      // Hide-only: remove from the visible set but keep the viewer mounted in
      // the background so Ordna keeps running and re-opening is instant.
      setKanbanProfiles((prev) => removeFromSet(prev, id));
    }
  }, [activeProfileId, filesProfiles, kanbanProfiles]);

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
    const actions = [toggleReadme, toggleFiles, toggleShell, openFolder, toggleKanban];
    const labels = ['README', 'Files', 'Terminal', 'Folder', 'Kanban'];
    for (const app of settings.externalApps || []) {
      const cmd = app.command;
      const wd = activeProfile?.workingDirectory || '';
      actions.push(() => window.api.openExternal(cmd, wd));
      labels.push(app.name);
    }
    return { actions, labels };
  }, [toggleReadme, toggleFiles, toggleShell, openFolder, toggleKanban, settings.externalApps, activeProfile]);

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
          shellOpen={activeProfileId ? shellOpenSet.has(activeProfileId) : false}
          readmeVisible={readmeVisible}
          hasReadme={hasReadme}
          onToggleShell={toggleShell}
          onToggleReadme={toggleReadme}
          filesVisible={filesVisible}
          onToggleFiles={toggleFiles}
          kanbanVisible={kanbanVisible}
          onToggleKanban={toggleKanban}
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
        {readmeVisible && activeProfile && (
          <ReadmeViewer workingDirectory={activeProfile.workingDirectory} />
        )}
        {filesVisible && activeProfile && (
          <FileExplorer
            workingDirectory={activeProfile.workingDirectory}
            closeRequested={filesCloseRequested}
            onCloseHandled={(proceed) => {
              setFilesCloseRequested(false);
              if (proceed && activeProfileId) {
                setFilesProfiles((prev) => {
                  if (!prev.has(activeProfileId)) return prev;
                  const next = new Set(prev);
                  next.delete(activeProfileId);
                  return next;
                });
              }
            }}
          />
        )}
        {/* Mount one KanbanViewer per profile in kanbanRunning. The set persists
            across tab close — clicking the Kanban button to hide just removes
            the profile from kanbanProfiles, leaving the viewer mounted and
            Ordna alive in the background. The viewer is shown only when its
            profile is active AND the Kanban tab is the active overlay. */}
        {[...kanbanRunning].map((id) => {
          const p = profiles.find((pp) => pp.id === id);
          if (!p) return null;
          const visible = id === activeProfileId && kanbanProfiles.has(id);
          return (
            <KanbanViewer
              key={id}
              profile={p}
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
            hidden={!(selectedParallelId === sa.id && activeProfileId === sa.profileId && !readmeVisible && !filesVisible && !kanbanVisible)}
          />
        ))}
        <div style={{ display: readmeVisible || filesVisible || kanbanVisible || selectedParallelId !== null ? 'none' : 'contents' }}>
          <TerminalPane
            profiles={profiles}
            activeProfileId={activeProfileId}
            initialized={initialized}
            shellOpen={activeProfileId ? shellOpenSet.has(activeProfileId) : false}
            hidden={readmeVisible || filesVisible || kanbanVisible}
            onShellExited={() => {
              if (!activeProfileId) return;
              setShellOpenSet((prev) => {
                const next = new Set(prev);
                next.delete(activeProfileId);
                return next;
              });
              setFocusedPane({ pane: 'agent', shellIndex: 0 });
            }}
            settings={settings}
            onSplitChange={handleTerminalSplitChange}
            focusedPane={focusedPane}
            navActive={navActive}
            onShellCountChange={(pid, count) => {
              if (pid === activeProfileId) shellCountRef.current = count;
              // Save shell count to memory — but only if > 0 (0 means shells are being destroyed)
              if (count > 0) {
                const memory = { ...profileMemoryRef.current };
                if (!memory[pid]) memory[pid] = { shellOpen: true, shellCount: 1 };
                memory[pid].shellCount = count;
                profileMemoryRef.current = memory;
                window.api.saveProfileMemory(memory);
              }
            }}
            profileMemory={profileMemoryRef.current}
          />
        </div>
        {changesVisible && activeProfile && (
          <GitChangesPanel
            workingDirectory={activeProfile.workingDirectory}
            widthPercent={changesWidth}
            onWidthChange={setChangesWidth}
            onClose={() => setChangesVisible(false)}
          />
        )}
      </div>
      <StatusBar profile={activeProfile} onToggleChanges={() => setChangesVisible((v) => !v)} />
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
