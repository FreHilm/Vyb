import { useState, useEffect, useRef } from 'react';
import { Profile, AgentConfig } from '../../shared/types';

// Agent icons — must match SettingsDialog.tsx definitions
const AGENT_ICONS: Record<string, { viewBox: string; paths: string[]; color: string; stroke?: boolean }> = {
  claude: { viewBox: '0 0 16 16', color: '#d97757', stroke: true, paths: ['M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.4 3.4l2.8 2.8M9.8 9.8l2.8 2.8M12.6 3.4l-2.8 2.8M6.2 9.8l-2.8 2.8'] },
  codex: { viewBox: '0 0 16 16', color: '#10a37f', paths: ['M8 1L2.5 4.5v7L8 15l5.5-3.5v-7L8 1zm0 2.5L11 5.5v2L8 9.5 5 7.5v-2L8 3.5z'] },
  gemini: { viewBox: '0 0 16 16', color: '#4285f4', paths: ['M8 0C8 4.4 4.4 8 0 8c4.4 0 8 3.6 8 8 0-4.4 3.6-8 8-8-4.4 0-8-3.6-8-8z'] },
  opencode: { viewBox: '0 0 16 16', color: '#fbbf24', stroke: true, paths: ['M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4M9.2 3 6.8 13'] },
};

function AgentIcon({ agentId, size = 16 }: { agentId: string; size?: number }) {
  const icon = AGENT_ICONS[agentId];
  if (!icon) {
    // Generic robot icon for custom agents
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--c-overlay0)' }}>
        <path d="M8 1a3 3 0 00-3 3v1H4a2 2 0 00-2 2v6a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-1V4a3 3 0 00-3-3zm0 1.5A1.5 1.5 0 019.5 4v1h-3V4A1.5 1.5 0 018 2.5zM6 9a1 1 0 112 0 1 1 0 01-2 0zm4 0a1 1 0 112 0 1 1 0 01-2 0z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox={icon.viewBox}
      fill={icon.stroke ? 'none' : icon.color}
      stroke={icon.stroke ? icon.color : 'none'}
      strokeWidth={icon.stroke ? '1.8' : '0'}
      strokeLinecap="round"
    >
      {icon.paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

interface ProfileEditorProps {
  profile: Profile | null; // null = creating new
  agents: AgentConfig[];
  onSave: (profile: Profile) => void;
  onDelete: (profileId: string) => void;
  onClose: () => void;
  /** Fire an icon generation in the background. App owns the lifecycle —
   * we just kick it off and forget. The dialog can be closed before the
   * generation finishes; App updates the saved profile in place. */
  onStartIconGeneration?: (profileId: string, name: string) => void;
  /** Set of profile IDs that App is currently generating icons for —
   * drives the "Generating…" indicator. */
  pendingIconGenerations?: Set<string>;
}

function generateId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug}-${Date.now().toString(36)}`;
}

export function ProfileEditor({
  profile,
  agents,
  onSave,
  onDelete,
  onClose,
  onStartIconGeneration,
  pendingIconGenerations,
}: ProfileEditorProps) {
  const isNew = profile === null;

  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [agentId, setAgentId] = useState('claude');
  const [parallelAgentEnabled, setParallelAgentEnabled] = useState(false);
  const [parallelAgentAutoPush, setParallelAgentAutoPush] = useState(false);
  const [genError, setGenError] = useState('');
  const [iconCacheBust, setIconCacheBust] = useState(0);
  /** Locked-in profile id. Resolved lazily — the moment either "AI
   * Generate" or "Save" is clicked, we settle on an id (existing profile's
   * id, or a freshly generated one) and keep using it. This is what lets
   * the background icon land on the same id the user eventually saves. */
  const [pendingProfileId, setPendingProfileId] = useState<string | null>(profile?.id ?? null);
  // Derive "is generating" from the parent's pending set, scoped to this
  // dialog's locked-in profile id (if any).
  const generating = pendingProfileId
    ? pendingIconGenerations?.has(pendingProfileId) === true
    : false;

  // Snapshot of the initial form values for this dialog session — used to
  // detect "unsaved changes" so we can prompt the user before closing.
  // We capture once per profile prop change and keep it as a ref so it
  // doesn't trigger re-renders.
  const initialSnapshotRef = useRef({
    name: profile?.name ?? '',
    icon: profile?.icon ?? '',
    workingDirectory: profile?.workingDirectory ?? '',
    agentId: profile?.agentId ?? 'claude',
    parallelAgentEnabled: profile?.parallelAgentEnabled === true,
    parallelAgentAutoPush: profile?.parallelAgentAutoPush === true,
  });
  // Whether the user has saved this session — `handleSave` flips this to
  // true so the "are you sure?" prompt skips after a normal save+close.
  const [hasSaved, setHasSaved] = useState(false);
  // Dialog state for "you have unsaved changes" confirmation on close.
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setIcon(profile.icon);
      setWorkingDirectory(profile.workingDirectory);
      setParallelAgentEnabled(profile.parallelAgentEnabled === true);
      setParallelAgentAutoPush(profile.parallelAgentAutoPush === true);
      // Resolve agentId: use stored agentId, or match by command
      const resolvedAgentId = profile.agentId
        || agents.find((a) => a.command === profile.command)?.id
        || agents[0]?.id
        || 'claude';
      setAgentId(resolvedAgentId);
      initialSnapshotRef.current = {
        name: profile.name,
        icon: profile.icon,
        workingDirectory: profile.workingDirectory,
        agentId: resolvedAgentId,
        parallelAgentEnabled: profile.parallelAgentEnabled === true,
        parallelAgentAutoPush: profile.parallelAgentAutoPush === true,
      };
    }
  }, [profile, agents]);

  const handleBrowseDirectory = async () => {
    const dir = await window.api.selectDirectory();
    if (dir) setWorkingDirectory(dir);
  };

  const handleUseTempDir = async () => {
    const dir = await window.api.createTempDir();
    if (dir) {
      setWorkingDirectory(dir);
      // Suggest a name if the user hasn't typed one yet
      if (!name.trim()) setName('Scratch');
    }
  };

  const handleBrowseIcon = async () => {
    const file = await window.api.selectFile();
    if (file) setIcon(file);
  };

  const handleGenerateIcon = () => {
    if (!name.trim()) return;
    setGenError('');
    const id = pendingProfileId ?? profile?.id ?? generateId(name);
    setPendingProfileId(id);
    // Fire and forget. App owns the lifecycle and updates the saved
    // profile's icon when generation completes, even if the user has
    // already saved and closed this dialog.
    onStartIconGeneration?.(id, name.trim());
  };

  // Refresh the in-dialog preview when the App's background generation
  // resolves for our locked-in id. If the dialog has already been closed
  // there's no listener to fire — App still updates the saved profile.
  useEffect(() => {
    const onReady = (e: Event) => {
      const detail = (e as CustomEvent<{ profileId: string; iconPath: string }>).detail;
      if (!detail || !pendingProfileId) return;
      if (detail.profileId !== pendingProfileId) return;
      setIcon(detail.iconPath);
      setIconCacheBust(Date.now());
    };
    const onFailed = (e: Event) => {
      const detail = (e as CustomEvent<{ profileId: string; error: string }>).detail;
      if (!detail || !pendingProfileId) return;
      if (detail.profileId !== pendingProfileId) return;
      setGenError(detail.error);
    };
    window.addEventListener('profile-icon-ready', onReady);
    window.addEventListener('profile-icon-failed', onFailed);
    return () => {
      window.removeEventListener('profile-icon-ready', onReady);
      window.removeEventListener('profile-icon-failed', onFailed);
    };
  }, [pendingProfileId]);

  const handleSave = () => {
    if (!name.trim() || !workingDirectory.trim()) return;

    const agent = agents.find((a) => a.id === agentId);

    // Use the same id the background generation (if any) is targeting so
    // the late-arriving icon updates this saved profile rather than an
    // orphan id.
    const id = pendingProfileId ?? profile?.id ?? generateId(name);
    const saved: Profile = {
      id,
      name: name.trim(),
      icon,
      workingDirectory: workingDirectory.trim(),
      agentId,
      parallelAgentEnabled,
      parallelAgentAutoPush,
      // Store resolved command/args for backwards compat with older versions
      command: agent?.command || 'claude',
      args: agent?.args || [],
    };

    setHasSaved(true);
    onSave(saved);
  };

  // Any form field differs from the initial snapshot? Treated as "unsaved
  // changes" — close attempts surface the confirmation popup. Initiating
  // an AI Generate also counts because pendingProfileId moves off its
  // initial value (the profile's own id, or null).
  const isDirty = !hasSaved && (
    name !== initialSnapshotRef.current.name
    || icon !== initialSnapshotRef.current.icon
    || workingDirectory !== initialSnapshotRef.current.workingDirectory
    || agentId !== initialSnapshotRef.current.agentId
    || parallelAgentEnabled !== initialSnapshotRef.current.parallelAgentEnabled
    || parallelAgentAutoPush !== initialSnapshotRef.current.parallelAgentAutoPush
    || (pendingProfileId !== null && pendingProfileId !== profile?.id)
  );

  /** Gated close: when there are unsaved changes, surface the prompt.
   * The prompt's own buttons call onClose() directly to actually close. */
  const requestClose = () => {
    if (isDirty) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const handleDelete = () => {
    if (profile) {
      onDelete(profile.id);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) requestClose();
  };

  const selectedAgent = agents.find((a) => a.id === agentId);

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <h3>{isNew ? 'New Profile' : 'Edit Profile'}</h3>
          <button className="modal-close" onClick={requestClose}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="currentColor"
            >
              <path d="M1.7 0.3a1 1 0 00-1.4 1.4L5.6 7l-5.3 5.3a1 1 0 101.4 1.4L7 8.4l5.3 5.3a1 1 0 001.4-1.4L8.4 7l5.3-5.3a1 1 0 00-1.4-1.4L7 5.6 1.7 0.3z" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project Agent"
              autoFocus
            />
          </label>

          <label className="field">
            <span className="field-label">Working Directory</span>
            <div className="field-with-btn">
              <input
                type="text"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                placeholder="/path/to/project"
              />
              <button className="browse-btn" onClick={handleBrowseDirectory}>
                Browse
              </button>
              <button
                className="browse-btn"
                onClick={handleUseTempDir}
                title="Create a fresh temporary folder for a scratchpad agent"
              >
                Temp
              </button>
            </div>
          </label>

          <div className="field">
            <span className="field-label">Agent</span>
            <div className="agent-picker">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`agent-pick-btn ${agentId === a.id ? 'agent-pick-active' : ''}`}
                  onClick={() => setAgentId(a.id)}
                  title={`${a.command} ${a.args.join(' ')}`}
                >
                  <AgentIcon agentId={a.id} size={14} />
                  <span>{a.name || a.command}</span>
                </button>
              ))}
            </div>
            {selectedAgent && (
              <span className="field-hint">
                {selectedAgent.command} {selectedAgent.args.join(' ')}
              </span>
            )}
          </div>

          <label className="field">
            <span className="field-label">Icon</span>
            <div className="field-with-btn">
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="(optional) /path/to/icon.png"
              />
              <button className="browse-btn" onClick={handleBrowseIcon}>
                Browse
              </button>
              <button
                className="browse-btn generate-icon-btn"
                onClick={handleGenerateIcon}
                disabled={generating || !name.trim()}
                title="Generate icon with AI (requires Gemini API key in Settings)"
              >
                {generating ? 'Generating...' : 'AI Generate'}
              </button>
            </div>
            {(icon || generating) && (
              <div className={`icon-preview ${generating ? 'icon-generating' : ''}`}>
                {icon && (
                  <img
                    src={`local-file://${icon}${iconCacheBust ? `?t=${iconCacheBust}` : ''}`}
                    alt="Icon preview"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
                {generating && (
                  <div className="icon-spinner">
                    <svg viewBox="0 0 24 24" width="24" height="24">
                      <circle
                        cx="12" cy="12" r="10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeDasharray="50 20"
                      />
                    </svg>
                  </div>
                )}
              </div>
            )}
            {genError && <div className="field-error">{genError}</div>}
          </label>

          <label className="field field-row-toggle">
            <span className="field-label">Run Kanban tasks in parallel agents</span>
            <label className="integration-toggle">
              <input
                type="checkbox"
                checked={parallelAgentEnabled}
                onChange={(e) => setParallelAgentEnabled(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </label>
          <span className="field-hint" style={{ marginTop: -8 }}>
            When on, dispatching a Kanban task creates an isolated git worktree
            and a fresh agent for it on a feature branch — leaving this profile&apos;s
            main agent free.
          </span>

          {parallelAgentEnabled && (
            <>
              <label className="field field-row-toggle">
                <span className="field-label">Auto-push branch and open PR</span>
                <label className="integration-toggle">
                  <input
                    type="checkbox"
                    checked={parallelAgentAutoPush}
                    onChange={(e) => setParallelAgentAutoPush(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </label>
              <span className="field-hint" style={{ marginTop: -8 }}>
                When the parallel agent marks the task <code>status: done</code>,
                automatically <code>git push -u origin &lt;branch&gt;</code> and
                run <code>gh pr create --fill</code>. Requires the <code>gh</code>
                {' '}CLI authenticated; the branch is pushed first so manual PR
                creation still works if <code>gh</code> fails.
              </span>
            </>
          )}

        </div>

        <div className="modal-footer">
          {!isNew && (
            <button className="delete-btn" onClick={handleDelete}>
              Delete
            </button>
          )}
          <div className="modal-footer-right">
            <button className="cancel-btn" onClick={requestClose}>
              Cancel
            </button>
            <button
              className="save-btn"
              onClick={handleSave}
              disabled={!name.trim() || !workingDirectory.trim()}
            >
              {isNew ? 'Create' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {confirmClose && (
        <div className="modal-overlay" onClick={() => setConfirmClose(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Unsaved changes</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                You have unsaved changes
                {generating ? ' and an icon generation is still running' : ''}.
                <br />
                <span style={{ opacity: 0.7 }}>
                  {generating
                    ? 'Save now so the new icon attaches to this profile when ready, or discard to abandon the changes (the icon will still finish but won’t be saved anywhere).'
                    : 'Save your edits or discard them and close.'}
                </span>
              </p>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={() => setConfirmClose(false)}>Keep editing</button>
              <div className="modal-footer-right">
                <button
                  className="delete-btn"
                  onClick={() => { setConfirmClose(false); onClose(); }}
                >
                  Discard
                </button>
                <button
                  className="save-btn"
                  onClick={() => {
                    if (!name.trim() || !workingDirectory.trim()) return;
                    setConfirmClose(false);
                    handleSave();
                    onClose();
                  }}
                  disabled={!name.trim() || !workingDirectory.trim()}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
