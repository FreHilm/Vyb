import { Profile, AgentStatus } from '../../shared/types';

interface ProfileItemProps {
  profile: Profile;
  isActive: boolean;
  status: AgentStatus;
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
  onClick,
  onEdit,
}: ProfileItemProps) {
  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit();
  };

  return (
    <div
      className={`profile-item ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <div className="profile-icon">
        {profile.icon ? (
          <img src={`local-file://${profile.icon}`} alt={profile.name} />
        ) : (
          <div className="profile-icon-placeholder">
            {profile.name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      <div className="profile-info">
        <div className="profile-name">{profile.name}</div>
        <div className="profile-status-label">{STATUS_LABELS[status]}</div>
      </div>
      <button
        className="edit-profile-btn"
        onClick={handleEdit}
        title="Edit profile"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M9.1.9a1.5 1.5 0 012.1 2.1L4 10.2 0 12l1.8-4L9.1.9z" />
        </svg>
      </button>
      <div
        className="status-dot"
        style={{ backgroundColor: STATUS_COLORS[status] }}
        title={STATUS_LABELS[status]}
      />
    </div>
  );
}
