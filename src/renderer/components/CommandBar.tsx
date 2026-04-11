import { Profile, ExternalApp } from '../../shared/types';
import { APP_ICONS } from '../icons';

interface CommandBarProps {
  profile: Profile | null;
  shellOpen: boolean;
  readmeVisible: boolean;
  onToggleShell: () => void;
  onToggleReadme: () => void;
  externalApps: ExternalApp[];
}

export function CommandBar({
  profile,
  shellOpen,
  readmeVisible,
  onToggleShell,
  onToggleReadme,
  externalApps,
}: CommandBarProps) {
  if (!profile) return <div className="command-bar" />;

  const handleOpenFolder = () => {
    window.api.openInFinder(profile.workingDirectory);
  };

  const handleOpenExternal = (app: ExternalApp) => {
    window.api.openExternal(app.command, profile.workingDirectory);
  };

  return (
    <div className="command-bar">
      <div className="command-bar-actions">
        <button
          className={`action-btn ${readmeVisible ? 'action-btn-active' : ''}`}
          onClick={onToggleReadme}
          title="Toggle README"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 2.5A1.5 1.5 0 012.5 1h3.204a1.5 1.5 0 011.06.44L8.122 2.8a.5.5 0 00.354.147H13.5A1.5 1.5 0 0115 4.5v8a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-10zM4 7a.5.5 0 000 1h8a.5.5 0 000-1H4zm0 2.5a.5.5 0 000 1h5a.5.5 0 000-1H4z" />
          </svg>
          <span>README</span>
        </button>
        <button
          className={`action-btn ${shellOpen ? 'action-btn-active' : ''}`}
          onClick={onToggleShell}
          title="Toggle terminal"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 3a1 1 0 011-1h12a1 1 0 011 1v10a1 1 0 01-1 1H2a1 1 0 01-1-1V3zm1.5 1.5v8h11v-8h-11zM4 7l2.5 2L4 11v-4z" />
          </svg>
          <span>Terminal</span>
        </button>
        <button className="action-btn" onClick={handleOpenFolder} title="Open in Finder">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 1A1.5 1.5 0 000 2.5v11A1.5 1.5 0 001.5 15h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0014.5 4H7.71L6.85 2.15A1.5 1.5 0 005.57 1.5H1.5z" />
          </svg>
          <span>Folder</span>
        </button>

        {externalApps.length > 0 && <div className="command-bar-separator" />}

        {externalApps.map((app) => {
          const iconPath = APP_ICONS[app.icon] || APP_ICONS['file'];
          return (
            <button
              key={app.id}
              className="action-btn"
              onClick={() => handleOpenExternal(app)}
              title={`Open in ${app.name}`}
            >
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
