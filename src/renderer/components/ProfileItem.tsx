import { useEffect, useState, useRef } from 'react';
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
  const [bouncing, setBouncing] = useState(false);
  const prevActiveRef = useRef(isActive);

  useEffect(() => {
    if (isActive && !prevActiveRef.current) {
      setBouncing(true);
      const timer = setTimeout(() => setBouncing(false), 600);
      return () => clearTimeout(timer);
    }
    prevActiveRef.current = isActive;
  }, [isActive]);

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit();
  };

  const isAnimated = status === 'working' || status === 'needs-input';
  const isCalm = status === 'ready';

  const itemStyle: React.CSSProperties | undefined =
    hasUpdate && !isActive
      ? {
          '--update-color': STATUS_COLORS[status],
          '--update-bg': STATUS_COLORS[status] + '14',
        } as React.CSSProperties
      : isActive && (isAnimated || isCalm)
        ? { '--flame-color': STATUS_COLORS[status] } as React.CSSProperties
        : undefined;

  return (
    <div
      className={`profile-item ${isActive ? 'active' : ''} ${hasUpdate && !isActive ? 'has-update' : ''} ${isActive && (isAnimated || isCalm) ? 'active-working' : ''}`}
      style={itemStyle}
      onClick={onClick}
      title={profile.name}
    >
      {isActive && (
        <div
          className={`flame-indicator ${isAnimated ? 'flame-animated' : isCalm ? 'flame-calm' : ''}`}
          style={{ '--flame-color': STATUS_COLORS[status] } as React.CSSProperties}
        >
          <svg viewBox="0 0 20 60" preserveAspectRatio="none" fill="none">
            <rect className="flame-base" x="0" y="0" width="4" height="60" />
            <path className="flame flame-1" d="M4 5 Q12 10 8 15 Q14 20 6 25 Q10 30 4 35 L4 5z" />
            <path className="flame flame-2" d="M4 15 Q16 22 7 30 Q13 38 4 45 L4 15z" />
            <path className="flame flame-3" d="M4 0 Q10 8 7 12 Q12 18 5 22 Q9 26 4 30 L4 0z" />
            <path className="flame flame-4" d="M4 30 Q14 36 8 42 Q11 48 4 55 L4 30z" />
          </svg>
        </div>
      )}
      <div className={`profile-icon ${bouncing ? 'icon-bounce' : ''}`}>
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
