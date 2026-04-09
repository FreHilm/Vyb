import { Profile } from '../../shared/types';

interface CommandBarProps {
  profile: Profile | null;
  shellOpen: boolean;
  onToggleShell: () => void;
}

export function CommandBar({ profile, shellOpen, onToggleShell }: CommandBarProps) {
  if (!profile) return <div className="command-bar" />;

  const handleOpenFolder = () => {
    window.api.openInFinder(profile.workingDirectory);
  };

  const handleOpenVSCode = () => {
    window.api.openInVSCode(profile.workingDirectory);
  };

  return (
    <div className="command-bar">
      <div className="command-bar-title">
        {profile.name}
        <span className="command-bar-path">{profile.workingDirectory}</span>
      </div>
      <div className="command-bar-actions">
        <button
          className={`action-btn ${shellOpen ? 'action-btn-active' : ''}`}
          onClick={onToggleShell}
          title="Toggle terminal"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M1 3a1 1 0 011-1h12a1 1 0 011 1v10a1 1 0 01-1 1H2a1 1 0 01-1-1V3zm1.5 1.5v8h11v-8h-11zM4 7l2.5 2L4 11v-4z" />
          </svg>
          <span>Terminal</span>
        </button>
        <button
          className="action-btn"
          onClick={handleOpenFolder}
          title="Open in Finder"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M1.5 1A1.5 1.5 0 000 2.5v11A1.5 1.5 0 001.5 15h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0014.5 4H7.71L6.85 2.15A1.5 1.5 0 005.57 1.5H1.5z" />
          </svg>
          <span>Folder</span>
        </button>
        <button
          className="action-btn"
          onClick={handleOpenVSCode}
          title="Open in VS Code"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M14.85 3.22l-3.07-1.56a.75.75 0 00-.82.12L5.43 7.17 2.93 5.31a.5.5 0 00-.64.03L1.11 6.45a.5.5 0 00-.01.72L3.52 8l-2.42 2.83a.5.5 0 00.01.72l1.18 1.11a.5.5 0 00.64.03l2.5-1.86 5.53 5.39a.75.75 0 00.82.12l3.07-1.56a.75.75 0 00.43-.68V3.9a.75.75 0 00-.43-.68zM11.25 11.55L7.33 8l3.92-3.55v7.1z" />
          </svg>
          <span>VS Code</span>
        </button>
      </div>
    </div>
  );
}
