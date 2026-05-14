import { useCallback, useState } from 'react';
import type { GitCommit } from '../../shared/types';

// ── Interactive rebase dialog (T-033) ──────────────────────────────
//
// Drag-and-drop UI for picking the action + order of a range of
// commits. Submit serialises the rows into a todo list (oldest first)
// and hands them to the new `git:rebaseInteractive` IPC.
//
// V1 actions: pick / reword / edit / squash / fixup / drop. Reword
// silently keeps the original message (V2 will pair it with a Vyb
// message-edit dialog when the rebase stops). Squash/fixup use git's
// default combined message — no in-app editor yet.

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

interface RebaseRow {
  sha: string;
  shortSha: string;
  subject: string;
  action: RebaseAction;
}

const ACTION_LABELS: Record<RebaseAction, string> = {
  pick: 'pick',
  reword: 'reword',
  edit: 'edit',
  squash: 'squash',
  fixup: 'fixup',
  drop: 'drop',
};

const ACTION_HELP: Record<RebaseAction, string> = {
  pick: 'Keep this commit as-is.',
  reword: 'Keep changes, but stop to edit the message. (V1 keeps the original message.)',
  edit: 'Stop here so you can amend the commit before continuing.',
  squash: 'Combine into the previous pick; combined message uses git defaults.',
  fixup: 'Combine into the previous pick; drop this commit\'s message.',
  drop: 'Discard this commit entirely.',
};

export interface RebaseInteractiveDialogProps {
  /** Base SHA — the commit the user right-clicked. `commits` are the
   * range from this SHA (inclusive) to HEAD, oldest first. */
  base: string;
  /** Commits to rebase, oldest first. */
  commits: GitCommit[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (todoLines: string[]) => void | Promise<void>;
}

export function RebaseInteractiveDialog({ base, commits, busy, error, onCancel, onSubmit }: RebaseInteractiveDialogProps) {
  const [rows, setRows] = useState<RebaseRow[]>(() => commits.map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    subject: c.subject,
    action: 'pick' as RebaseAction,
  })));
  // Drag state — `draggingIdx` is the row being dragged, `overIdx` is
  // the row the cursor is currently over (drop target). Plain HTML5
  // DnD, same pattern Sidebar uses.
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const setAction = useCallback((idx: number, action: RebaseAction) => {
    setRows((prev) => prev.map((r, i) => i === idx ? { ...r, action } : r));
  }, []);

  const moveRow = useCallback((from: number, to: number) => {
    if (from === to) return;
    setRows((prev) => {
      const next = prev.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    // Refuse if every row is `drop` — that's `git rebase -i` with
    // nothing to do; git would barf.
    if (rows.every((r) => r.action === 'drop')) return;
    // Refuse if the first row is `squash` or `fixup` — they have no
    // preceding pick to fold into.
    if (rows[0]?.action === 'squash' || rows[0]?.action === 'fixup') return;
    const todoLines = rows.map((r) => `${r.action} ${r.sha} ${r.subject}`);
    onSubmit(todoLines);
  }, [rows, onSubmit]);

  const allDropped = rows.every((r) => r.action === 'drop');
  const firstIsSquash = rows[0]?.action === 'squash' || rows[0]?.action === 'fixup';

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal git-irebase-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Interactive rebase from <code>{base.slice(0, 7)}</code></h3>
        </div>
        <div className="modal-body git-irebase-body">
          <p className="field-hint" style={{ marginBottom: 8 }}>
            Drag rows to reorder. Pick an action per commit. Oldest at the top — git
            runs the list from top to bottom on top of the previous commit.
          </p>
          <div className="git-irebase-list">
            {rows.map((row, idx) => {
              const isDragging = draggingIdx === idx;
              const isOver = overIdx === idx && draggingIdx !== null && draggingIdx !== idx;
              return (
                <div
                  key={`${row.sha}:${idx}`}
                  className={`git-irebase-row git-irebase-row-${row.action}${isDragging ? ' is-dragging' : ''}${isOver ? ' is-over' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    setDraggingIdx(idx);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setOverIdx(idx);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggingIdx !== null) moveRow(draggingIdx, idx);
                    setDraggingIdx(null);
                    setOverIdx(null);
                  }}
                  onDragEnd={() => { setDraggingIdx(null); setOverIdx(null); }}
                >
                  <span className="git-irebase-handle" aria-hidden>⋮⋮</span>
                  <select
                    className="git-irebase-action"
                    value={row.action}
                    onChange={(e) => setAction(idx, e.target.value as RebaseAction)}
                    title={ACTION_HELP[row.action]}
                  >
                    {(Object.keys(ACTION_LABELS) as RebaseAction[]).map((a) => (
                      <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                    ))}
                  </select>
                  <code className="git-irebase-sha">{row.shortSha}</code>
                  <span className="git-irebase-subject" title={row.subject}>{row.subject}</span>
                </div>
              );
            })}
          </div>
          {allDropped && (
            <p style={{ fontSize: 12, color: 'var(--c-red)', marginTop: 8 }}>
              Refusing to submit — every commit is set to <code>drop</code>.
            </p>
          )}
          {firstIsSquash && !allDropped && (
            <p style={{ fontSize: 12, color: 'var(--c-red)', marginTop: 8 }}>
              The first row can't be <code>squash</code> or <code>fixup</code> — there's nothing before it to fold into.
            </p>
          )}
          {error && <p style={{ fontSize: 12, color: 'var(--c-red)', marginTop: 8 }}>{error}</p>}
        </div>
        <div className="modal-footer">
          <div className="modal-footer-right">
            <button className="cancel-btn" onClick={onCancel} disabled={busy}>Cancel</button>
            <button
              className="save-btn"
              onClick={handleSubmit}
              disabled={busy || allDropped || firstIsSquash}
              title="Run git rebase -i with the prepared todo list"
            >
              {busy ? 'Rebasing…' : 'Start rebase'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
