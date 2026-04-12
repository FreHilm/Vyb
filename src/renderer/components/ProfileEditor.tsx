import { useState, useEffect } from 'react';
import { Profile } from '../../shared/types';

interface ProfileEditorProps {
  profile: Profile | null; // null = creating new
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
  onSave,
  onDelete,
  onClose,
}: ProfileEditorProps) {
  const isNew = profile === null;

  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [command, setCommand] = useState('claude');
  const [args, setArgs] = useState('--continue');
  const [slackChannel, setSlackChannel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');
  const [iconCacheBust, setIconCacheBust] = useState(0);

  useEffect(() => {
    if (profile) {
      setName(profile.name);
      setIcon(profile.icon);
      setWorkingDirectory(profile.workingDirectory);
      setCommand(profile.command);
      setArgs(profile.args.join(' '));
      setSlackChannel(profile.slackChannel || '');
    }
  }, [profile]);

  const handleBrowseDirectory = async () => {
    const dir = await window.api.selectDirectory();
    if (dir) setWorkingDirectory(dir);
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

    const saved: Profile = {
      id: profile?.id ?? generateId(name),
      name: name.trim(),
      icon,
      workingDirectory: workingDirectory.trim(),
      command: command.trim() || 'claude',
      args: args
        .trim()
        .split(/\s+/)
        .filter((a) => a),
      slackChannel: slackChannel.trim() || undefined,
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
            </div>
          </label>

          <label className="field">
            <span className="field-label">Command</span>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="claude"
            />
          </label>

          <label className="field">
            <span className="field-label">Arguments</span>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="(optional, space-separated)"
            />
          </label>

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

          <label className="field">
            <span className="field-label">Slack Channel</span>
            <input
              type="text"
              value={slackChannel}
              onChange={(e) => setSlackChannel(e.target.value)}
              placeholder="(optional) Channel ID e.g. C01234ABCDE"
            />
            <span className="field-hint">
              Channel ID from Slack (right-click channel → View channel details → copy ID).
              Requires Slack integration enabled in Settings → Integrations.
            </span>
          </label>
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
