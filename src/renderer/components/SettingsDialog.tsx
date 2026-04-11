import { useState } from 'react';
import { AppSettings, ExternalApp } from '../../shared/types';
import { hueToPreviewColor } from '../theme';
import { APP_ICONS, APP_ICON_LABELS } from '../icons';

interface SettingsDialogProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
  batchGenerating: boolean;
  batchProgress: string;
  onBatchGenerate: () => void;
  profilesWithoutIcons: number;
}

type SettingsTab = 'appearance' | 'icons' | 'apps' | 'integrations' | 'backup';

function BackupTab() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');

  const handleExport = async () => {
    setExporting(true);
    setMessage('');
    try {
      const filePath = await window.api.exportBackup();
      if (filePath) {
        setMessage(`Exported to ${filePath}`);
      }
    } catch (err) {
      setMessage(`Export failed: ${err}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setMessage('');
    try {
      const success = await window.api.importBackup();
      if (success) {
        setMessage('Imported successfully. Restart the app to apply changes.');
      }
    } catch (err) {
      setMessage(`Import failed: ${err}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <span className="field-hint" style={{ marginBottom: 12 }}>
        Export or import your profiles, settings, layout, and generated icons as a ZIP file.
      </span>

      <div className="backup-actions">
        <button
          className="backup-btn"
          onClick={handleExport}
          disabled={exporting || importing}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1v9M5 7l3 3 3-3M2 12v2h12v-2" />
          </svg>
          {exporting ? 'Exporting...' : 'Export Backup'}
        </button>
        <button
          className="backup-btn"
          onClick={handleImport}
          disabled={exporting || importing}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 10V1M5 4l3-3 3 3M2 12v2h12v-2" />
          </svg>
          {importing ? 'Importing...' : 'Import Backup'}
        </button>
      </div>

      {message && (
        <div className="backup-message">{message}</div>
      )}

      <div className="field-hint" style={{ marginTop: 12 }}>
        <strong>Includes:</strong> profiles.json, settings.json, layout.json, and all generated icons.
      </div>
    </>
  );
}

export function SettingsDialog({
  settings,
  onSave,
  onClose,
  batchGenerating,
  batchProgress,
  onBatchGenerate,
  profilesWithoutIcons,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const [baseHue, setBaseHue] = useState(settings.baseHue);
  const [darkness, setDarkness] = useState(settings.darkness);
  const [textLightness, setTextLightness] = useState(settings.textLightness);
  const [profileFontSize, setProfileFontSize] = useState(
    settings.profileFontSize,
  );
  const [agentFontSize, setAgentFontSize] = useState(settings.agentFontSize);
  const [shellFontSize, setShellFontSize] = useState(settings.shellFontSize);
  const [iconProvider, setIconProvider] = useState(settings.iconProvider);
  const [geminiModel, setGeminiModel] = useState(settings.geminiModel);
  const [geminiApiKey, setGeminiApiKey] = useState(settings.geminiApiKey);
  const [openaiModel, setOpenaiModel] = useState(settings.openaiModel);
  const [openaiApiKey, setOpenaiApiKey] = useState(settings.openaiApiKey);
  const [iconPromptPrefix, setIconPromptPrefix] = useState(
    settings.iconPromptPrefix,
  );
  const [iconReferenceImage, setIconReferenceImage] = useState(
    settings.iconReferenceImage,
  );
  const [externalApps, setExternalApps] = useState<ExternalApp[]>(
    settings.externalApps || [],
  );
  const [slackEnabled, setSlackEnabled] = useState(settings.slackEnabled);
  const [slackBotToken, setSlackBotToken] = useState(settings.slackBotToken);

  const handleSave = () => {
    onSave({
      ...settings,
      baseHue,
      darkness,
      textLightness,
      profileFontSize,
      agentFontSize,
      shellFontSize,
      iconProvider,
      geminiModel,
      geminiApiKey,
      openaiModel,
      openaiApiKey,
      iconPromptPrefix,
      iconReferenceImage,
      externalApps,
      slackEnabled,
      slackBotToken,
    });
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const previewBg = hueToPreviewColor(baseHue, darkness);

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal settings-modal">
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="modal-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M1.7 0.3a1 1 0 00-1.4 1.4L5.6 7l-5.3 5.3a1 1 0 101.4 1.4L7 8.4l5.3 5.3a1 1 0 001.4-1.4L8.4 7l5.3-5.3a1 1 0 00-1.4-1.4L7 5.6 1.7 0.3z" />
            </svg>
          </button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === 'appearance' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('appearance')}
          >
            Appearance
          </button>
          <button
            className={`settings-tab ${tab === 'icons' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('icons')}
          >
            Icons
          </button>
          <button
            className={`settings-tab ${tab === 'apps' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('apps')}
          >
            Apps
          </button>
          <button
            className={`settings-tab ${tab === 'integrations' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('integrations')}
          >
            Integrations
          </button>
          <button
            className={`settings-tab ${tab === 'backup' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('backup')}
          >
            Backup
          </button>
        </div>

        <div className="modal-body">
          {tab === 'appearance' && (
            <>
              <label className="field">
                <span className="field-label">
                  UI Base Color
                  {baseHue >= 360 ? ' — Grayscale' : ''}
                </span>
                <input
                  type="range"
                  className="hue-slider"
                  min="0"
                  max="360"
                  value={baseHue}
                  onChange={(e) => setBaseHue(Number(e.target.value))}
                />
              </label>

              <label className="field">
                <span className="field-label">Darkness</span>
                <input
                  type="range"
                  className="darkness-slider"
                  min="0"
                  max="80"
                  value={darkness}
                  onChange={(e) => setDarkness(Number(e.target.value))}
                />
              </label>

              <div
                style={{
                  height: 24,
                  borderRadius: 6,
                  background: previewBg,
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              />

              <label className="field">
                <span className="field-label">Text Brightness</span>
                <input
                  type="range"
                  className="text-lightness-slider"
                  min="0"
                  max="100"
                  value={textLightness}
                  onChange={(e) => setTextLightness(Number(e.target.value))}
                />
              </label>

              <label className="field">
                <span className="field-label">Profile Panel Font Size</span>
                <div className="field-row">
                  <input
                    type="number"
                    min="10"
                    max="20"
                    value={profileFontSize}
                    onChange={(e) => setProfileFontSize(Number(e.target.value))}
                  />
                  <span className="field-hint">
                    Scales sidebar text proportionally (default: 13)
                  </span>
                </div>
              </label>

              <label className="field">
                <span className="field-label">Agent Terminal Font Size</span>
                <div className="field-row">
                  <input
                    type="number"
                    min="10"
                    max="24"
                    value={agentFontSize}
                    onChange={(e) => setAgentFontSize(Number(e.target.value))}
                  />
                  <span className="field-hint">Default: 14</span>
                </div>
              </label>

              <label className="field">
                <span className="field-label">Shell Terminal Font Size</span>
                <div className="field-row">
                  <input
                    type="number"
                    min="10"
                    max="24"
                    value={shellFontSize}
                    onChange={(e) => setShellFontSize(Number(e.target.value))}
                  />
                  <span className="field-hint">Default: 14</span>
                </div>
              </label>
            </>
          )}

          {tab === 'icons' && (
            <>
              <div className="field">
                <span className="field-label">Provider</span>
                <div className="field-row">
                  <button
                    className={`provider-btn ${iconProvider === 'gemini' ? 'provider-btn-active' : ''}`}
                    onClick={() => setIconProvider('gemini')}
                  >
                    Gemini
                  </button>
                  <button
                    className={`provider-btn ${iconProvider === 'openai' ? 'provider-btn-active' : ''}`}
                    onClick={() => setIconProvider('openai')}
                  >
                    ChatGPT
                  </button>
                </div>
              </div>

              {iconProvider === 'gemini' && (
                <>
                  <label className="field">
                    <span className="field-label">Model</span>
                    <select
                      className="field-select"
                      value={geminiModel}
                      onChange={(e) => setGeminiModel(e.target.value)}
                    >
                      <option value="gemini-3.1-flash-image-preview">Nano Banana 2 — Newest, fast</option>
                      <option value="gemini-3-pro-image-preview">Nano Banana Pro — Best quality, 4K</option>
                      <option value="gemini-2.5-flash-image">Nano Banana — Stable</option>
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">API Key</span>
                    <input
                      type="text"
                      value={geminiApiKey}
                      onChange={(e) => setGeminiApiKey(e.target.value)}
                      placeholder="AIza..."
                      style={{ fontFamily: 'monospace' }}
                    />
                    <span className="field-hint">Get one at ai.google.dev</span>
                  </label>
                </>
              )}

              {iconProvider === 'openai' && (
                <>
                  <label className="field">
                    <span className="field-label">Model</span>
                    <select
                      className="field-select"
                      value={openaiModel}
                      onChange={(e) => setOpenaiModel(e.target.value)}
                    >
                      <option value="gpt-image-1">GPT Image 1 — Newest, best quality</option>
                      <option value="dall-e-3">DALL-E 3</option>
                      <option value="dall-e-2">DALL-E 2</option>
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">API Key</span>
                    <input
                      type="text"
                      value={openaiApiKey}
                      onChange={(e) => setOpenaiApiKey(e.target.value)}
                      placeholder="sk-..."
                      style={{ fontFamily: 'monospace' }}
                    />
                    <span className="field-hint">Get one at platform.openai.com</span>
                  </label>
                </>
              )}

              <label className="field">
                <span className="field-label">Prompt</span>
                <textarea
                  className="field-textarea"
                  value={iconPromptPrefix}
                  onChange={(e) => setIconPromptPrefix(e.target.value)}
                  placeholder="Describe the visual universe/style for generated icons..."
                  rows={3}
                />
                <span className="field-hint">
                  "Make a project icon for [name] that matches: [this text]"
                </span>
              </label>

              <label className="field">
                <span className="field-label">Style Reference Image</span>
                <div className="field-with-btn">
                  <input
                    type="text"
                    value={iconReferenceImage}
                    onChange={(e) => setIconReferenceImage(e.target.value)}
                    placeholder="(optional) /path/to/reference-icon.png"
                  />
                  <button
                    className="browse-btn"
                    onClick={async () => {
                      const file = await window.api.selectFile();
                      if (file) setIconReferenceImage(file);
                    }}
                  >
                    Browse
                  </button>
                  {iconReferenceImage && (
                    <button
                      className="browse-btn"
                      onClick={() => setIconReferenceImage('')}
                      title="Clear"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {iconReferenceImage && (
                  <div className="icon-preview" style={{ marginTop: 8 }}>
                    <img
                      src={`local-file://${iconReferenceImage}`}
                      alt="Reference"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  </div>
                )}
                <span className="field-hint">
                  All icons will use this as a visual style reference
                </span>
              </label>

              <div className="field">
                <button
                  className={`batch-generate-btn ${batchGenerating ? 'batch-generating' : ''}`}
                  onClick={onBatchGenerate}
                  disabled={batchGenerating || profilesWithoutIcons === 0}
                >
                  {batchGenerating ? (
                    <>
                      <svg className="batch-spinner" viewBox="0 0 24 24" width="16" height="16">
                        <circle
                          cx="12" cy="12" r="10"
                          fill="none" stroke="currentColor"
                          strokeWidth="3" strokeDasharray="50 20"
                        />
                      </svg>
                      Generating... {batchProgress}
                    </>
                  ) : profilesWithoutIcons === 0 ? (
                    'All profiles have icons'
                  ) : (
                    `Generate icons for ${profilesWithoutIcons} profile${profilesWithoutIcons > 1 ? 's' : ''}`
                  )}
                </button>
                <span className="field-hint">
                  Generates icons for all profiles that don't have one yet
                </span>
              </div>
            </>
          )}

          {tab === 'apps' && (
            <>
              <span className="field-hint" style={{ marginBottom: 8 }}>
                Define external applications that appear in the command bar.
                Use <code>{'{path}'}</code> in the command as a placeholder for the project directory.
              </span>

              {externalApps.map((app, idx) => (
                <div key={app.id} className="ext-app-row">
                  <div className="ext-app-icon-picker">
                    <button
                      className="ext-app-icon-btn"
                      onClick={() => {
                        // Cycle to next icon
                        const keys = Object.keys(APP_ICONS);
                        const curIdx = keys.indexOf(app.icon);
                        const nextIdx = (curIdx + 1) % keys.length;
                        const updated = [...externalApps];
                        updated[idx] = { ...app, icon: keys[nextIdx] };
                        setExternalApps(updated);
                      }}
                      title={`Icon: ${APP_ICON_LABELS[app.icon] || app.icon} (click to change)`}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                        <path d={APP_ICONS[app.icon] || APP_ICONS['file']} />
                      </svg>
                    </button>
                    <select
                      className="ext-app-icon-select"
                      value={app.icon || 'file'}
                      onChange={(e) => {
                        const updated = [...externalApps];
                        updated[idx] = { ...app, icon: e.target.value };
                        setExternalApps(updated);
                      }}
                    >
                      {Object.entries(APP_ICON_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="ext-app-fields">
                    <input
                      type="text"
                      value={app.name}
                      onChange={(e) => {
                        const updated = [...externalApps];
                        updated[idx] = { ...app, name: e.target.value };
                        setExternalApps(updated);
                      }}
                      placeholder="Name"
                      className="ext-app-name"
                    />
                    <input
                      type="text"
                      value={app.command}
                      onChange={(e) => {
                        const updated = [...externalApps];
                        updated[idx] = { ...app, command: e.target.value };
                        setExternalApps(updated);
                      }}
                      placeholder='Command e.g. open -a "App" "{path}"'
                      className="ext-app-command"
                    />
                  </div>
                  <button
                    className="ext-app-delete"
                    onClick={() => {
                      setExternalApps(externalApps.filter((_, i) => i !== idx));
                    }}
                    title="Remove"
                  >
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor">
                      <path d="M1.7 0.3a1 1 0 00-1.4 1.4L5.6 7l-5.3 5.3a1 1 0 101.4 1.4L7 8.4l5.3 5.3a1 1 0 001.4-1.4L8.4 7l5.3-5.3a1 1 0 00-1.4-1.4L7 5.6 1.7 0.3z" />
                    </svg>
                  </button>
                </div>
              ))}

              <button
                className="batch-generate-btn"
                onClick={() => {
                  setExternalApps([
                    ...externalApps,
                    {
                      id: `app-${Date.now().toString(36)}`,
                      name: '',
                      icon: 'file',
                      command: '',
                    },
                  ]);
                }}
              >
                + Add Application
              </button>
            </>
          )}

          {tab === 'integrations' && (
            <>
              <div className="integration-section">
                <div className="integration-header">
                  <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.7 }}>
                    <path d="M6.5 1.5a1 1 0 00-2 0v1.25a.75.75 0 01-.75.75H2.5a1 1 0 000 2h1.25a.75.75 0 01.75.75V7.5a1 1 0 002 0V6.25a.75.75 0 01.75-.75H8.5a1 1 0 000-2H7.25a.75.75 0 01-.75-.75V1.5zM11.5 8.5a1 1 0 00-2 0v1.25a.75.75 0 01-.75.75H7.5a1 1 0 000 2h1.25a.75.75 0 01.75.75v1.25a1 1 0 002 0v-1.25a.75.75 0 01.75-.75h1.25a1 1 0 000-2h-1.25a.75.75 0 01-.75-.75V8.5z" />
                  </svg>
                  <span className="integration-title">Slack</span>
                  <label className="integration-toggle">
                    <input
                      type="checkbox"
                      checked={slackEnabled}
                      onChange={(e) => setSlackEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <span className="field-hint" style={{ marginBottom: 8 }}>
                  Two-way integration: status updates posted to Slack, messages from Slack forwarded to agents.
                  Map each profile to a channel in its profile settings.
                </span>

                {slackEnabled && (
                  <label className="field">
                    <span className="field-label">Bot Token</span>
                    <input
                      type="text"
                      value={slackBotToken}
                      onChange={(e) => setSlackBotToken(e.target.value)}
                      placeholder="xoxb-..."
                      style={{ fontFamily: 'monospace' }}
                    />
                    <span className="field-hint">
                      Create a Slack app at api.slack.com/apps, add Bot Token Scopes:
                      chat:write, channels:history, channels:read.
                      Install to workspace and copy the Bot User OAuth Token.
                    </span>
                  </label>
                )}
              </div>
            </>
          )}

          {tab === 'backup' && (
            <BackupTab />
          )}
        </div>

        <div className="modal-footer">
          <div className="modal-footer-right">
            <button className="cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button className="save-btn" onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
