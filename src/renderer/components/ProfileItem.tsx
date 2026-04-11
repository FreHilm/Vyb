import { Profile, AgentStatus } from '../../shared/types';

interface ProfileItemProps {
  profile: Profile;
  isActive: boolean;
  status: AgentStatus;
  hasUpdate: boolean;
  iconRevision: number;
  onClick: () => void;
  onEdit: () => void;
}

const STATUS_COLORS: Record<AgentStatus, string> = {
  ready: '#22c55e',
  working: '#3b82f6',
  'needs-input': '#eab308',
  offline: '#6b7280',
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  ready: 'Ready',
  working: 'Working',
  'needs-input': 'Needs Input',
  offline: 'Offline',
};

export function ProfileItem({
  profile,
  isActive,
  status,
  hasUpdate,
  iconRevision,
  onClick,
  onEdit,
}: ProfileItemProps) {
  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit();
  };

  const updateStyle = hasUpdate && !isActive
    ? {
        '--update-color': STATUS_COLORS[status],
        '--update-bg': STATUS_COLORS[status] + '14',
      } as React.CSSProperties
    : undefined;

  return (
    <div
      className={`profile-item ${isActive ? 'active' : ''} ${hasUpdate && !isActive ? 'has-update' : ''}`}
      style={updateStyle}
      onClick={onClick}
      title={profile.name}
    >
      <div className="profile-icon">
        {profile.icon ? (
          <img src={`local-file://${profile.icon}?v=${iconRevision}`} alt={profile.name} />
        ) : (
          <div className="profile-icon-placeholder">
            {profile.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div
          className={`status-badge ${status === 'working' ? 'working' : ''}`}
          style={{
            backgroundColor: STATUS_COLORS[status],
            color: STATUS_COLORS[status],
          }}
          title={STATUS_LABELS[status]}
        />
        <button
          className="edit-badge"
          onClick={handleEdit}
          title="Edit profile"
        >
          <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
            <path d="M9.1.9a1.5 1.5 0 012.1 2.1L4 10.2 0 12l1.8-4L9.1.9z" />
          </svg>
        </button>
      </div>
      <div className="profile-info">
        <span className="profile-name">{profile.name}</span>
      </div>
    </div>
  );
}
