import { useState, useCallback, useEffect, useRef } from 'react';
import { ProfileItem } from './ProfileItem';
import {
  Profile,
  AgentStatus,
  SidebarLayout,
  SidebarFolder,
  SidebarItem,
  ParallelAgent,
} from '../../shared/types';

interface SidebarProps {
  profiles: Profile[];
  activeProfileId: string | null;
  statuses: Map<string, AgentStatus>;
  layout: SidebarLayout;
  iconRevision: number;
  hasUpdates: Set<string>;
  navActive: boolean;
  onLayoutChange: (layout: SidebarLayout) => void;
  onSelectProfile: (profileId: string) => void;
  onEditProfile: (profile: Profile) => void;
  onAddProfile: () => void;
  onStopProfile: (profileId: string) => void;
  onReloadProfile: (profileId: string) => void;
  initialized: Set<string>;
  showAgentBadge: boolean;
  parallelAgents: ParallelAgent[];
  selectedParallelId: string | null;
  onSelectParallel: (parallelId: string | null) => void;
  onRunParallel: (parallelId: string) => void;
  onStopParallel: (parallelId: string) => void;
  /** Profile IDs whose icon is currently being AI-generated. Each
   * matching ProfileItem shows a small spinner over its icon. */
  pendingIconGenerations?: Set<string>;
}

const PARALLEL_PHASE_COLORS: Record<string, string> = {
  starting: '#6b7280',
  awaiting: '#eab308',
  running: '#3b82f6',
  pushing: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
};

const PARALLEL_PHASE_LABELS: Record<string, string> = {
  starting: 'Starting…',
  awaiting: 'Awaiting run',
  running: 'Working',
  pushing: 'Pushing & opening PR',
  completed: 'Completed',
  failed: 'Failed',
};

function ParallelAgentRow({
  agent,
  status,
  selected,
  onSelect,
  onRun,
  onStop,
}: {
  agent: ParallelAgent;
  status: AgentStatus | undefined;
  selected: boolean;
  onSelect: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  // Prefer the live PTY status (working / needs-input / ready) over the
  // coarse phase, except when there's a pushing/failed/completed phase.
  const phase = agent.phase;
  let dotColor = PARALLEL_PHASE_COLORS[phase] || '#6b7280';
  let label = PARALLEL_PHASE_LABELS[phase] || phase;
  if (phase === 'running' && status === 'needs-input') {
    dotColor = '#eab308';
    label = 'Needs input';
  } else if (phase === 'running' && status === 'ready') {
    dotColor = '#22c55e';
    label = 'Idle';
  }

  return (
    <div
      className={`parallel-agent-row ${selected ? 'parallel-agent-row-active' : ''}`}
      onClick={onSelect}
      title={agent.errorMessage || label}
    >
      <span className="parallel-agent-dot" style={{ backgroundColor: dotColor }} />
      <div className="parallel-agent-text">
        <span className="parallel-agent-task">
          {agent.taskId} · {agent.taskTitle}
        </span>
        <span className="parallel-agent-meta">
          {label}
          {agent.prUrl && ' · PR opened'}
        </span>
      </div>
      <div className="parallel-agent-controls">
        {phase === 'awaiting' && (
          <button
            className="parallel-agent-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
            title="Run task"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" stroke="none">
              <polygon points="4 3 13 8 4 13" />
            </svg>
          </button>
        )}
        <button
          className="parallel-agent-btn parallel-agent-btn-stop"
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
          title="Stop & remove"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" stroke="none">
            <rect x="3" y="3" width="10" height="10" rx="1.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}

type DragData =
  | { type: 'profile'; profileId: string }
  | { type: 'folder'; folderId: string };

function generateFolderId(): string {
  return `folder-${Date.now().toString(36)}`;
}

// Build effective layout: ensure all profiles appear, even if not in layout yet
function buildEffectiveLayout(
  layout: SidebarLayout,
  profiles: Profile[],
): SidebarLayout {
  const allProfileIds = new Set(profiles.map((p) => p.id));
  const placedIds = new Set<string>();

  // Collect all profile IDs already placed
  for (const item of layout.items) {
    if (item.type === 'profile') placedIds.add(item.profileId);
  }
  for (const folder of layout.folders) {
    for (const pid of folder.profileIds) placedIds.add(pid);
  }

  // Remove stale references
  const items: SidebarItem[] = layout.items.filter((item) => {
    if (item.type === 'profile') return allProfileIds.has(item.profileId);
    return layout.folders.some((f) => f.id === item.folderId);
  });

  const folders = layout.folders.map((f) => ({
    ...f,
    profileIds: f.profileIds.filter((id) => allProfileIds.has(id)),
  }));

  // Append unplaced profiles at the end
  for (const pid of allProfileIds) {
    if (!placedIds.has(pid)) {
      items.push({ type: 'profile', profileId: pid });
    }
  }

  return { items, folders };
}

export function Sidebar({
  profiles,
  activeProfileId,
  statuses,
  layout,
  onLayoutChange,
  onSelectProfile,
  onEditProfile,
  onAddProfile,
  onStopProfile,
  onReloadProfile,
  initialized,
  showAgentBadge,
  iconRevision,
  hasUpdates,
  navActive,
  parallelAgents,
  selectedParallelId,
  onSelectParallel,
  onRunParallel,
  onStopParallel,
  pendingIconGenerations,
}: SidebarProps) {
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderNameInput, setFolderNameInput] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragDataRef = useRef<DragData | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const effective = buildEffectiveLayout(layout, profiles);
  const folderMap = new Map(effective.folders.map((f) => [f.id, f]));
  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  const handleAddFolder = () => {
    const id = generateFolderId();
    const newFolder: SidebarFolder = {
      id,
      name: 'New Folder',
      isOpen: true,
      profileIds: [],
    };
    const newLayout: SidebarLayout = {
      items: [...effective.items, { type: 'folder', folderId: id }],
      folders: [...effective.folders, newFolder],
    };
    onLayoutChange(newLayout);
    setEditingFolderId(id);
    setFolderNameInput('New Folder');
  };

  const handleToggleFolder = (folderId: string) => {
    const folders = effective.folders.map((f) =>
      f.id === folderId ? { ...f, isOpen: !f.isOpen } : f,
    );
    onLayoutChange({ ...effective, folders });
  };

  const handleRenameFolder = (folderId: string) => {
    const folder = folderMap.get(folderId);
    if (folder) {
      setEditingFolderId(folderId);
      setFolderNameInput(folder.name);
    }
  };

  const commitFolderRename = () => {
    if (!editingFolderId || !folderNameInput.trim()) {
      setEditingFolderId(null);
      return;
    }
    const folders = effective.folders.map((f) =>
      f.id === editingFolderId ? { ...f, name: folderNameInput.trim() } : f,
    );
    onLayoutChange({ ...effective, folders });
    setEditingFolderId(null);
  };

  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);

  // Folder-config modal state. Opened from the gear button on the folder
  // header. Lets the user rename the folder and set a per-folder
  // reference image used by AI icon generation for profiles inside.
  const [configFolderId, setConfigFolderId] = useState<string | null>(null);
  const [configName, setConfigName] = useState('');
  const [configRef, setConfigRef] = useState('');

  const openFolderConfig = (folderId: string) => {
    const folder = folderMap.get(folderId);
    if (!folder) return;
    setConfigFolderId(folderId);
    setConfigName(folder.name);
    setConfigRef(folder.referenceImage ?? '');
  };

  const saveFolderConfig = () => {
    if (!configFolderId) return;
    const name = configName.trim();
    const folders = effective.folders.map((f) =>
      f.id === configFolderId
        ? { ...f, name: name || f.name, referenceImage: configRef || undefined }
        : f,
    );
    onLayoutChange({ ...effective, folders });
    setConfigFolderId(null);
  };

  const browseFolderRefImage = async () => {
    const file = await window.api.selectFile();
    if (file) setConfigRef(file);
  };

  const resetFolderRefImage = () => setConfigRef('');

  const handleDeleteFolder = (folderId: string) => {
    setConfirmDeleteFolderId(folderId);
  };

  const confirmDeleteFolder = () => {
    const folderId = confirmDeleteFolderId;
    if (!folderId) return;
    setConfirmDeleteFolderId(null);
    const folder = folderMap.get(folderId);
    // Move folder's profiles to top level (after the folder's position)
    const items: SidebarItem[] = [];
    for (const item of effective.items) {
      if (item.type === 'folder' && item.folderId === folderId) {
        // Replace folder with its children
        for (const pid of folder?.profileIds ?? []) {
          items.push({ type: 'profile', profileId: pid });
        }
      } else {
        items.push(item);
      }
    }
    const folders = effective.folders.filter((f) => f.id !== folderId);
    onLayoutChange({ items, folders });
  };

  // --- Drag and Drop ---
  const handleDragStart = useCallback(
    (data: DragData) => (e: React.DragEvent) => {
      dragDataRef.current = data;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify(data));
    },
    [],
  );

  const handleDragOver = useCallback(
    (targetId: string) => (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(targetId);
    },
    [],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the element entirely, not entering a child
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    (targetId: string, targetType: 'before' | 'into-folder', inFolderId?: string) =>
      (e: React.DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        const data = dragDataRef.current;
        if (!data) return;

        // Remove dragged item from current position
        let items = [...effective.items];
        let folders = effective.folders.map((f) => ({
          ...f,
          profileIds: [...f.profileIds],
        }));

        if (data.type === 'profile') {
          // Remove from top-level items
          items = items.filter(
            (i) => !(i.type === 'profile' && i.profileId === data.profileId),
          );
          // Remove from any folder
          for (const f of folders) {
            f.profileIds = f.profileIds.filter((id) => id !== data.profileId);
          }

          if (targetType === 'into-folder') {
            // Drop into folder (append to end)
            const folder = folders.find((f) => f.id === targetId);
            if (folder) folder.profileIds.push(data.profileId);
          } else if (inFolderId) {
            // Reorder within a folder — insert before targetId
            const folder = folders.find((f) => f.id === inFolderId);
            if (folder) {
              const idx = folder.profileIds.indexOf(targetId);
              if (idx >= 0) folder.profileIds.splice(idx, 0, data.profileId);
              else folder.profileIds.push(data.profileId);
            }
          } else {
            // Insert before target in top-level items
            const idx = items.findIndex((i) => {
              if (i.type === 'profile') return i.profileId === targetId;
              if (i.type === 'folder') return i.folderId === targetId;
              return false;
            });
            const newItem: SidebarItem = {
              type: 'profile',
              profileId: data.profileId,
            };
            if (idx >= 0) items.splice(idx, 0, newItem);
            else items.push(newItem);
          }
        } else if (data.type === 'folder') {
          if (targetType === 'into-folder') return; // can't nest folders
          items = items.filter(
            (i) => !(i.type === 'folder' && i.folderId === data.folderId),
          );
          const idx = items.findIndex((i) => {
            if (i.type === 'profile') return i.profileId === targetId;
            if (i.type === 'folder') return i.folderId === targetId;
            return false;
          });
          const newItem: SidebarItem = {
            type: 'folder',
            folderId: data.folderId,
          };
          if (idx >= 0) items.splice(idx, 0, newItem);
          else items.push(newItem);
        }

        onLayoutChange({ items, folders });
        dragDataRef.current = null;
      },
    [effective, onLayoutChange],
  );

  // Render a profile item with drag support, plus any parallel sub-agents
  const renderProfile = (profileId: string, indent: boolean, folderId?: string) => {
    const profile = profileMap.get(profileId);
    if (!profile) return null;
    const subAgents = parallelAgents.filter((a) => a.profileId === profileId);
    return (
      <div key={profileId}>
        <div
          className={`sidebar-drag-item ${indent ? 'sidebar-indent' : ''} ${
            dropTarget === profileId ? 'drop-before' : ''
          }`}
          draggable
          onDragStart={handleDragStart({ type: 'profile', profileId })}
          onDragOver={handleDragOver(profileId)}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop(profileId, 'before', folderId)}
        >
          <ProfileItem
            profile={profile}
            isActive={profile.id === activeProfileId && selectedParallelId === null}
            status={statuses.get(profile.id) || 'offline'}
            hasUpdate={hasUpdates.has(profile.id)}
            iconRevision={iconRevision}
            isRunning={initialized.has(profile.id)}
            showAgentBadge={showAgentBadge}
            iconGenerating={pendingIconGenerations?.has(profile.id) === true}
            onClick={() => {
              onSelectProfile(profile.id);
              onSelectParallel(null);
            }}
            onEdit={() => onEditProfile(profile)}
            onStop={() => onStopProfile(profile.id)}
            onReload={() => onReloadProfile(profile.id)}
          />
        </div>
        {subAgents.length > 0 && (
          <div className={`parallel-agent-list ${indent ? 'sidebar-indent' : ''}`}>
            {subAgents.map((sa) => (
              <ParallelAgentRow
                key={sa.id}
                agent={sa}
                status={statuses.get(`parallel:${sa.id}`)}
                selected={selectedParallelId === sa.id && profile.id === activeProfileId}
                onSelect={() => {
                  onSelectProfile(profile.id);
                  onSelectParallel(sa.id);
                }}
                onRun={() => onRunParallel(sa.id)}
                onStop={() => onStopParallel(sa.id)}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  // Right-click on the sidebar background → "New Folder". Skip if the click
  // was on a profile or folder row (those have their own affordances).
  const handleSidebarContextMenu = (e: React.MouseEvent) => {
    const targetEl = e.target as HTMLElement;
    if (
      targetEl.closest('.profile-item') ||
      targetEl.closest('.parallel-agent-row') ||
      targetEl.closest('.sidebar-folder-header') ||
      targetEl.closest('.sidebar-header-actions')
    ) {
      return;
    }
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  // Close the context menu on any click anywhere
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, { once: true });
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [ctxMenu]);

  return (
    <div className="sidebar" onContextMenu={handleSidebarContextMenu}>
      {ctxMenu && (
        <div
          className="file-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y, position: 'fixed' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="file-ctx-item"
            onClick={() => {
              setCtxMenu(null);
              handleAddFolder();
            }}
          >
            <span className="file-ctx-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />
                <line x1="8" y1="7.5" x2="8" y2="11" />
                <line x1="6.5" y1="9.25" x2="9.5" y2="9.25" />
              </svg>
            </span>
            New Folder
          </button>
        </div>
      )}
      <div className="sidebar-header">
        <h2>Agents</h2>
        <div className="sidebar-header-actions">
          <button
            className="add-profile-btn"
            onClick={handleAddFolder}
            title="Add folder"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />
            </svg>
          </button>
          <button
            className="add-profile-btn"
            onClick={onAddProfile}
            title="Add profile"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
          </button>
        </div>
      </div>
      <div
        className="sidebar-profiles"
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget('end');
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop('end', 'before')}
      >
        {effective.items.map((item) => {
          if (item.type === 'profile') {
            return renderProfile(item.profileId, false);
          }

          const folder = folderMap.get(item.folderId);
          if (!folder) return null;

          return (
            <div key={folder.id} className="sidebar-folder">
              <div
                className={`sidebar-folder-header ${
                  dropTarget === `folder:${folder.id}` ? 'drop-into' : ''
                } ${dropTarget === folder.id ? 'drop-before' : ''}`}
                // Clicking the header itself toggles the folder
                // collapsed/expanded — same effect as the chevron button.
                // In compact mode the chevron + name + config button are
                // all `display: none`, so the divider becomes the only
                // clickable surface and this is the only way to expand.
                // We guard with `e.target === e.currentTarget` so clicks
                // on the chevron, name span, or config button (in
                // expanded mode) don't get a double-toggle.
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    handleToggleFolder(folder.id);
                  }
                }}
                draggable
                onDragStart={handleDragStart({
                  type: 'folder',
                  folderId: folder.id,
                })}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  // Drop into folder if dragging a profile, drop before if dragging a folder
                  const d = dragDataRef.current;
                  if (d?.type === 'profile') {
                    setDropTarget(`folder:${folder.id}`);
                  } else {
                    setDropTarget(folder.id);
                  }
                }}
                onDragLeave={handleDragLeave}
                onDrop={(e) => {
                  const d = dragDataRef.current;
                  if (d?.type === 'profile') {
                    handleDrop(folder.id, 'into-folder')(e);
                  } else {
                    handleDrop(folder.id, 'before')(e);
                  }
                }}
              >
                <button
                  className="folder-toggle"
                  onClick={() => handleToggleFolder(folder.id)}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      transform: folder.isOpen
                        ? 'rotate(90deg)'
                        : 'rotate(0deg)',
                      transition: 'transform 0.15s',
                    }}
                  >
                    <polyline points="6 3 11 8 6 13" />
                  </svg>
                </button>
                {editingFolderId === folder.id ? (
                  <input
                    className="folder-name-input"
                    value={folderNameInput}
                    onChange={(e) => setFolderNameInput(e.target.value)}
                    onBlur={commitFolderRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitFolderRename();
                      if (e.key === 'Escape') setEditingFolderId(null);
                    }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="folder-name"
                    onDoubleClick={() => handleRenameFolder(folder.id)}
                  >
                    {folder.name}
                  </span>
                )}
                <button
                  className="folder-config-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    openFolderConfig(folder.id);
                  }}
                  title="Folder settings"
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="8" cy="8" r="2" />
                    <path d="M13.5 8a5.5 5.5 0 0 0-.1-1.1l1.4-1-1.5-2.6-1.7.6a5.5 5.5 0 0 0-1.9-1.1L9.4 1H6.6L6.3 2.8a5.5 5.5 0 0 0-1.9 1.1l-1.7-.6L1.2 5.9l1.4 1A5.5 5.5 0 0 0 2.5 8c0 .4 0 .7.1 1.1l-1.4 1L2.7 12.7l1.7-.6a5.5 5.5 0 0 0 1.9 1.1l.3 1.8h2.8l.3-1.8a5.5 5.5 0 0 0 1.9-1.1l1.7.6 1.5-2.6-1.4-1c.1-.4.1-.7.1-1.1z" />
                  </svg>
                </button>
                <span className="folder-count">
                  {folder.profileIds.length}
                </span>
              </div>
              {folder.isOpen &&
                folder.profileIds.map((pid) => renderProfile(pid, true, folder.id))}
            </div>
          );
        })}
        {profiles.length === 0 && (
          <div className="sidebar-empty" onClick={onAddProfile}>
            Click + to add an agent profile
          </div>
        )}
      </div>
      {navActive && (
        <>
          <div className="nav-arrows-profile nav-arrow-up">
            <span className="nav-arrow">&#x2191;</span>
          </div>
          <div className="nav-arrows-profile nav-arrow-down">
            <span className="nav-arrow">&#x2193;</span>
          </div>
        </>
      )}
      {configFolderId && (
        <div className="modal-overlay" onClick={() => setConfigFolderId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Folder Settings</h3>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">Name</span>
                <input
                  type="text"
                  value={configName}
                  onChange={(e) => setConfigName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveFolderConfig(); } }}
                  autoFocus
                />
              </label>
              <label className="field">
                <span className="field-label">Icon reference image</span>
                <span className="field-hint" style={{ marginBottom: 6 }}>
                  When set, AI icon generation for profiles in this folder uses
                  this image as the style reference instead of the global one
                  in Settings → Icons.
                </span>
                <div className="field-with-btn">
                  <input
                    type="text"
                    value={configRef}
                    onChange={(e) => setConfigRef(e.target.value)}
                    placeholder="(use global default)"
                  />
                  <button className="browse-btn" onClick={browseFolderRefImage}>Browse</button>
                  <button
                    className="browse-btn"
                    onClick={resetFolderRefImage}
                    disabled={!configRef}
                    title="Clear the per-folder reference; profiles in this folder will use the global setting again"
                  >
                    Reset
                  </button>
                </div>
                {configRef && (
                  <div className="icon-preview" style={{ marginTop: 8 }}>
                    <img
                      src={`local-file://${configRef}`}
                      alt="Reference preview"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                )}
              </label>
            </div>
            <div className="modal-footer">
              <button
                className="delete-btn"
                onClick={() => {
                  // Close the settings dialog first, then surface the
                  // existing confirm-delete modal so the user gets a
                  // final "profiles will be ungrouped" warning.
                  const folderId = configFolderId;
                  setConfigFolderId(null);
                  if (folderId) handleDeleteFolder(folderId);
                }}
                title="Delete this folder; profiles inside will be ungrouped"
              >
                Delete folder…
              </button>
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setConfigFolderId(null)}>Cancel</button>
                <button className="save-btn" onClick={saveFolderConfig}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {confirmDeleteFolderId && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteFolderId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete Folder</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Are you sure you want to delete{' '}
                <strong>{folderMap.get(confirmDeleteFolderId)?.name}</strong>?
                The profiles inside will be moved to the top level.
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button
                  className="cancel-btn"
                  onClick={() => setConfirmDeleteFolderId(null)}
                >
                  Cancel
                </button>
                <button className="delete-btn" onClick={confirmDeleteFolder}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
