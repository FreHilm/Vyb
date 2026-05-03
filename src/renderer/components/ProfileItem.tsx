import { useEffect, useState, useRef } from 'react';
import { Profile, AgentStatus } from '../../shared/types';

// Agent icons — same definitions as ProfileEditor/SettingsDialog
const AGENT_ICON_DEFS: Record<string, { viewBox: string; paths: string[]; color: string; stroke?: boolean }> = {
  claude: { viewBox: '0 0 16 16', color: '#d97757', stroke: true, paths: ['M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.4 3.4l2.8 2.8M9.8 9.8l2.8 2.8M12.6 3.4l-2.8 2.8M6.2 9.8l-2.8 2.8'] },
  codex: { viewBox: '0 0 16 16', color: '#10a37f', paths: ['M8 1L2.5 4.5v7L8 15l5.5-3.5v-7L8 1zm0 2.5L11 5.5v2L8 9.5 5 7.5v-2L8 3.5z'] },
  gemini: { viewBox: '0 0 16 16', color: '#4285f4', paths: ['M8 0C8 4.4 4.4 8 0 8c4.4 0 8 3.6 8 8 0-4.4 3.6-8 8-8-4.4 0-8-3.6-8-8z'] },
  opencode: { viewBox: '0 0 16 16', color: '#fbbf24', stroke: true, paths: ['M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4M9.2 3 6.8 13'] },
};

function SmallAgentIcon({ agentId }: { agentId?: string }) {
  if (!agentId) return null;
  const icon = AGENT_ICON_DEFS[agentId];
  if (!icon) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="var(--c-overlay0)">
        <circle cx="8" cy="8" r="5" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox={icon.viewBox}
      fill={icon.stroke ? 'none' : icon.color}
      stroke={icon.stroke ? icon.color : 'none'}
      strokeWidth={icon.stroke ? '2' : '0'}
      strokeLinecap="round"
    >
      {icon.paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

interface ProfileItemProps {
  profile: Profile;
  isActive: boolean;
  status: AgentStatus;
  hasUpdate: boolean;
  iconRevision: number;
  isRunning: boolean;
  showAgentBadge: boolean;
  onClick: () => void;
  onEdit: () => void;
  onStop: () => void;
  onReload: () => void;
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
  isRunning,
  showAgentBadge,
  onClick,
  onEdit,
  onStop,
  onReload,
}: ProfileItemProps) {
  const [bouncing, setBouncing] = useState(false);
  const [pendingAction, setPendingAction] = useState<'reload' | 'stop' | null>(null);
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
      ? ({ '--update-color': STATUS_COLORS[status] } as React.CSSProperties)
      : isActive && (isAnimated || isCalm)
        ? ({ '--flame-color': STATUS_COLORS[status] } as React.CSSProperties)
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
            <path className="flame spike-1"  d="M3 0 L12 2 L3 5z" />
            <path className="flame spike-2"  d="M3 4 L7 6.5 L3 8z" />
            <path className="flame spike-3"  d="M3 7 L16 10 L3 14z" />
            <path className="flame spike-4"  d="M3 13 L9 15 L3 18z" />
            <path className="flame spike-5"  d="M3 17 L14 19.5 L3 23z" />
            <path className="flame spike-6"  d="M3 22 L8 24.5 L3 28z" />
            <path className="flame spike-7"  d="M3 26 L17 29.5 L3 33z" />
            <path className="flame spike-8"  d="M3 32 L11 35 L3 38z" />
            <path className="flame spike-9"  d="M3 37 L6 39 L3 42z" />
            <path className="flame spike-10" d="M3 40 L15 43 L3 47z" />
            <path className="flame spike-11" d="M3 46 L9 48.5 L3 52z" />
            <path className="flame spike-12" d="M3 50 L18 53 L3 57z" />
            <path className="flame spike-13" d="M3 56 L10 58 L3 60z" />
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
        {showAgentBadge && profile.agentId && (
          <div className="agent-badge" title={profile.agentId}>
            <SmallAgentIcon agentId={profile.agentId} />
          </div>
        )}
      </div>
      <div className="profile-info">
        <span className="profile-name">{profile.name}</span>
      </div>
      {hasUpdate && !isActive && (
        <div className="profile-update-indicator" title={STATUS_LABELS[status]}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 11V8a4 4 0 0 1 8 0v3l1.2 1.2H2.8L4 11Z" />
            <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
          </svg>
        </div>
      )}
      {isRunning && (
        <div className="profile-controls">
          <button
            className="profile-ctrl-btn profile-ctrl-reload"
            onClick={(e) => { e.stopPropagation(); setPendingAction('reload'); }}
            title="Reload agent"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
              <polyline points="13 3 13 6 10 6" />
              <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
              <polyline points="3 13 3 10 6 10" />
            </svg>
          </button>
          <button
            className="profile-ctrl-btn profile-ctrl-stop"
            onClick={(e) => { e.stopPropagation(); setPendingAction('stop'); }}
            title="Stop agent"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
            </svg>
          </button>
        </div>
      )}
      {pendingAction && (
        <div
          className="modal-overlay"
          onClick={(e) => { e.stopPropagation(); setPendingAction(null); }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{pendingAction === 'reload' ? 'Reload Agent' : 'Stop Agent'}</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                {pendingAction === 'reload' ? (
                  <>Reload <strong>{profile.name}</strong>? The current session will be terminated and a new one started.</>
                ) : (
                  <>Stop <strong>{profile.name}</strong>? The running session will be terminated.</>
                )}
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button
                  className="cancel-btn"
                  onClick={(e) => { e.stopPropagation(); setPendingAction(null); }}
                >
                  Cancel
                </button>
                <button
                  className="delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    const action = pendingAction;
                    setPendingAction(null);
                    if (action === 'reload') onReload();
                    else onStop();
                  }}
                >
                  {pendingAction === 'reload' ? 'Reload' : 'Stop'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
