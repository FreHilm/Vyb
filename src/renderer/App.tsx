import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandBar } from './components/CommandBar';
import { TerminalPane } from './components/TerminalPane';
import { ProfileEditor } from './components/ProfileEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { ResizeHandle } from './components/ResizeHandle';
import { ReadmeViewer } from './components/ReadmeViewer';
import { FileExplorer } from './components/FileExplorer';
import { StatusBar } from './components/StatusBar';
import { useKeyNav } from './components/KeyNav';
import { useDictation } from './components/Dictation';
import { Profile, AgentStatus, AppSettings, DEFAULT_SETTINGS, SidebarLayout, GitStatus, ExternalApp, FileEntry, ProfileMemoryMap } from '../shared/types';
import { applyTheme } from './theme';
import './App.css';

declare global {
  interface Window {
    api: {
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
      serializeTerminal: (profileId: string) => Promise<string | null>;
      gitFetch: (cwd: string) => Promise<boolean>;
      listDir: (dirPath: string) => Promise<FileEntry[]>;
      readFile: (filePath: string) => Promise<string | null>;
      saveFile: (filePath: string, content: string) => Promise<boolean>;
      exportBackup: () => Promise<string | null>;
      importBackup: () => Promise<boolean>;
      transcribeAudio: (audioBase64: string, lang: string) => Promise<string>;
      loadProfileMemory: () => Promise<ProfileMemoryMap>;
      saveProfileMemory: (memory: ProfileMemoryMap) => Promise<void>;
      loadScrollback: (profileId: string) => Promise<string | null>;
      loadReadme: (workingDirectory: string) => Promise<string | null>;
      setActiveProfile: (profileId: string | null) => void;
      generateIcon: (profileId: string, projectName: string) => Promise<string | null>;
      loadLayout: () => Promise<SidebarLayout>;
      saveLayout: (layout: SidebarLayout) => Promise<void>;
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
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [iconRevision, setIconRevision] = useState(0);
  const [shellOpenSet, setShellOpenSet] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [layout, setLayout] = useState<SidebarLayout>({ items: [], folders: [] });
  const [readmeVisible, setReadmeVisible] = useState(false);
  const [focusedPane, setFocusedPane] = useState<{ pane: 'agent' | 'shell'; shellIndex: number }>({ pane: 'agent', shellIndex: 0 });
  const shellCountRef = useRef(1);
  const profileMemoryRef = useRef<ProfileMemoryMap>({});
  const [filesVisible, setFilesVisible] = useState(false);
  const [filesCloseRequested, setFilesCloseRequested] = useState(false);
  const [hasUpdates, setHasUpdates] = useState<Set<string>>(new Set());
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState('');

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

    return () => {
      unsubStatus();
      unsubSettings();
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

  const handleDeleteProfile = async (profileId: string) => {
    const updated = profiles.filter((p) => p.id !== profileId);
    await window.api.saveProfiles(updated);
    setProfiles(updated);
    setEditorOpen(false);

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

  // Command bar action builders
  const toggleReadme = useCallback(() => {
    if (filesVisible) setFilesCloseRequested(true);
    setReadmeVisible((v) => !v);
  }, [filesVisible]);

  const toggleFiles = useCallback(() => {
    if (filesVisible) {
      setFilesCloseRequested(true);
    } else {
      setFilesVisible(true);
      setReadmeVisible(false);
    }
  }, [filesVisible]);

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
    const actions = [toggleReadme, toggleFiles, toggleShell, openFolder];
    const labels = ['README', 'Files', 'Terminal', 'Folder'];
    for (const app of settings.externalApps || []) {
      const cmd = app.command;
      const wd = activeProfile?.workingDirectory || '';
      actions.push(() => window.api.openExternal(cmd, wd));
      labels.push(app.name);
    }
    return { actions, labels };
  }, [toggleReadme, toggleFiles, toggleShell, openFolder, settings.externalApps, activeProfile]);

  // Keyboard profile navigation — only updates visual selection.
  // The auto-init effect (2s debounce) handles terminal initialization.
  const navSelectProfile = useCallback((profileId: string) => {
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
      />
      <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
      <div className="main-area">
        <CommandBar
          profile={activeProfile}
          shellOpen={activeProfileId ? shellOpenSet.has(activeProfileId) : false}
          readmeVisible={readmeVisible}
          onToggleShell={toggleShell}
          onToggleReadme={toggleReadme}
          filesVisible={filesVisible}
          onToggleFiles={toggleFiles}
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
              if (proceed) {
                setFilesVisible(false);
              }
            }}
          />
        )}
        <div style={{ display: readmeVisible || filesVisible ? 'none' : 'contents' }}>
          <TerminalPane
            profiles={profiles}
            activeProfileId={activeProfileId}
            initialized={initialized}
            shellOpen={activeProfileId ? shellOpenSet.has(activeProfileId) : false}
            hidden={readmeVisible || filesVisible}
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
      </div>
      <StatusBar profile={activeProfile} />
      {editorOpen && (
        <ProfileEditor
          profile={editingProfile}
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
