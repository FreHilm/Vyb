import { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandBar } from './components/CommandBar';
import { TerminalPane } from './components/TerminalPane';
import { ProfileEditor } from './components/ProfileEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { ResizeHandle } from './components/ResizeHandle';
import { ReadmeViewer } from './components/ReadmeViewer';
import { FileExplorer } from './components/FileExplorer';
import { StatusBar } from './components/StatusBar';
import { Profile, AgentStatus, AppSettings, DEFAULT_SETTINGS, SidebarLayout, GitStatus, ExternalApp, FileEntry } from '../shared/types';
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
      listDir: (dirPath: string) => Promise<FileEntry[]>;
      readFile: (filePath: string) => Promise<string | null>;
      saveFile: (filePath: string, content: string) => Promise<boolean>;
      exportBackup: () => Promise<string | null>;
      importBackup: () => Promise<boolean>;
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
      applyTheme(loaded.baseHue, loaded.darkness, loaded.textLightness, loaded.profileFontSize);
    });

    window.api.loadLayout().then(setLayout);

    window.api.getProfiles().then((loadedProfiles) => {
      setProfiles(loadedProfiles);
      if (loadedProfiles.length > 0) {
        setActiveProfileId(loadedProfiles[0].id);
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
    applyTheme(settings.baseHue, settings.darkness, settings.textLightness, settings.profileFontSize);
  }, [settings]);

  // Sync active profile to main process for notification suppression
  useEffect(() => {
    window.api.setActiveProfile(activeProfileId);
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

  useEffect(() => {
    if (activeProfileId && profiles.length > 0) {
      initializeProfile(activeProfileId);
    }
  }, [activeProfileId, profiles, initializeProfile]);

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
          onToggleShell={() => {
            if (!activeProfileId) return;
            setShellOpenSet((prev) => {
              const next = new Set(prev);
              if (next.has(activeProfileId)) next.delete(activeProfileId);
              else next.add(activeProfileId);
              return next;
            });
          }}
          onToggleReadme={() => {
            if (filesVisible) {
              // Request close of file explorer (may show dialog)
              setFilesCloseRequested(true);
            }
            setReadmeVisible((v) => !v);
          }}
          filesVisible={filesVisible}
          onToggleFiles={() => {
            if (filesVisible) {
              // Request close — FileExplorer will handle unsaved check
              setFilesCloseRequested(true);
            } else {
              setFilesVisible(true);
              setReadmeVisible(false);
            }
          }}
          externalApps={settings.externalApps || []}
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
            }}
            settings={settings}
            onSplitChange={handleTerminalSplitChange}
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
