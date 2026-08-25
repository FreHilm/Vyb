import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Workspace } from '../../shared/types';
import { ACTIVE_PROFILES_WORKSPACE_ID } from '../../shared/types';

interface Props {
  /** Count of profiles with a lit status flame (any status except
   * offline) — shown on the pinned virtual "Active profiles" row at the
   * top of the menu. Selecting that row calls onSelect with
   * ACTIVE_PROFILES_WORKSPACE_ID (runtime-only view, never persisted). */
  activeProfilesCount?: number;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onAdd: (name: string) => void;
  onRename: (workspaceId: string, name: string) => void;
  /** Workspace settings modal save — name + icon reference image (same
   * settings as a sidebar folder/section). */
  onUpdate: (workspaceId: string, patch: { name?: string; referenceImage?: string }) => void;
  onDelete: (workspaceId: string) => void;
  /** Drop target — a profile or folder dropped on a workspace row in
   * the menu moves into that workspace. Sidebar drag payloads come
   * through dataTransfer as `{ type, profileId|folderId }` JSON. */
  onMoveToWorkspace?: (
    payload: { type: 'profile' | 'folder'; id: string },
    targetWorkspaceId: string,
  ) => void;
  /** Per-workspace profile counts, rendered as "(N)" next to each
   * workspace name in the menu. Keyed by workspace id. */
  profileCounts?: Record<string, number>;
  /** Per-workspace folder (section) counts — with profileCounts, gates
   * the delete affordance: only empty workspaces are deletable. */
  folderCounts?: Record<string, number>;
}

/** The workspace picker that sits at the top of the sidebar in place
 * of the old "Agents" h2. Click the active name → menu drops down
 * with: a row per workspace (click to switch, right-side × to delete,
 * double-click name to rename), a separator, and a "+ New workspace"
 * inline-input row. Outside-click or Escape closes. */
export function WorkspaceDropdown({
  workspaces, activeWorkspaceId, onSelect, onAdd, onRename, onUpdate, onDelete,
  onMoveToWorkspace, profileCounts, folderCounts, activeProfilesCount,
}: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Workspace Settings modal (name + icon reference image) — mirrors the
  // sidebar folder-config modal. Opened via the row's gear/pencil button.
  const [configId, setConfigId] = useState<string | null>(null);
  const [configName, setConfigName] = useState('');
  const [configRef, setConfigRef] = useState('');
  // Drag-and-drop highlights. `dragOverWsId` marks the row the cursor
  // is currently over; `dragActive` styles the trigger while ANY drag
  // (profile or folder) is in flight so the user gets a visual hint
  // that the dropdown is a valid drop target.
  const [dragOverWsId, setDragOverWsId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The menu is rendered into a portal under <body>, so it's not a
  // DOM descendant of rootRef. We need its own ref to detect "click
  // inside the menu" in the outside-click handler — otherwise every
  // click on a menu row would be treated as outside and close it.
  const menuRef = useRef<HTMLDivElement>(null);
  // Viewport-anchored menu coordinates. The sidebar has
  // `overflow: hidden`, which would clip the right edge of an
  // absolutely-positioned menu in compact mode (the narrow icon-only
  // sidebar is much thinner than the 220 px menu). Using
  // `position: fixed` based on the trigger's bounding rect renders
  // the menu in the viewport coordinate space, outside any clipping
  // ancestor. Recomputed each time the menu opens.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const openMenu = useCallback(() => {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(true);
  }, []);

  const inActiveProfilesMode = activeWorkspaceId === ACTIVE_PROFILES_WORKSPACE_ID;
  const active = inActiveProfilesMode
    ? { id: ACTIVE_PROFILES_WORKSPACE_ID, name: 'Active profiles' }
    : workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];

  // Outside click / Escape close the menu. Skipped while a rename
  // input is focused so typing into it doesn't dismiss everything.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inRoot = rootRef.current?.contains(target);
      const inMenu = menuRef.current?.contains(target);
      if (!inRoot && !inMenu) {
        setOpen(false);
        setCreating(false);
        setRenamingId(null);
        setConfirmDeleteId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setCreating(false);
        setRenamingId(null);
        setConfirmDeleteId(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Clear DnD state when any drag in the document ends (drop happened
  // elsewhere or the user pressed Escape). Without this the trigger
  // highlight + auto-opened menu would linger after an aborted drag.
  useEffect(() => {
    const onEnd = () => { setDragActive(false); setDragOverWsId(null); };
    window.addEventListener('dragend', onEnd);
    return () => window.removeEventListener('dragend', onEnd);
  }, []);

  // `dataTransfer.getData()` returns '' during dragover (the spec
  // restricts payload access to the drop event), so during hover we
  // can only check `types`. The sidebar always sets `text/plain`, so
  // we accept any drag with that type as a candidate.
  const isAcceptableDrag = (e: React.DragEvent): boolean =>
    e.dataTransfer.types.includes('text/plain');

  const parsePayload = (e: React.DragEvent): { type: 'profile' | 'folder'; id: string } | null => {
    try {
      const raw = e.dataTransfer.getData('text/plain');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.type === 'profile' && typeof parsed.profileId === 'string') {
        return { type: 'profile', id: parsed.profileId };
      }
      if (parsed?.type === 'folder' && typeof parsed.folderId === 'string') {
        return { type: 'folder', id: parsed.folderId };
      }
    } catch { /* not our payload */ }
    return null;
  };

  const commitNew = () => {
    const name = newName.trim();
    if (name) onAdd(name);
    setNewName('');
    setCreating(false);
    setOpen(false);
  };

  const commitRename = (id: string) => {
    const name = renameValue.trim();
    if (name) onRename(id, name);
    setRenamingId(null);
    setRenameValue('');
  };

  const openConfig = (w: Workspace) => {
    setConfigId(w.id);
    setConfigName(w.name);
    setConfigRef(w.referenceImage ?? '');
    setOpen(false); // close the menu; the modal takes over
  };

  const saveConfig = () => {
    if (!configId) return;
    onUpdate(configId, { name: configName, referenceImage: configRef });
    setConfigId(null);
  };

  const browseConfigRef = async () => {
    const file = await window.api.selectFile();
    if (file) setConfigRef(file);
  };

  return (
    <div ref={rootRef} className="workspace-dropdown">
      <button
        ref={triggerRef}
        type="button"
        className={`workspace-dropdown-trigger${open ? ' is-open' : ''}${dragActive ? ' is-drop-target' : ''}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        title="Switch workspace — drag a profile or folder here to move it"
        onDragEnter={(e) => {
          if (!onMoveToWorkspace || !isAcceptableDrag(e)) return;
          // Auto-open the menu so the user can drop on a specific
          // workspace row. Stays open until the drag ends — dragend
          // listener above clears the highlight.
          if (!open) openMenu();
          setDragActive(true);
        }}
        onDragOver={(e) => {
          if (!onMoveToWorkspace || !isAcceptableDrag(e)) return;
          e.preventDefault(); // signals "this is a valid drop target"
        }}
      >
        {/* Compact-mode badge: first 3 letters of the workspace name in
            a short rounded pill. Hidden in expanded mode via CSS, shown
            when `.app-sidebar-compact` is active. The full name span
            next to it is hidden the other way around. */}
        <span className="workspace-dropdown-initial" aria-hidden="true">
          {(active?.name ?? '?').slice(0, 3).toUpperCase()}
        </span>
        <span className="workspace-dropdown-name">{active?.name ?? 'Workspaces'}</span>
        <svg
          className="workspace-dropdown-chevron"
          width="10" height="10" viewBox="0 0 16 16"
          fill="none" stroke="currentColor" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="3 6 8 11 13 6" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="workspace-dropdown-menu"
          role="menu"
          style={menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left } : undefined}
        >
          {activeProfilesCount !== undefined && (
            <>
              <div
                className={`workspace-dropdown-row workspace-dropdown-virtual${inActiveProfilesMode ? ' is-active' : ''}`}
                title="All profiles with an active status (anything but gray) — computed live, not saved"
                onClick={() => {
                  onSelect(ACTIVE_PROFILES_WORKSPACE_ID);
                  setOpen(false);
                }}
              >
                <span className="workspace-dropdown-label">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 6, opacity: 0.8 }}>
                    <circle cx="8" cy="8" r="4" />
                  </svg>
                  Active profiles
                  <span className="workspace-dropdown-count"> ({activeProfilesCount})</span>
                </span>
              </div>
              <div className="workspace-dropdown-divider" />
            </>
          )}
          {workspaces.map((w) => {
            const isActive = w.id === activeWorkspaceId;
            const isRenaming = renamingId === w.id;
            const isConfirmingDelete = confirmDeleteId === w.id;
            return (
              <div
                key={w.id}
                className={`workspace-dropdown-row${isActive ? ' is-active' : ''}${dragOverWsId === w.id ? ' is-drop-target' : ''}`}
                onClick={() => {
                  if (isRenaming || isConfirmingDelete) return;
                  onSelect(w.id);
                  setOpen(false);
                }}
                onDragEnter={(e) => {
                  if (!onMoveToWorkspace || !isAcceptableDrag(e)) return;
                  setDragOverWsId(w.id);
                }}
                onDragOver={(e) => {
                  if (!onMoveToWorkspace || !isAcceptableDrag(e)) return;
                  e.preventDefault(); // mark as drop target
                  e.dataTransfer.dropEffect = 'move';
                }}
                onDragLeave={(e) => {
                  // Only clear when leaving the row, not when crossing
                  // into a child element (delete button etc.).
                  const next = e.relatedTarget as Node | null;
                  if (next && (e.currentTarget as Node).contains(next)) return;
                  setDragOverWsId((prev) => (prev === w.id ? null : prev));
                }}
                onDrop={(e) => {
                  if (!onMoveToWorkspace) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const payload = parsePayload(e);
                  setDragOverWsId(null);
                  setDragActive(false);
                  setOpen(false);
                  if (payload) onMoveToWorkspace(payload, w.id);
                }}
              >
                <span className="workspace-dropdown-check" aria-hidden="true">
                  {isActive ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 8 7 12 13 4" />
                    </svg>
                  ) : null}
                </span>
                {isRenaming ? (
                  <input
                    className="workspace-dropdown-input"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(w.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(w.id);
                      if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="workspace-dropdown-label"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(w.id);
                      setRenameValue(w.name);
                    }}
                    title="Double-click to rename"
                  >
                    {w.name}
                    {profileCounts && (
                      <span className="workspace-dropdown-count">
                        {' '}({profileCounts[w.id] ?? 0})
                      </span>
                    )}
                  </span>
                )}
                {/* Settings button — hover-revealed pencil. Opens the
                    Workspace Settings modal (name + icon reference image,
                    same settings as a sidebar section). Quick inline rename
                    stays available by double-clicking the name. */}
                {!isRenaming && !isConfirmingDelete && (
                  <button
                    type="button"
                    className="workspace-dropdown-rename"
                    title="Workspace settings (name, icon reference image)"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                      openConfig(w);
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11.5 2.5l2 2L6 12l-2.5.5.5-2.5 7.5-7.5z" />
                    </svg>
                  </button>
                )}
                {/* Delete button — only shown for workspaces with no
                    profiles AND no folders/sections, so deleting can't
                    surprise-move the user's agents or sections to another
                    workspace. Also hidden when only one workspace remains
                    (last one is un-deletable) or while a rename is in
                    progress. First click on × asks inline confirmation;
                    second click commits. */}
                {workspaces.length > 1
                  && !isRenaming
                  && (profileCounts?.[w.id] ?? 0) === 0
                  && (folderCounts?.[w.id] ?? 0) === 0
                  && (
                  isConfirmingDelete ? (
                    <span className="workspace-dropdown-confirm" onClick={(e) => e.stopPropagation()}>
                      <span>Delete?</span>
                      <button
                        type="button"
                        className="workspace-dropdown-confirm-yes"
                        onClick={() => { setConfirmDeleteId(null); onDelete(w.id); }}
                      >Yes</button>
                      <button
                        type="button"
                        className="workspace-dropdown-confirm-no"
                        onClick={() => setConfirmDeleteId(null)}
                      >No</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="workspace-dropdown-delete"
                      title="Delete workspace"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(w.id);
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  )
                )}
              </div>
            );
          })}

          <div className="workspace-dropdown-sep" />

          {creating ? (
            <div className="workspace-dropdown-row" onClick={(e) => e.stopPropagation()}>
              <span className="workspace-dropdown-check" />
              <input
                className="workspace-dropdown-input"
                autoFocus
                placeholder="Workspace name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onBlur={commitNew}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitNew();
                  if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className="workspace-dropdown-row workspace-dropdown-new"
              onClick={() => setCreating(true)}
            >
              <span className="workspace-dropdown-check" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </span>
              <span className="workspace-dropdown-label">New workspace…</span>
            </button>
          )}
        </div>,
        document.body,
      )}

      {/* Workspace Settings modal — same fields as the sidebar folder
          (section) config: name + AI-icon reference image. Icon
          resolution order at generation time: section → workspace →
          global (Settings → Icons). */}
      {configId && createPortal(
        <div className="modal-overlay" onClick={() => setConfigId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Workspace Settings</h3>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">Name</span>
                <input
                  type="text"
                  value={configName}
                  onChange={(e) => setConfigName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveConfig(); } }}
                  autoFocus
                />
              </label>
              <label className="field">
                <span className="field-label">Icon reference image</span>
                <span className="field-hint" style={{ marginBottom: 6 }}>
                  When set, AI icon generation for profiles in this workspace
                  uses this image as the style reference. A section&apos;s own
                  reference image still wins; without either, the global one
                  in Settings → Icons is used.
                </span>
                <div className="field-with-btn">
                  <input
                    type="text"
                    value={configRef}
                    onChange={(e) => setConfigRef(e.target.value)}
                    placeholder="(use global default)"
                  />
                  <button className="browse-btn" onClick={browseConfigRef}>Browse</button>
                  <button
                    className="browse-btn"
                    onClick={() => setConfigRef('')}
                    disabled={!configRef}
                    title="Clear the workspace reference; sections/global settings apply again"
                  >
                    Reset
                  </button>
                </div>
              </label>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={() => setConfigId(null)}>Cancel</button>
              <button className="save-btn" onClick={saveConfig}>Save</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
