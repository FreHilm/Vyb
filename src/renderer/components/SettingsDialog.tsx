import { useState } from 'react';
import { AppSettings } from '../../shared/types';
import { hueToPreviewColor } from '../theme';

interface SettingsDialogProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

export function SettingsDialog({
  settings,
  onSave,
  onClose,
}: SettingsDialogProps) {
  const [baseHue, setBaseHue] = useState(settings.baseHue);
  const [darkness, setDarkness] = useState(settings.darkness);
  const [profileFontSize, setProfileFontSize] = useState(
    settings.profileFontSize,
  );
  const [agentFontSize, setAgentFontSize] = useState(settings.agentFontSize);
  const [shellFontSize, setShellFontSize] = useState(settings.shellFontSize);
  const [geminiApiKey, setGeminiApiKey] = useState(settings.geminiApiKey);
  const [iconPromptPrefix, setIconPromptPrefix] = useState(
    settings.iconPromptPrefix,
  );

  const handleSave = () => {
    onSave({
      baseHue,
      darkness,
      profileFontSize,
      agentFontSize,
      shellFontSize,
      geminiApiKey,
      iconPromptPrefix,
    });
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const previewBg = hueToPreviewColor(baseHue, darkness);

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <h3>Settings</h3>
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

          <div style={{ borderTop: '1px solid var(--c-surface0)', margin: '8px 0' }} />

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
              Required for AI icon generation. Get one at ai.google.dev
            </span>
          </label>

          <label className="field">
            <span className="field-label">Icon Generation Prompt</span>
            <textarea
              className="field-textarea"
              value={iconPromptPrefix}
              onChange={(e) => setIconPromptPrefix(e.target.value)}
              placeholder="Describe the visual universe/style for generated icons..."
              rows={3}
            />
            <span className="field-hint">
              Each icon prompt will be: "Make a project icon for the project
              [name] that matches the following universe: [this text]"
            </span>
          </label>
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
