import { useEffect, useState, useRef, useCallback } from 'react';
import { GitStatus, Profile } from '../../shared/types';

interface StatusBarProps {
  profile: Profile | null;
  onToggleChanges?: () => void;
  /** Click handler for the branch label — opens the git tree view. */
  onBranchClick?: () => void;
}

const POLL_INTERVAL = 10000; // 10 seconds

export function StatusBar({ profile, onToggleChanges, onBranchClick }: StatusBarProps) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [fetching, setFetching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!profile) {
      setGit(null);
      return;
    }

    const fetch = () => {
      window.api.getGitStatus(profile.workingDirectory).then(setGit);
    };

    fetch();
    timerRef.current = setInterval(fetch, POLL_INTERVAL);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [profile?.id, profile?.workingDirectory]);

  const handleFetch = useCallback(async () => {
    if (!profile || fetching) return;
    setFetching(true);
    try {
      await window.api.gitFetch(profile.workingDirectory);
      const updated = await window.api.getGitStatus(profile.workingDirectory);
      setGit(updated);
    } finally {
      setFetching(false);
    }
  }, [profile, fetching]);

  if (!profile) return <div className="status-bar" />;

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {git?.lastCommit && (
          <span className="status-item status-commit" title="Last commit">
            {git.lastCommit.length > 50
              ? git.lastCommit.slice(0, 50) + '...'
              : git.lastCommit}
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {git?.isGit && (
          <>
            {onBranchClick ? (
              <button
                className="status-item status-branch status-branch-btn"
                title="Open git tree"
                onClick={onBranchClick}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6c0 .73-.593 1.25-1.25 1.25H8.25a.75.75 0 00-.75.75v1.378a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836l.015-.008A2.24 2.24 0 018.25 7h3c.14 0 .25-.11.25-.25v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
                </svg>
                {git.branch}
              </button>
            ) : (
              <span className="status-item status-branch" title="Branch">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6c0 .73-.593 1.25-1.25 1.25H8.25a.75.75 0 00-.75.75v1.378a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836l.015-.008A2.24 2.24 0 018.25 7h3c.14 0 .25-.11.25-.25v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
                </svg>
                {git.branch}
              </span>
            )}
            {(git.staged > 0 || git.modified > 0 || git.untracked > 0) && onToggleChanges && (
              <button
                className="status-item status-changes-btn"
                onClick={onToggleChanges}
                title={`${git.staged + git.modified + git.untracked} changed files (${git.staged} staged, ${git.modified} modified, ${git.untracked} untracked) — click to view`}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4 2h5l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1zm4.5 0v3.5H12M5 7h6M5 9h6M5 11h4" stroke="currentColor" strokeWidth="0.5" fill="none" />
                  <circle cx="13" cy="3" r="2.5" fill="var(--c-yellow)" />
                  <text x="13" y="4.5" textAnchor="middle" fontSize="3.5" fill="var(--c-base)" fontWeight="bold">
                    {git.staged + git.modified + git.untracked}
                  </text>
                </svg>
                <span className="status-changes-count">{git.staged + git.modified + git.untracked}</span>
              </button>
            )}
            {(git.ahead > 0 || git.behind > 0) && (
              <span className="status-item status-sync" title={`${git.ahead} ahead, ${git.behind} behind`}>
                {git.ahead > 0 && <span>&#x2191;{git.ahead}</span>}
                {git.behind > 0 && <span>&#x2193;{git.behind}</span>}
              </span>
            )}
            <button
              className={`status-item status-fetch ${fetching ? 'status-fetching' : ''}`}
              onClick={handleFetch}
              disabled={fetching}
              title="Fetch from origin"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2.5a5.5 5.5 0 00-4.75 8.26l-1.3.75A7 7 0 1115 8h-1.5A5.5 5.5 0 008 2.5z" />
                <path d="M15 4v4h-4l1.5-1.5L11 5z" />
              </svg>
            </button>
            {git.stashes > 0 && (
              <span className="status-item status-stash" title={`${git.stashes} stash${git.stashes > 1 ? 'es' : ''}`}>
                &#x2691;{git.stashes}
              </span>
            )}
            {git.remoteUrl && (
              <button
                className="status-item status-remote"
                onClick={() => window.api.openUrl(git.remoteUrl)}
                title={git.remoteUrl}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z" />
                  <path d="M8 2.5C6.3 2.5 5 5 5 8s1.3 5.5 3 5.5 3-2.5 3-5.5S9.7 2.5 8 2.5zM2 8h12" />
                </svg>
                {git.remoteUrl.includes('github.com')
                  ? 'GitHub'
                  : git.remoteUrl.includes('gitlab')
                    ? 'GitLab'
                    : git.remoteUrl.includes('bitbucket')
                      ? 'Bitbucket'
                      : 'Remote'}
              </button>
            )}
          </>
        )}
        {git && !git.isGit && (
          <span className="status-item status-no-git">No git</span>
        )}
      </div>
    </div>
  );
}
