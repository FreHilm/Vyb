import React, { useEffect, useRef, useState } from 'react';
import { Profile, ExternalApp } from '../../shared/types';
import { APP_ICONS } from '../icons';
import { NavBadge } from './KeyNav';

export type CommandBarTab = 'agent' | 'files' | 'kanban' | 'web';

interface CommandBarProps {
  profile: Profile | null;
  /** Directory for folder/external-app actions — the selected session's
   * worktree when one is active, else the profile's directory. */
  workingDirectory: string;
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
  /** Whether split-view (agent left + files/kanban right) is on for the
   * current profile. When true, the Agent tab is rendered as a permanent
   * left-pane indicator (always "selected"), and tapping Files/Kanban
   * switches the right pane instead of replacing the agent. */
  splitActive: boolean;
  onToggleSplit: () => void;
  /** Width % of the agent pane in split mode — drives the grid template
   * so the Files/Kanban tab cluster lands flush above the right pane. */
  agentSplitPercent: number;
  /** Feature flags from Settings → Functions. Disabled tabs are hidden. */
  kanbanEnabled: boolean;
  webEnabled: boolean;
  externalApps: ExternalApp[];
  /** Whether the active Files view is in changed-only ("Changes") mode —
   * drives the Files tab caption and the switcher dropdown. */
  filesShowChanges: boolean;
  onSetFilesShowChanges: (next: boolean) => void;
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
  workingDirectory,
  shellOpen,
  activeTab,
  onSelectTab,
  onToggleShell,
  onToggleGit,
  gitActive,
  splitActive,
  onToggleSplit,
  agentSplitPercent,
  kanbanEnabled,
  webEnabled,
  externalApps,
  filesShowChanges,
  onSetFilesShowChanges,
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
  // External-apps dropdown (collapses the per-app buttons into one icon
  // to save toolbar space). Closes on outside-click / Escape.
  const [appsOpen, setAppsOpen] = useState(false);
  const appsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!appsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (appsRef.current && !appsRef.current.contains(e.target as Node)) setAppsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAppsOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [appsOpen]);

  // Files-tab "Files ▾ / Changes" switcher dropdown.
  const [filesMenuOpen, setFilesMenuOpen] = useState(false);
  const filesMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filesMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filesMenuRef.current && !filesMenuRef.current.contains(e.target as Node)) setFilesMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFilesMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [filesMenuOpen]);

  // Compact icon-only buttons get a modifier class so CSS can shrink the
  // horizontal padding (otherwise they'd look weirdly wide for a 16px icon).
  const actionBtnCls = showActionLabels ? 'action-btn' : 'action-btn action-btn-icon';
  if (!profile) return <div className="command-bar" />;

  const handleOpenFolder = () => {
    window.api.openInFinder(workingDirectory || profile.workingDirectory);
  };

  const handleOpenExternal = (app: ExternalApp) => {
    window.api.openExternal(app.command, workingDirectory || profile.workingDirectory);
  };

  // Nav-badge indices MUST match App.tsx `navActions` order exactly, which
  // skips Kanban/Web when their feature flag is off:
  //   Agent(0) Files(1) [Kanban] [Web] Terminal Git Folder
  // (dictation has its own Ctrl+Shift+D; external apps are mouse-only in
  // the Apps dropdown). Computed here so the badges never drift from the
  // actions when a tab is hidden.
  let navIdx = 2;
  const kanbanNav = kanbanEnabled ? navIdx++ : -1;
  const webNav = webEnabled ? navIdx++ : -1;
  const terminalNav = navIdx++;
  const gitNav = navIdx++;
  const folderNav = navIdx++;

  const agentTabButton = (
    <button
      className={`command-bar-tab ${activeTab === 'agent' || splitActive ? 'command-bar-tab-active' : ''}`}
      onClick={() => onSelectTab('agent')}
      title={splitActive ? 'Agent pane (pinned left while split-view is on)' : 'Show the agent terminal'}
    >
      <NavNum active={navActive} idx={0} />
      <svg {...ICON_PROPS}>
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
        <polyline points="4.5 7 6.5 9 4.5 11" />
        <line x1="8" y1="11" x2="11" y2="11" />
      </svg>
      <span>Agent</span>
      {/* Embedded split-view toggle — same pattern as the Files button's
          ▾ caret, so it never moves when split is toggled. */}
      <span
        className={`command-bar-tab-caret command-bar-tab-split${splitActive ? ' is-active' : ''}`}
        role="button"
        tabIndex={-1}
        title={splitActive
          ? 'Exit split view (show only the agent)'
          : 'Split view: agent on the left, Files/Kanban on the right'}
        aria-pressed={splitActive}
        onClick={(e) => { e.stopPropagation(); onToggleSplit(); }}
      >
        {/* Icon shows the layout the click will produce: two panes to
            enter split, one full-width rectangle to leave it. */}
        {splitActive ? (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="3" width="13" height="10" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="3" width="5.5" height="10" rx="1" />
            <rect x="9" y="3" width="5.5" height="10" rx="1" />
          </svg>
        )}
      </span>
    </button>
  );
  const filesTabButton = (
    <div className="command-bar-tab-wrap" ref={filesMenuRef}>
      <button
        className={`command-bar-tab ${activeTab === 'files' ? 'command-bar-tab-active' : ''}`}
        onClick={() => onSelectTab('files')}
        title={filesShowChanges ? 'Changed files only' : 'File explorer'}
      >
        <NavNum active={navActive} idx={1} />
        <svg {...ICON_PROPS}>
          <path d="M9 2H5A1.5 1.5 0 0 0 3.5 3.5v9A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V5.5L9 2Z" />
          <path d="M9 2v3.5h3.5" />
        </svg>
        <span>{filesShowChanges ? 'Changes' : 'Files'}</span>
        <span
          className="command-bar-tab-caret"
          role="button"
          tabIndex={-1}
          title="Switch Files / Changes"
          aria-haspopup="menu"
          aria-expanded={filesMenuOpen}
          onClick={(e) => { e.stopPropagation(); setFilesMenuOpen((o) => !o); }}
        >▾</span>
      </button>
      {filesMenuOpen && (
        <div className="command-bar-tab-menu" role="menu">
          <button
            role="menuitem"
            className={!filesShowChanges ? 'is-active' : ''}
            onClick={() => { setFilesMenuOpen(false); onSelectTab('files'); onSetFilesShowChanges(false); }}
          >Files</button>
          <button
            role="menuitem"
            className={filesShowChanges ? 'is-active' : ''}
            onClick={() => { setFilesMenuOpen(false); onSelectTab('files'); onSetFilesShowChanges(true); }}
          >Changes</button>
        </div>
      )}
    </div>
  );
  const kanbanTabButton = kanbanEnabled ? (
    <button
      className={`command-bar-tab ${activeTab === 'kanban' ? 'command-bar-tab-active' : ''}`}
      onClick={() => onSelectTab('kanban')}
      title="Kanban (Ordna)"
    >
      <NavNum active={navActive} idx={kanbanNav} />
      <svg {...ICON_PROPS}>
        <rect x="2" y="3" width="3.2" height="10" rx="0.5" />
        <rect x="6.4" y="3" width="3.2" height="7" rx="0.5" />
        <rect x="10.8" y="3" width="3.2" height="4" rx="0.5" />
      </svg>
      <span>Kanban</span>
    </button>
  ) : null;
  const webTabButton = webEnabled ? (
    <button
      className={`command-bar-tab ${activeTab === 'web' ? 'command-bar-tab-active' : ''}`}
      onClick={() => onSelectTab('web')}
      title="In-app browser"
    >
      <NavNum active={navActive} idx={webNav} />
      <svg {...ICON_PROPS}>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M1.8 8h12.4" />
        <path d="M8 1.8c2 2 3 4 3 6.2s-1 4.2-3 6.2c-2-2-3-4-3-6.2s1-4.2 3-6.2z" />
      </svg>
      <span>Web</span>
    </button>
  ) : null;
  return (
    <div
      className={`command-bar${splitActive ? ' command-bar-split' : ''}`}
      style={
        splitActive
          ? ({ ['--agent-split-pct' as string]: `${agentSplitPercent}%` } as React.CSSProperties)
          : undefined
      }
    >
      {splitActive ? (
        <>
          <div className="command-bar-tabs command-bar-tabs-left">
            {agentTabButton}
          </div>
          <div className="command-bar-tabs command-bar-tabs-right">
            {filesTabButton}
            {kanbanTabButton}
            {webTabButton}
          </div>
        </>
      ) : (
        <div className="command-bar-tabs">
          {agentTabButton}
          {filesTabButton}
          {kanbanTabButton}
          {webTabButton}
        </div>
      )}
      <div className="command-bar-actions">
        <button
          className={`${actionBtnCls} ${shellOpen ? 'action-btn-active' : ''}`}
          onClick={onToggleShell}
          title="Toggle terminal"
        >
          <NavNum active={navActive} idx={terminalNav} />
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
          <NavNum active={navActive} idx={gitNav} />
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
          <NavNum active={navActive} idx={folderNav} />
          <svg {...ICON_PROPS}>
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />
          </svg>
          {showActionLabels && <span>Folder</span>}
        </button>

        {externalApps.length > 0 && <div className="command-bar-separator" />}

        {externalApps.length > 0 && (
          <div className="apps-menu" ref={appsRef}>
            <button
              className={`${actionBtnCls}${appsOpen ? ' is-active' : ''}`}
              onClick={() => setAppsOpen((o) => !o)}
              title="Open in external app"
              aria-haspopup="menu"
              aria-expanded={appsOpen}
            >
              {/* App-launcher grid icon */}
              <svg {...ICON_PROPS}>
                <rect x="2" y="2" width="4.5" height="4.5" rx="1" />
                <rect x="9.5" y="2" width="4.5" height="4.5" rx="1" />
                <rect x="2" y="9.5" width="4.5" height="4.5" rx="1" />
                <rect x="9.5" y="9.5" width="4.5" height="4.5" rx="1" />
              </svg>
              {showActionLabels && <span>Apps</span>}
            </button>
            {appsOpen && (
              <div className="apps-menu-dropdown" role="menu">
                {externalApps.map((app) => {
                  const iconContent = APP_ICONS[app.icon] || APP_ICONS['file'];
                  return (
                    <button
                      key={app.id}
                      className="apps-menu-item"
                      role="menuitem"
                      onClick={() => { handleOpenExternal(app); setAppsOpen(false); }}
                      title={`Open in ${app.name}`}
                    >
                      <svg {...ICON_PROPS} dangerouslySetInnerHTML={{ __html: iconContent }} />
                      <span>{app.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
