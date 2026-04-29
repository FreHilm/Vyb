import { Profile, ExternalApp } from '../../shared/types';
import { APP_ICONS } from '../icons';
import { NavBadge } from './KeyNav';

interface CommandBarProps {
  profile: Profile | null;
  shellOpen: boolean;
  readmeVisible: boolean;
  hasReadme: boolean;
  filesVisible: boolean;
  kanbanVisible: boolean;
  onToggleShell: () => void;
  onToggleReadme: () => void;
  onToggleFiles: () => void;
  onToggleKanban: () => void;
  externalApps: ExternalApp[];
  navActive: boolean;
  dictationListening: boolean;
  dictationSupported: boolean;
  dictationInterim: string;
  dictationMode: 'toggle' | 'hold';
  onDictationToggle: () => void;
  onDictationStart: () => void;
  onDictationStop: () => void;
}

function NavNum({ active, idx }: { active: boolean; idx: number }) {
  if (!active || idx >= 10) return null;
  return <NavBadge label={idx < 9 ? String(idx + 1) : '0'} />;
}

export function CommandBar({
  profile,
  shellOpen,
  readmeVisible,
  hasReadme,
  filesVisible,
  kanbanVisible,
  onToggleShell,
  onToggleReadme,
  onToggleFiles,
  onToggleKanban,
  externalApps,
  navActive,
  dictationListening,
  dictationSupported,
  dictationInterim,
  dictationMode,
  onDictationToggle,
  onDictationStart,
  onDictationStop,
}: CommandBarProps) {
  if (!profile) return <div className="command-bar" />;

  const handleOpenFolder = () => {
    window.api.openInFinder(profile.workingDirectory);
  };

  const handleOpenExternal = (app: ExternalApp) => {
    window.api.openExternal(app.command, profile.workingDirectory);
  };

  // Order on the bar:
  //   README(0) Files(1) Kanban(2) Terminal(3) | Mic Folder(4) | external apps(5+)
  // Nav indices skip the dictation button (it has its own Ctrl+Shift+D shortcut).
  const extStart = 5;

  return (
    <div className="command-bar">
      <div className="command-bar-actions">
        <button
          className={`action-btn ${readmeVisible ? 'action-btn-active' : ''}`}
          onClick={onToggleReadme}
          disabled={!hasReadme}
          title={hasReadme ? 'Toggle README' : 'No README.md found'}
        >
          <NavNum active={navActive} idx={0} />
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 2.5A1.5 1.5 0 012.5 1h3.204a1.5 1.5 0 011.06.44L8.122 2.8a.5.5 0 00.354.147H13.5A1.5 1.5 0 0115 4.5v8a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-10zM4 7a.5.5 0 000 1h8a.5.5 0 000-1H4zm0 2.5a.5.5 0 000 1h5a.5.5 0 000-1H4z" />
          </svg>
          <span>README</span>
        </button>
        <button
          className={`action-btn ${filesVisible ? 'action-btn-active' : ''}`}
          onClick={onToggleFiles}
          title="Toggle file explorer"
        >
          <NavNum active={navActive} idx={1} />
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.5 1a1 1 0 00-1 1v12a1 1 0 001 1h9a1 1 0 001-1V5.414a1 1 0 00-.293-.707L9.793 1.293A1 1 0 009.086 1H3.5zm5.5 1.5L12.5 6H9.5a.5.5 0 01-.5-.5V2.5z" />
          </svg>
          <span>Files</span>
        </button>
        <button
          className={`action-btn ${kanbanVisible ? 'action-btn-active' : ''}`}
          onClick={onToggleKanban}
          title="Toggle Kanban (Ordna)"
        >
          <NavNum active={navActive} idx={2} />
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 2h3a.5.5 0 01.5.5v11a.5.5 0 01-.5.5h-3a.5.5 0 01-.5-.5v-11a.5.5 0 01.5-.5zM6.5 2h3a.5.5 0 01.5.5v7a.5.5 0 01-.5.5h-3a.5.5 0 01-.5-.5v-7a.5.5 0 01.5-.5zM11.5 2h3a.5.5 0 01.5.5v4a.5.5 0 01-.5.5h-3a.5.5 0 01-.5-.5v-4a.5.5 0 01.5-.5z" />
          </svg>
          <span>Kanban</span>
        </button>
        <button
          className={`action-btn ${shellOpen ? 'action-btn-active' : ''}`}
          onClick={onToggleShell}
          title="Toggle terminal"
        >
          <NavNum active={navActive} idx={3} />
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 3a1 1 0 011-1h12a1 1 0 011 1v10a1 1 0 01-1 1H2a1 1 0 01-1-1V3zm1.5 1.5v8h11v-8h-11zM4 7l2.5 2L4 11v-4z" />
          </svg>
          <span>Terminal</span>
        </button>

        <div className="command-bar-separator" />

        {dictationSupported && (
          <button
            className={`action-btn ${dictationListening ? 'dictation-active' : ''}`}
            onClick={dictationMode === 'toggle' ? onDictationToggle : undefined}
            onMouseDown={dictationMode === 'hold' ? onDictationStart : undefined}
            onMouseUp={dictationMode === 'hold' ? onDictationStop : undefined}
            onMouseLeave={dictationMode === 'hold' && dictationListening ? onDictationStop : undefined}
            title={`Dictation (Ctrl+Shift+D) — ${dictationMode === 'hold' ? 'hold to talk' : 'click to toggle'}`}
          >
            {navActive && <NavBadge label="^⇧D" />}
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a2 2 0 00-2 2v4a2 2 0 104 0V3a2 2 0 00-2-2zM4 6.5a.5.5 0 00-1 0v.5A5 5 0 007.5 12H7v2H5.5a.5.5 0 000 1h5a.5.5 0 000-1H9v-2h-.5A5 5 0 0013 7v-.5a.5.5 0 00-1 0v.5a4 4 0 11-8 0v-.5z" />
            </svg>
            {dictationListening && dictationInterim && (
              <span className="dictation-interim">{dictationInterim}</span>
            )}
            {!dictationListening && <span>Mic</span>}
            {dictationListening && !dictationInterim && <span className="dictation-pulse">Listening...</span>}
          </button>
        )}
        <button className="action-btn" onClick={handleOpenFolder} title="Open in Finder">
          <NavNum active={navActive} idx={4} />
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 1A1.5 1.5 0 000 2.5v11A1.5 1.5 0 001.5 15h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0014.5 4H7.71L6.85 2.15A1.5 1.5 0 005.57 1.5H1.5z" />
          </svg>
          <span>Folder</span>
        </button>

        {externalApps.length > 0 && <div className="command-bar-separator" />}

        {externalApps.map((app, i) => {
          const iconPath = APP_ICONS[app.icon] || APP_ICONS['file'];
          return (
            <button
              key={app.id}
              className="action-btn"
              onClick={() => handleOpenExternal(app)}
              title={`Open in ${app.name}`}
            >
              <NavNum active={navActive} idx={extStart + i} />
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d={iconPath} />
              </svg>
              <span>{app.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
