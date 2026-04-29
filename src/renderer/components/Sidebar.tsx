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
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3 2l11 6-11 6z" />
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
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
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
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 3A1.5 1.5 0 013 1.5h3.3l1.2 1.5H13a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3zM7 7v4m-2-2h4" />
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
              fill="currentColor"
            >
              <path d="M1.5 1A1.5 1.5 0 000 2.5v11A1.5 1.5 0 001.5 15h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0014.5 4H7.71L6.85 2.15A1.5 1.5 0 005.57 1.5H1.5z" />
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
              viewBox="0 0 14 14"
              fill="currentColor"
            >
              <path d="M7 0a1 1 0 011 1v5h5a1 1 0 110 2H8v5a1 1 0 11-2 0V8H1a1 1 0 010-2h5V1a1 1 0 011-1z" />
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
                    viewBox="0 0 10 10"
                    fill="currentColor"
                    style={{
                      transform: folder.isOpen
                        ? 'rotate(90deg)'
                        : 'rotate(0deg)',
                      transition: 'transform 0.15s',
                    }}
                  >
                    <path d="M3 1l5 4-5 4V1z" />
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
                <span className="folder-count">
                  {folder.profileIds.length}
                </span>
                <button
                  className="folder-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteFolder(folder.id);
                  }}
                  title="Delete folder (profiles will be ungrouped)"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 14 14"
                    fill="currentColor"
                  >
                    <path d="M1.7 0.3a1 1 0 00-1.4 1.4L5.6 7l-5.3 5.3a1 1 0 101.4 1.4L7 8.4l5.3 5.3a1 1 0 001.4-1.4L8.4 7l5.3-5.3a1 1 0 00-1.4-1.4L7 5.6 1.7 0.3z" />
                  </svg>
                </button>
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
