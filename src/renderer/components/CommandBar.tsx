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
  /** Toggles the Git panel (Changes / Tree / Branches). Same panel the
   * status-bar pickaxe opens. */
  onToggleGit: () => void;
  /** Whether the Git panel is currently shown — drives the active styling. */
  gitActive: boolean;
  externalApps: ExternalApp[];
  navActive: boolean;
  /** When false (default), the built-in action buttons (Terminal, Mic,
   * Folder) render icon-only. External app buttons are unaffected. */
  showActionLabels: boolean;
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
  onToggleGit,
  gitActive,
  externalApps,
  navActive,
  showActionLabels,
  dictationListening,
  dictationSupported,
  dictationInterim,
  dictationMode,
  onDictationToggle,
  onDictationStart,
  onDictationStop,
}: CommandBarProps) {
  // Compact icon-only buttons get a modifier class so CSS can shrink the
  // horizontal padding (otherwise they'd look weirdly wide for a 16px icon).
  const actionBtnCls = showActionLabels ? 'action-btn' : 'action-btn action-btn-icon';
  if (!profile) return <div className="command-bar" />;

  const handleOpenFolder = () => {
    window.api.openInFinder(profile.workingDirectory);
  };

  const handleOpenExternal = (app: ExternalApp) => {
    window.api.openExternal(app.command, profile.workingDirectory);
  };

  // Order on the bar:
  //   Tabs: Agent(0) Files(1) Kanban(2) | Terminal(3) Git(4) | Mic Folder(5) | external apps(6+)
  // Nav indices skip the dictation button (it has its own Ctrl+Shift+D shortcut).
  const extStart = 6;

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
          className={`${actionBtnCls} ${shellOpen ? 'action-btn-active' : ''}`}
          onClick={onToggleShell}
          title="Toggle terminal"
        >
          <NavNum active={navActive} idx={3} />
          <svg {...ICON_PROPS}>
            <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
            <polyline points="4.5 7 6.5 9 4.5 11" />
            <line x1="8" y1="11" x2="11" y2="11" />
          </svg>
          {showActionLabels && <span>Terminal</span>}
        </button>

        <button
          className={`${actionBtnCls} ${gitActive ? 'action-btn-active' : ''}`}
          onClick={onToggleGit}
          title="Git"
        >
          <NavNum active={navActive} idx={4} />
          <svg {...ICON_PROPS}>
            {/* Two branches joined at a commit dot — same shape as the
                external `gitBranch` icon, kept inline for stroke parity. */}
            <circle cx="4" cy="3.5" r="1.4" />
            <circle cx="4" cy="12.5" r="1.4" />
            <circle cx="12" cy="6" r="1.4" />
            <line x1="4" y1="4.9" x2="4" y2="11.1" />
            <path d="M12 7.4v.6a3 3 0 0 1-3 3H7" />
          </svg>
          {showActionLabels && <span>Git</span>}
        </button>

        {dictationSupported && (
          <button
            className={`${actionBtnCls} ${dictationListening ? 'dictation-active' : ''}`}
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
            {/* Live status badges (interim transcript / Listening pulse) stay
                visible in icon-only mode — they're functional state, not a
                button label. The plain "Mic" caption is the only thing that
                hides when labels are off. */}
            {dictationListening && dictationInterim && (
              <span className="dictation-interim">{dictationInterim}</span>
            )}
            {!dictationListening && showActionLabels && <span>Mic</span>}
            {dictationListening && !dictationInterim && <span className="dictation-pulse">Listening...</span>}
          </button>
        )}
        <button className={actionBtnCls} onClick={handleOpenFolder} title="Open in Finder">
          <NavNum active={navActive} idx={5} />
          <svg {...ICON_PROPS}>
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />
          </svg>
          {showActionLabels && <span>Folder</span>}
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
