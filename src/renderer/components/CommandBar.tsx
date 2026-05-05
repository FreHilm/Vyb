import { Profile, ExternalApp } from '../../shared/types';
import { APP_ICONS } from '../icons';
import { NavBadge } from './KeyNav';

export type CommandBarTab = 'agent' | 'files' | 'kanban';

interface CommandBarProps {
  profile: Profile | null;
  shellOpen: boolean;
  /** Currently active main-view tab. Files/Kanban replace the agent
   * terminal in the same panel; Agent shows the terminal. */
  activeTab: CommandBarTab;
  onSelectTab: (tab: CommandBarTab) => void;
  onToggleShell: () => void;
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

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function CommandBar({
  profile,
  shellOpen,
  activeTab,
  onSelectTab,
  onToggleShell,
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
  //   Tabs: Agent(0) Files(1) Kanban(2) | Terminal(3) | Mic Folder(4) | external apps(5+)
  // Nav indices skip the dictation button (it has its own Ctrl+Shift+D shortcut).
  const extStart = 5;

  return (
    <div className="command-bar">
      <div className="command-bar-tabs">
        <button
          className={`command-bar-tab ${activeTab === 'agent' ? 'command-bar-tab-active' : ''}`}
          onClick={() => onSelectTab('agent')}
          title="Show the agent terminal"
        >
          <NavNum active={navActive} idx={0} />
          <svg {...ICON_PROPS}>
            <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
            <polyline points="4.5 7 6.5 9 4.5 11" />
            <line x1="8" y1="11" x2="11" y2="11" />
          </svg>
          <span>Agent</span>
        </button>
        <button
          className={`command-bar-tab ${activeTab === 'files' ? 'command-bar-tab-active' : ''}`}
          onClick={() => onSelectTab('files')}
          title="File explorer"
        >
          <NavNum active={navActive} idx={1} />
          <svg {...ICON_PROPS}>
            <path d="M9 2H5A1.5 1.5 0 0 0 3.5 3.5v9A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V5.5L9 2Z" />
            <path d="M9 2v3.5h3.5" />
          </svg>
          <span>Files</span>
        </button>
        <button
          className={`command-bar-tab ${activeTab === 'kanban' ? 'command-bar-tab-active' : ''}`}
          onClick={() => onSelectTab('kanban')}
          title="Kanban (Ordna)"
        >
          <NavNum active={navActive} idx={2} />
          <svg {...ICON_PROPS}>
            <rect x="2" y="3" width="3.2" height="10" rx="0.5" />
            <rect x="6.4" y="3" width="3.2" height="7" rx="0.5" />
            <rect x="10.8" y="3" width="3.2" height="4" rx="0.5" />
          </svg>
          <span>Kanban</span>
        </button>
      </div>
      <div className="command-bar-actions">
        <button
          className={`action-btn ${shellOpen ? 'action-btn-active' : ''}`}
          onClick={onToggleShell}
          title="Toggle terminal"
        >
          <NavNum active={navActive} idx={3} />
          <svg {...ICON_PROPS}>
            <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
            <polyline points="4.5 7 6.5 9 4.5 11" />
            <line x1="8" y1="11" x2="11" y2="11" />
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
            <svg {...ICON_PROPS}>
              <rect x="6" y="2" width="4" height="7" rx="2" />
              <path d="M3.5 7.5v.5a4.5 4.5 0 0 0 9 0v-.5" />
              <line x1="8" y1="12.5" x2="8" y2="14" />
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
          <svg {...ICON_PROPS}>
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />
          </svg>
          <span>Folder</span>
        </button>

        {externalApps.length > 0 && <div className="command-bar-separator" />}

        {externalApps.map((app, i) => {
          const iconContent = APP_ICONS[app.icon] || APP_ICONS['file'];
          return (
            <button
              key={app.id}
              className="action-btn"
              onClick={() => handleOpenExternal(app)}
              title={`Open in ${app.name}`}
            >
              <NavNum active={navActive} idx={extStart + i} />
              <svg {...ICON_PROPS} dangerouslySetInnerHTML={{ __html: iconContent }} />
              <span>{app.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
