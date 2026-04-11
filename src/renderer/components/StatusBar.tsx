import { useEffect, useState, useRef } from 'react';
import { GitStatus, Profile } from '../../shared/types';

interface StatusBarProps {
  profile: Profile | null;
}

const POLL_INTERVAL = 10000; // 10 seconds

export function StatusBar({ profile }: StatusBarProps) {
  const [git, setGit] = useState<GitStatus | null>(null);
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
            <span className="status-item status-branch" title="Branch">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6c0 .73-.593 1.25-1.25 1.25H8.25a.75.75 0 00-.75.75v1.378a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836l.015-.008A2.24 2.24 0 018.25 7h3c.14 0 .25-.11.25-.25v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
              </svg>
              {git.branch}
            </span>
            {git.staged > 0 && (
              <span className="status-item status-staged" title={`${git.staged} staged`}>
                +{git.staged}
              </span>
            )}
            {git.modified > 0 && (
              <span className="status-item status-modified" title={`${git.modified} modified`}>
                ~{git.modified}
              </span>
            )}
            {git.untracked > 0 && (
              <span className="status-item status-untracked" title={`${git.untracked} untracked`}>
                ?{git.untracked}
              </span>
            )}
            {(git.ahead > 0 || git.behind > 0) && (
              <span className="status-item status-sync" title={`${git.ahead} ahead, ${git.behind} behind`}>
                {git.ahead > 0 && <span>&#x2191;{git.ahead}</span>}
                {git.behind > 0 && <span>&#x2193;{git.behind}</span>}
              </span>
            )}
            {git.stashes > 0 && (
              <span className="status-item status-stash" title={`${git.stashes} stash${git.stashes > 1 ? 'es' : ''}`}>
                &#x2691;{git.stashes}
              </span>
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
