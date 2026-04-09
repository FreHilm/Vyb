import { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { CommandBar } from './components/CommandBar';
import { TerminalPane } from './components/TerminalPane';
import { ProfileEditor } from './components/ProfileEditor';
import { SettingsDialog } from './components/SettingsDialog';
import { ResizeHandle } from './components/ResizeHandle';
import { Profile, AgentStatus, AppSettings, DEFAULT_SETTINGS, SidebarLayout } from '../shared/types';
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
      createShellTerminal: (terminalId: string, cwd: string) => Promise<void>;
      onShellExited: (
        callback: (payload: { terminalId: string }) => void,
      ) => () => void;
      selectDirectory: () => Promise<string | null>;
      selectFile: () => Promise<string | null>;
      loadSettings: () => Promise<AppSettings>;
      saveSettings: (settings: AppSettings) => Promise<void>;
      onOpenSettings: (callback: () => void) => () => void;
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
  const [shellOpenSet, setShellOpenSet] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [layout, setLayout] = useState<SidebarLayout>({ items: [], folders: [] });

  // Load settings and profiles on mount
  useEffect(() => {
    window.api.loadSettings().then((loaded) => {
      setSettings(loaded);
      setSidebarWidth(loaded.sidebarWidth);
      applyTheme(loaded.baseHue, loaded.darkness, loaded.profileFontSize);
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
        const next = new Map(prev);
        next.set(profileId, status as AgentStatus);
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
    applyTheme(settings.baseHue, settings.darkness, settings.profileFontSize);
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
            <span className="titlebar-path">{activeProfile.workingDirectory}</span>
          </>
        )}
      </div>
      <Sidebar
        profiles={profiles}
        activeProfileId={activeProfileId}
        statuses={statuses}
        layout={layout}
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
          onToggleShell={() => {
            if (!activeProfileId) return;
            setShellOpenSet((prev) => {
              const next = new Set(prev);
              if (next.has(activeProfileId)) next.delete(activeProfileId);
              else next.add(activeProfileId);
              return next;
            });
          }}
        />
        <TerminalPane
          profiles={profiles}
          activeProfileId={activeProfileId}
          initialized={initialized}
          shellOpen={activeProfileId ? shellOpenSet.has(activeProfileId) : false}
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
        />
      )}
    </div>
  );
}
