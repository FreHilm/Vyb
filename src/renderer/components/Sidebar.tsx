import { ProfileItem } from './ProfileItem';
import { Profile, AgentStatus } from '../../shared/types';

interface SidebarProps {
  profiles: Profile[];
  activeProfileId: string | null;
  statuses: Map<string, AgentStatus>;
  onSelectProfile: (profileId: string) => void;
  onEditProfile: (profile: Profile) => void;
  onAddProfile: () => void;
}

export function Sidebar({
  profiles,
  activeProfileId,
  statuses,
  onSelectProfile,
  onEditProfile,
  onAddProfile,
}: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h2>Agents</h2>
        <button
          className="add-profile-btn"
          onClick={onAddProfile}
          title="Add profile"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <path d="M7 0a1 1 0 011 1v5h5a1 1 0 110 2H8v5a1 1 0 11-2 0V8H1a1 1 0 010-2h5V1a1 1 0 011-1z" />
          </svg>
        </button>
      </div>
      <div className="sidebar-profiles">
        {profiles.map((profile) => (
          <ProfileItem
            key={profile.id}
            profile={profile}
            isActive={profile.id === activeProfileId}
            status={statuses.get(profile.id) || 'offline'}
            onClick={() => onSelectProfile(profile.id)}
            onEdit={() => onEditProfile(profile)}
          />
        ))}
        {profiles.length === 0 && (
          <div className="sidebar-empty" onClick={onAddProfile}>
            Click + to add an agent profile
          </div>
        )}
      </div>
    </div>
  );
}
