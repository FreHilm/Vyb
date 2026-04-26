import { useEffect, useState } from 'react';
import { AppSettings, ExternalApp, AgentConfig, DEFAULT_AGENTS } from '../../shared/types';

// Built-in agent IDs that cannot be deleted
const BUILTIN_AGENT_IDS = new Set(DEFAULT_AGENTS.map((a) => a.id));

// Agent logo icons keyed by agent ID
const AGENT_ICONS: Record<string, { viewBox: string; paths: string[]; color: string }> = {
  // Claude: stylized starburst/asterisk
  claude: {
    viewBox: '0 0 16 16',
    color: '#d97757',
    paths: [
      'M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.4 3.4l2.8 2.8M9.8 9.8l2.8 2.8M12.6 3.4l-2.8 2.8M6.2 9.8l-2.8 2.8',
    ],
  },
  // Codex/OpenAI: simplified hexagonal knot
  codex: {
    viewBox: '0 0 16 16',
    color: '#10a37f',
    paths: [
      'M8 1L2.5 4.5v7L8 15l5.5-3.5v-7L8 1zm0 2.5L11 5.5v2L8 9.5 5 7.5v-2L8 3.5z',
    ],
  },
  // Gemini: four-pointed sparkle star
  gemini: {
    viewBox: '0 0 16 16',
    color: '#4285f4',
    paths: [
      'M8 0C8 4.4 4.4 8 0 8c4.4 0 8 3.6 8 8 0-4.4 3.6-8 8-8-4.4 0-8-3.6-8-8z',
    ],
  },
};
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

type SettingsTab = 'appearance' | 'flames' | 'agents' | 'icons' | 'apps' | 'integrations' | 'ordna' | 'backup';

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
  const [agents, setAgents] = useState<AgentConfig[]>(
    settings.agents?.length ? settings.agents : [...DEFAULT_AGENTS],
  );
  const [externalApps, setExternalApps] = useState<ExternalApp[]>(
    settings.externalApps || [],
  );
  const [navModifierKey, setNavModifierKey] = useState(settings.navModifierKey);
  const [dictationMode, setDictationMode] = useState(settings.dictationMode);
  const [dictationLang, setDictationLang] = useState(settings.dictationLang);
  const [gpuAcceleration, setGpuAcceleration] = useState(settings.gpuAcceleration);
  const [flameIntensity, setFlameIntensity] = useState(settings.flameIntensity);
  const [flameSpread, setFlameSpread] = useState(settings.flameSpread);
  const [flameLength, setFlameLength] = useState(settings.flameLength);
  const [flameSpeed, setFlameSpeed] = useState(settings.flameSpeed);
  const [flamePreviewMode, setFlamePreviewMode] = useState<'working' | 'ready' | 'needs-input'>('working');
  const [editingAgentIdx, setEditingAgentIdx] = useState<number | null>(null);
  const [showAgentBadge, setShowAgentBadge] = useState(settings.showAgentBadge !== false);
  const [ordnaMode, setOrdnaMode] = useState<'web' | 'tui'>(settings.ordnaMode || 'web');
  const [ordnaHookPort, setOrdnaHookPort] = useState(settings.ordnaHookPort || 9876);
  const [ordnaHookInfo, setOrdnaHookInfo] = useState<{ url: string; port: number } | null>(null);

  useEffect(() => {
    window.api.getOrdnaHookInfo().then(setOrdnaHookInfo).catch((): void => undefined);
  }, []);

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
      agents,
      externalApps,
      navModifierKey,
      dictationMode,
      dictationLang,
      gpuAcceleration,
      flameIntensity,
      flameSpread,
      flameLength,
      flameSpeed,
      showAgentBadge,
      ordnaMode,
      ordnaHookPort,
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
            className={`settings-tab ${tab === 'flames' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('flames')}
          >
            Flames
          </button>
          <button
            className={`settings-tab ${tab === 'agents' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('agents')}
          >
            Agents
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
            className={`settings-tab ${tab === 'ordna' ? 'settings-tab-active' : ''}`}
            onClick={() => setTab('ordna')}
          >
            Ordna
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

              <div className="field">
                <span className="field-label">Quick Navigation Key</span>
                <div className="field-row">
                  <button
                    className={`provider-btn ${navModifierKey === 'meta' ? 'provider-btn-active' : ''}`}
                    onClick={() => setNavModifierKey('meta')}
                  >
                    {window.api.platform === 'darwin' ? 'Cmd' : 'Win'}
                  </button>
                  <button
                    className={`provider-btn ${navModifierKey === 'alt' ? 'provider-btn-active' : ''}`}
                    onClick={() => setNavModifierKey('alt')}
                  >
                    {window.api.platform === 'darwin' ? 'Option' : 'Alt'}
                  </button>
                </div>
                <span className="field-hint">
                  Hold to show navigation shortcuts over buttons
                </span>
              </div>

              <div className="field">
                <span className="field-label">Dictation Mode</span>
                <div className="field-row">
                  <button
                    className={`provider-btn ${dictationMode === 'toggle' ? 'provider-btn-active' : ''}`}
                    onClick={() => setDictationMode('toggle')}
                  >
                    Toggle
                  </button>
                  <button
                    className={`provider-btn ${dictationMode === 'hold' ? 'provider-btn-active' : ''}`}
                    onClick={() => setDictationMode('hold')}
                  >
                    Hold
                  </button>
                </div>
                <span className="field-hint">
                  Toggle: click to start/stop. Hold: press and hold to dictate. Hotkey: Ctrl+Shift+D
                </span>
              </div>

              <label className="field">
                <span className="field-label">Dictation Language</span>
                <select
                  className="field-select"
                  value={dictationLang}
                  onChange={(e) => setDictationLang(e.target.value)}
                >
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (UK)</option>
                  <option value="sv-SE">Swedish</option>
                  <option value="de-DE">German</option>
                  <option value="fr-FR">French</option>
                  <option value="es-ES">Spanish</option>
                  <option value="it-IT">Italian</option>
                  <option value="pt-BR">Portuguese (BR)</option>
                  <option value="ja-JP">Japanese</option>
                  <option value="zh-CN">Chinese (Simplified)</option>
                  <option value="ko-KR">Korean</option>
                </select>
              </label>

              <div className="field">
                <span className="field-label">Terminal Rendering</span>
                <div className="field-row">
                  <button
                    className={`provider-btn ${gpuAcceleration === 'auto' ? 'provider-btn-active' : ''}`}
                    onClick={() => setGpuAcceleration('auto')}
                  >
                    Auto (WebGL)
                  </button>
                  <button
                    className={`provider-btn ${gpuAcceleration === 'canvas' ? 'provider-btn-active' : ''}`}
                    onClick={() => setGpuAcceleration('canvas')}
                  >
                    Canvas
                  </button>
                  <button
                    className={`provider-btn ${gpuAcceleration === 'off' ? 'provider-btn-active' : ''}`}
                    onClick={() => setGpuAcceleration('off')}
                  >
                    Off
                  </button>
                </div>
                <span className="field-hint">
                  Auto tries WebGL first, falls back to canvas. Use Canvas if you see rendering glitches.
                </span>
              </div>

              <label className="field field-row-toggle">
                <span className="field-label">Show agent logo on profiles</span>
                <label className="integration-toggle">
                  <input
                    type="checkbox"
                    checked={showAgentBadge}
                    onChange={(e) => setShowAgentBadge(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </label>
            </>
          )}

          {tab === 'flames' && (
            <>
              <div className="flame-preview-container">
                <div className="flame-preview-bar">
                  {(['working', 'ready', 'needs-input'] as const).map((mode) => {
                    const colors = { working: '#3b82f6', ready: '#22c55e', 'needs-input': '#eab308' };
                    const isAnimated = mode === 'working' || mode === 'needs-input';
                    const isCalm = mode === 'ready';
                    const intensityVal = 0.2 + (flameIntensity / 100) * 1.8;
                    const spreadVal = 0.2 + (flameSpread / 100) * 2.3;
                    const lengthVal = Math.round(6 + (flameLength / 100) * 54);
                    const speedVal = flameSpeed <= 50
                      ? 1 + (50 - flameSpeed) / 50 * 2
                      : 1 - (flameSpeed - 50) / 50 * 0.85;
                    return (
                      <div
                        key={mode}
                        className={`flame-preview-item ${flamePreviewMode === mode ? 'flame-preview-active' : ''}`}
                        onClick={() => setFlamePreviewMode(mode)}
                      >
                        <div className="flame-preview-profile">
                          <div
                            className={`flame-indicator ${isAnimated ? 'flame-animated' : isCalm ? 'flame-calm' : ''}`}
                            style={{
                              '--flame-color': colors[mode],
                              width: `${lengthVal}px`,
                              opacity: intensityVal,
                              '--flame-speed': `${speedVal}`,
                            } as React.CSSProperties}
                          >
                            <svg viewBox="0 0 24 60" preserveAspectRatio="none" fill="none"
                              style={{ transform: `scaleX(${spreadVal})`, transformOrigin: 'left center' }}
                            >
                              <rect className="flame-base" x="0" y="0" width="3" height="60" />
                              <path className="flame spike-1"  d="M3 0 L12 2 L3 5z" />
                              <path className="flame spike-2"  d="M3 4 L7 6.5 L3 8z" />
                              <path className="flame spike-3"  d="M3 7 L16 10 L3 14z" />
                              <path className="flame spike-4"  d="M3 13 L9 15 L3 18z" />
                              <path className="flame spike-5"  d="M3 17 L14 19.5 L3 23z" />
                              <path className="flame spike-6"  d="M3 22 L8 24.5 L3 28z" />
                              <path className="flame spike-7"  d="M3 26 L17 29.5 L3 33z" />
                              <path className="flame spike-8"  d="M3 32 L11 35 L3 38z" />
                              <path className="flame spike-9"  d="M3 37 L6 39 L3 42z" />
                              <path className="flame spike-10" d="M3 40 L15 43 L3 47z" />
                              <path className="flame spike-11" d="M3 46 L9 48.5 L3 52z" />
                              <path className="flame spike-12" d="M3 50 L18 53 L3 57z" />
                              <path className="flame spike-13" d="M3 56 L10 58 L3 60z" />
                            </svg>
                          </div>
                          <div className="flame-preview-icon" style={{ borderColor: colors[mode] + '44' }}>
                            <div className="flame-preview-dot" style={{ backgroundColor: colors[mode] }} />
                          </div>
                        </div>
                        <span className="flame-preview-label">
                          {mode === 'working' ? 'Working' : mode === 'ready' ? 'Ready' : 'Needs Input'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <label className="field">
                <span className="field-label">Intensity</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={flameIntensity}
                  onChange={(e) => setFlameIntensity(Number(e.target.value))}
                />
                <span className="field-hint">Brightness and opacity of the flames</span>
              </label>

              <label className="field">
                <span className="field-label">Spread</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={flameSpread}
                  onChange={(e) => setFlameSpread(Number(e.target.value))}
                />
                <span className="field-hint">How wide the flame spikes extend horizontally</span>
              </label>

              <label className="field">
                <span className="field-label">Length</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={flameLength}
                  onChange={(e) => setFlameLength(Number(e.target.value))}
                />
                <span className="field-hint">Width of the flame zone along the profile edge</span>
              </label>

              <label className="field">
                <span className="field-label">Speed</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={flameSpeed}
                  onChange={(e) => setFlameSpeed(Number(e.target.value))}
                />
                <span className="field-hint">Animation speed — slow breathing to rapid flicker</span>
              </label>
            </>
          )}

          {tab === 'agents' && (
            <>
              <span className="field-hint" style={{ marginBottom: 12 }}>
                AI agents available for profiles. Click edit to change command and arguments.
              </span>

              <div className="agent-list">
                {agents.map((agent, idx) => {
                  const isEditing = editingAgentIdx === idx;
                  const isBuiltin = BUILTIN_AGENT_IDS.has(agent.id);
                  const iconDef = AGENT_ICONS[agent.id];
                  return (
                    <div key={agent.id} className={`agent-card ${isEditing ? 'agent-card-editing' : ''}`}>
                      <div className="agent-card-header">
                        <div className="agent-card-icon" style={iconDef ? { color: iconDef.color } : undefined}>
                          {iconDef ? (
                            <svg width="20" height="20" viewBox={iconDef.viewBox}
                              fill={agent.id === 'claude' ? 'none' : 'currentColor'}
                              stroke={agent.id === 'claude' ? 'currentColor' : 'none'}
                              strokeWidth={agent.id === 'claude' ? '1.8' : '0'}
                              strokeLinecap="round"
                            >
                              {iconDef.paths.map((d, i) => <path key={i} d={d} />)}
                            </svg>
                          ) : (
                            <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                              <path d="M8 1a3 3 0 00-3 3v1H4a2 2 0 00-2 2v6a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-1V4a3 3 0 00-3-3zm0 1.5A1.5 1.5 0 019.5 4v1h-3V4A1.5 1.5 0 018 2.5zM6 9a1 1 0 112 0 1 1 0 01-2 0zm4 0a1 1 0 112 0 1 1 0 01-2 0z" />
                            </svg>
                          )}
                        </div>
                        <div className="agent-card-info">
                          {isEditing ? (
                            <input
                              type="text"
                              className="agent-edit-input agent-edit-name"
                              value={agent.name}
                              onChange={(e) => {
                                const updated = [...agents];
                                updated[idx] = { ...agent, name: e.target.value };
                                setAgents(updated);
                              }}
                              placeholder="Agent name"
                              autoFocus
                            />
                          ) : (
                            <span className="agent-card-name">{agent.name || 'Unnamed'}</span>
                          )}
                          <span className="agent-card-cmd">
                            {agent.command}{agent.args.length > 0 ? ` ${agent.args.join(' ')}` : ''}
                          </span>
                        </div>
                        <div className="agent-card-actions">
                          <button
                            className="agent-action-btn"
                            onClick={() => setEditingAgentIdx(isEditing ? null : idx)}
                            title={isEditing ? 'Done' : 'Edit'}
                          >
                            {isEditing ? (
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9zm-1 4l-7 7v1h1l7-7-1-1z" />
                              </svg>
                            )}
                          </button>
                          {!isBuiltin && (
                            <button
                              className="agent-action-btn agent-action-delete"
                              onClick={() => setAgents(agents.filter((_, i) => i !== idx))}
                              title="Remove"
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M5.5 1h5l.5.5V3h3.5v1H13l-.7 10.2a1 1 0 01-1 .8H4.7a1 1 0 01-1-.8L3 4h-.5V3H6V1.5l.5-.5zM6 3h4V2H6v1z" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                      {isEditing && (
                        <div className="agent-card-edit">
                          <label className="field">
                            <span className="field-label">Command</span>
                            <input
                              type="text"
                              value={agent.command}
                              onChange={(e) => {
                                const updated = [...agents];
                                updated[idx] = { ...agent, command: e.target.value };
                                setAgents(updated);
                              }}
                              placeholder="e.g. claude"
                              style={{ fontFamily: 'monospace' }}
                            />
                          </label>
                          <label className="field">
                            <span className="field-label">Arguments</span>
                            <input
                              type="text"
                              value={agent.args.join(' ')}
                              onChange={(e) => {
                                const updated = [...agents];
                                updated[idx] = {
                                  ...agent,
                                  args: e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [],
                                };
                                setAgents(updated);
                              }}
                              placeholder="e.g. --continue"
                              style={{ fontFamily: 'monospace' }}
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <button
                className="batch-generate-btn"
                onClick={() => {
                  const id = `agent-${Date.now().toString(36)}`;
                  setAgents([...agents, { id, name: '', command: '', args: [] }]);
                  setEditingAgentIdx(agents.length);
                }}
              >
                + Add Agent
              </button>
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
              )}

              {iconProvider === 'openai' && (
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
              )}

              {!geminiApiKey && !openaiApiKey && (
                <span className="field-hint" style={{ color: 'var(--c-yellow)' }}>
                  No API key configured. Add one in the Integrations tab.
                </span>
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
                    <path d="M8 1a2 2 0 00-2 2v2a2 2 0 104 0V3a2 2 0 00-2-2zM3 6a2 2 0 00-2 2v1a2 2 0 104 0V8a2 2 0 00-2-2zm10 0a2 2 0 00-2 2v1a2 2 0 104 0V8a2 2 0 00-2-2zM5 11a2 2 0 012-2h2a2 2 0 110 4H7a2 2 0 01-2-2z" />
                  </svg>
                  <span className="integration-title">API Keys</span>
                </div>
                <span className="field-hint" style={{ marginBottom: 8 }}>
                  Used for icon generation, dictation (speech-to-text), and other AI features.
                </span>

                <label className="field">
                  <span className="field-label">OpenAI API Key</span>
                  <input
                    type="text"
                    value={openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                    placeholder="sk-..."
                    style={{ fontFamily: 'monospace' }}
                  />
                  <span className="field-hint">
                    Used for: icon generation (GPT Image), dictation (Whisper). Get one at platform.openai.com
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">Gemini API Key</span>
                  <input
                    type="text"
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    placeholder="AIza..."
                    style={{ fontFamily: 'monospace' }}
                  />
                  <span className="field-hint">
                    Used for: icon generation (Nano Banana), dictation fallback. Get one at ai.google.dev
                  </span>
                </label>
              </div>
            </>
          )}

          {tab === 'ordna' && (
            <>
              <span className="field-hint" style={{ marginBottom: 12 }}>
                Ordna is a git-native Kanban board. The Kanban tab opens it scoped to the active profile&apos;s working directory.
                Tasks dispatched from Ordna (TUI: <code>g</code> key, web: agent button) are injected into the active agent.
              </span>

              <div className="field">
                <span className="field-label">Mode</span>
                <div className="field-row">
                  <button
                    className={`provider-btn ${ordnaMode === 'web' ? 'provider-btn-active' : ''}`}
                    onClick={() => setOrdnaMode('web')}
                  >
                    Web
                  </button>
                  <button
                    className={`provider-btn ${ordnaMode === 'tui' ? 'provider-btn-active' : ''}`}
                    onClick={() => setOrdnaMode('tui')}
                  >
                    TUI
                  </button>
                </div>
                <span className="field-hint">
                  Web embeds the Ordna SPA in an iframe. TUI runs <code>npx -y @frehilm/ordna-cli</code> in an embedded terminal.
                </span>
              </div>

              <label className="field">
                <span className="field-label">Hook Receiver Port</span>
                <div className="field-row">
                  <input
                    type="number"
                    min="1024"
                    max="65535"
                    value={ordnaHookPort}
                    onChange={(e) => setOrdnaHookPort(Number(e.target.value) || 9876)}
                    style={{ width: 100 }}
                  />
                  <span className="field-hint">
                    Restart required. Falls back to next free port if taken.
                  </span>
                </div>
              </label>

              {ordnaHookInfo && ordnaHookInfo.url && (
                <div className="field">
                  <span className="field-label">Active Hook URL</span>
                  <input
                    type="text"
                    value={ordnaHookInfo.url}
                    readOnly
                    style={{ fontFamily: 'monospace' }}
                  />
                  <span className="field-hint">
                    Set automatically via env vars when Ordna is launched from the Kanban tab.
                  </span>
                </div>
              )}
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
