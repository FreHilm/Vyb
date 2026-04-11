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
          <svg viewBox="0 0 24 60" preserveAspectRatio="none" fill="none">
            <rect className="flame-base" x="0" y="0" width="3" height="60" />
            <path className="flame flame-1" d="M3 2 L10 5 L6 9 L14 12 L5 16 L12 19 L7 23 L11 26 L3 30z" />
            <path className="flame flame-2" d="M3 12 L18 16 L8 20 L16 25 L6 29 L13 33 L3 38z" />
            <path className="flame flame-3" d="M3 28 L12 31 L7 35 L17 38 L9 42 L14 46 L5 50 L10 53 L3 56z" />
            <path className="flame flame-4" d="M3 0 L9 3 L5 6 L11 8 L3 12z" />
            <path className="flame flame-5" d="M3 48 L15 51 L8 54 L12 57 L3 60z" />
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
