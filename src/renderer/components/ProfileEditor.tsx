import { useState, useEffect } from 'react';
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
}: ProfileEditorProps) {
  const isNew = profile === null;

  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [agentId, setAgentId] = useState('claude');
  const [parallelAgentEnabled, setParallelAgentEnabled] = useState(false);
  const [parallelAgentAutoPush, setParallelAgentAutoPush] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  const [iconCacheBust, setIconCacheBust] = useState(0);

  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setIcon(profile.icon);
      setWorkingDirectory(profile.workingDirectory);
      setParallelAgentEnabled(profile.parallelAgentEnabled === true);
      setParallelAgentAutoPush(profile.parallelAgentAutoPush === true);
      // Resolve agentId: use stored agentId, or match by command
      if (profile.agentId) {
        setAgentId(profile.agentId);
      } else {
        // Backwards compat: try to match by command
        const match = agents.find((a) => a.command === profile.command);
        setAgentId(match?.id || agents[0]?.id || 'claude');
      }
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

  const handleGenerateIcon = async () => {
    if (!name.trim()) return;
    setGenerating(true);
    setGenError('');
    try {
      const profileId = profile?.id ?? generateId(name);
      const iconPath = await window.api.generateIcon(profileId, name.trim());
      if (iconPath) {
        setIcon(iconPath);
        setIconCacheBust(Date.now());
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setGenError(msg);
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = () => {
    if (!name.trim() || !workingDirectory.trim()) return;

    const agent = agents.find((a) => a.id === agentId);

    const saved: Profile = {
      id: profile?.id ?? generateId(name),
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

    onSave(saved);
  };

  const handleDelete = () => {
    if (profile) {
      onDelete(profile.id);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const selectedAgent = agents.find((a) => a.id === agentId);

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <h3>{isNew ? 'New Profile' : 'Edit Profile'}</h3>
          <button className="modal-close" onClick={onClose}>
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
            <button className="cancel-btn" onClick={onClose}>
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
    </div>
  );
}
