import { useEffect, useState } from 'react';
import type { AgentSessionInfo, SessionCaps } from '../../shared/types';

// ── Agent session picker ──────────────────────────────────────────────
//
// Lists the past sessions a built-in agent has for the active project and
// lets the user start one (or a fresh session). When the profile's agent
// is already running, the chosen session spawns in its own git worktree;
// otherwise it starts in the profile's own terminal. The dialog only
// reports the choice — App owns the launch.
//
// `running` flips two things: the action verb ("Open in worktree" vs
// "Start"), and whether resuming an EXISTING session is allowed at all —
// agents whose caps say `canResumeInWorktree: false` (OpenCode) can only
// start a NEW session in a worktree, so existing rows are disabled.

export interface SessionPickerDialogProps {
  agentName: string;
  agentCommand: string;
  workingDirectory: string;
  /** Profile's agent already running → launches will use a worktree. */
  running: boolean;
  /** sessionId === null → start a new session. `label` titles the worktree. */
  onStart: (sessionId: string | null, label: string) => void;
  onClose: () => void;
}

function relTime(ms: number): string {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function SessionPickerDialog({
  agentName, agentCommand, workingDirectory, running, onStart, onClose,
}: SessionPickerDialogProps) {
  const [sessions, setSessions] = useState<AgentSessionInfo[] | null>(null);
  const [caps, setCaps] = useState<SessionCaps | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.api.listAgentSessions(agentCommand, workingDirectory)
      .then((r) => { if (!cancelled) { setSessions(r.sessions); setCaps(r.caps); } })
      .catch(() => { if (!cancelled) setError('Could not read sessions.'); });
    return () => { cancelled = true; };
  }, [agentCommand, workingDirectory]);

  // When running, an existing session can only be resumed in a worktree if
  // the agent supports it (OpenCode doesn't → new-session-only).
  const resumeBlocked = running && caps != null && !caps.canResumeInWorktree;
  const startVerb = running ? 'Open in worktree' : 'Start';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal session-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{agentName} sessions</h3>
        </div>
        <div className="modal-body">
          <div className="session-picker-hint">
            {running
              ? 'This agent is already running — the chosen session opens in its own git worktree.'
              : 'Starts in this profile’s terminal.'}
          </div>

          <button className="session-row session-row-new" onClick={() => onStart(null, 'New session')}>
            <span className="session-new-plus">+</span>
            <span className="session-title">New session</span>
            <span className="session-start">{startVerb}</span>
          </button>

          {resumeBlocked && (
            <div className="session-picker-warn">
              Resuming an existing session in a new worktree isn’t supported for {agentName}. Start a new session instead.
            </div>
          )}

          <div className="session-list">
            {sessions === null && !error && <div className="session-empty">Loading…</div>}
            {error && <div className="session-picker-warn">{error}</div>}
            {sessions !== null && sessions.length === 0 && !error && (
              <div className="session-empty">No past sessions for this project.</div>
            )}
            {sessions?.map((s) => (
              <button
                key={s.id}
                className="session-row"
                disabled={resumeBlocked}
                title={resumeBlocked ? 'Not supported in a worktree for this agent' : s.title}
                onClick={() => onStart(s.id, s.title)}
              >
                <span className="session-title">{s.title}</span>
                <span className="session-time">{relTime(s.lastActive)}</span>
                <span className="session-start">{startVerb}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
