// Shared right-click menu + ops state for git refs.
//
// Both the Branches tab (BranchTree) and the Tree tab (GitTree) right-click
// the same kinds of things — local branch / remote branch / tag / stash —
// and need the same operations: checkout, merge, rebase, push/pull,
// new branch from, rename, worktree, tracking, copy name, delete, plus
// stash apply/pop/drop and the stashes-header "save stash".
//
// This module owns:
//   • The menu-node shapes (LocalBranchNode etc.)
//   • The presentational <RefContextMenu /> component
//   • The `useGitRefOps` hook that holds dialog state, the handlers, and
//     returns the modal/banner/error JSX so callers just inline it.

import { useCallback, useState } from 'react';
import type { GitRef, GitStatus } from '../../shared/types';

// ── Node shapes ────────────────────────────────────────────────────

export interface LocalBranchNode {
  kind: 'localBranch';
  /** Leaf segment (just for label use). */
  name: string;
  /** Full branch name (e.g. "agent/T-005"). What `git checkout` takes. */
  fullName: string;
  sha: string;
  isHead: boolean;
}

export interface RemoteBranchNode {
  kind: 'remoteBranch';
  name: string;
  /** Remote name (e.g. "origin"). */
  remote: string;
  /** Branch name with the remote stripped — what `git push <remote> --delete <branch>` takes. */
  branch: string;
  /** Full ref name as git reports it (e.g. "origin/agent/T-005"). */
  fullName: string;
  sha: string;
}

export interface TagNode {
  kind: 'tag';
  name: string;
  fullName: string;
  sha: string;
}

export interface StashNode {
  kind: 'stash';
  index: number;
  ref: string;
  message: string;
  branch: string;
}

/** Pseudo-node passed when the user right-clicks the Stashes section
 * header itself (no specific stash selected) — surfaces "Save stash". */
export interface StashesSectionNode {
  kind: 'stashesSection';
}

/** Right-clicking a regular commit row in the graph. Carries enough to
 * dispatch checkout / merge / cherry-pick / revert / new branch / new
 * tag / reset / copy-SHA without re-loading data. */
export interface CommitNode {
  kind: 'commit';
  sha: string;
  shortSha: string;
  subject: string;
  /** True when this commit IS the current HEAD. Unlocks the Reword
   * action in the menu (only HEAD can be reworded via `commit --amend`
   * without an interactive rebase). */
  isHead?: boolean;
}

export type RefMenuNode =
  | LocalBranchNode
  | RemoteBranchNode
  | TagNode
  | StashNode
  | StashesSectionNode
  | CommitNode;

// ── Hook output: the callbacks the menu binds to ──────────────────

export interface RefOps {
  onCheckout: (target: string) => void;
  onMergeInto: (target: string) => void;
  onRebase: (ontoRef: string) => void;
  onStashApply: (ref: string) => void;
  onStashPop: (ref: string) => void;
  onStashSave: () => void;
  onDelete: (node: LocalBranchNode | RemoteBranchNode | TagNode | StashNode) => void;
  onCopyName: (name: string) => void;
  onNewBranch: (startPoint: string, defaultName: string) => void;
  onPushCurrent: () => void;
  onPullCurrent: () => void;
  onRename: (branch: string) => void;
  onWorktree: (branch: string) => void;
  onCreatePr: () => void;
  onTracking: (branch: string) => void;
  // Commit-level ops
  onNewTag: (commitRef: string, defaultName: string) => void;
  onCherryPick: (sha: string) => void;
  onRevert: (sha: string) => void;
  onReset: (sha: string) => void;
  /** Reword the HEAD commit's message. Only surfaced in the menu when
   * the right-clicked commit is HEAD. Optional so callers that don't
   * implement it (e.g. test harness) still type-check. */
  onReword?: (sha: string) => void;
}

// ── Menu component ────────────────────────────────────────────────

export interface RefContextMenuProps extends RefOps {
  x: number;
  y: number;
  node: RefMenuNode;
  currentBranch: string;
  /** Whether HEAD is a real branch (not detached). Disables ops that
   * require a branch context (merge into <current>, etc.). */
  onBranch: boolean;
  /** Called before each menu-item action runs so the caller can hide
   * the menu without each item having to wrap its own callback. */
  onClose?: () => void;
}

export function RefContextMenu(p: RefContextMenuProps) {
  const items = buildMenuItems(p);
  if (items.length === 0) return null;
  return (
    <div
      className="file-context-menu"
      style={{ left: p.x, top: p.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {items.map((it, idx) =>
        it.type === 'divider'
          ? <div key={idx} className="file-ctx-divider" />
          : (
            <button
              key={idx}
              className={`file-ctx-item ${it.danger ? 'file-ctx-item-danger' : ''}`}
              disabled={it.disabled}
              onClick={() => { p.onClose?.(); it.onClick(); }}
            >
              {it.label}
            </button>
          )
      )}
      {(p.node.kind === 'localBranch' || p.node.kind === 'remoteBranch') && p.onBranch && (
        <div className="file-ctx-hint">on {p.currentBranch}</div>
      )}
    </div>
  );
}

type MenuItem =
  | { type: 'item'; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }
  | { type: 'divider' };

function buildMenuItems(p: RefContextMenuProps): MenuItem[] {
  const { node, currentBranch, onBranch } = p;
  const items: MenuItem[] = [];

  if (node.kind === 'stashesSection') {
    items.push({ type: 'item', label: 'Save stash…', onClick: p.onStashSave });
    return items;
  }

  if (node.kind === 'localBranch') {
    const isCurrent = node.isHead || node.fullName === currentBranch;
    items.push({ type: 'item', label: `Checkout '${node.fullName}'`, onClick: () => p.onCheckout(node.fullName), disabled: isCurrent });
    items.push({ type: 'divider' });
    if (isCurrent) {
      items.push({ type: 'item', label: `Push '${node.fullName}' to origin`, onClick: p.onPushCurrent, disabled: !onBranch });
      items.push({ type: 'item', label: `Pull from origin into '${node.fullName}'`, onClick: p.onPullCurrent, disabled: !onBranch });
      items.push({ type: 'item', label: 'Create Pull Request…', onClick: p.onCreatePr, disabled: !onBranch });
    } else {
      items.push({ type: 'item', label: onBranch ? `Merge '${node.fullName}' into '${currentBranch}'` : 'Merge — checkout a branch first', onClick: () => p.onMergeInto(node.fullName), disabled: !onBranch });
      items.push({ type: 'item', label: onBranch ? `Rebase '${currentBranch}' onto '${node.fullName}'…` : 'Rebase — checkout a branch first', onClick: () => p.onRebase(node.fullName), disabled: !onBranch });
    }
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: `New branch from '${node.fullName}'…`, onClick: () => p.onNewBranch(node.fullName, '') });
    items.push({ type: 'item', label: 'Add as worktree…', onClick: () => p.onWorktree(node.fullName) });
    items.push({ type: 'item', label: 'Tracking…', onClick: () => p.onTracking(node.fullName) });
    items.push({ type: 'item', label: 'Rename…', onClick: () => p.onRename(node.fullName), disabled: isCurrent });
    items.push({ type: 'item', label: 'Copy branch name', onClick: () => p.onCopyName(node.fullName) });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: `Delete '${node.fullName}'…`, onClick: () => p.onDelete(node), disabled: isCurrent, danger: true });
    return items;
  }

  if (node.kind === 'remoteBranch') {
    items.push({ type: 'item', label: `Checkout '${node.fullName}'`, onClick: () => p.onCheckout(node.fullName) });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: onBranch ? `Merge '${node.fullName}' into '${currentBranch}'` : 'Merge — checkout a branch first', onClick: () => p.onMergeInto(node.fullName), disabled: !onBranch });
    items.push({ type: 'item', label: onBranch ? `Rebase '${currentBranch}' onto '${node.fullName}'…` : 'Rebase — checkout a branch first', onClick: () => p.onRebase(node.fullName), disabled: !onBranch });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: `New branch from '${node.fullName}'…`, onClick: () => p.onNewBranch(node.fullName, node.branch) });
    items.push({ type: 'item', label: 'Add as worktree…', onClick: () => p.onWorktree(node.fullName) });
    items.push({ type: 'item', label: 'Copy branch name', onClick: () => p.onCopyName(node.fullName) });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: `Delete '${node.fullName}' on ${node.remote}…`, onClick: () => p.onDelete(node), danger: true });
    return items;
  }

  if (node.kind === 'tag') {
    items.push({ type: 'item', label: `Checkout '${node.name}' (detached)`, onClick: () => p.onCheckout(node.name) });
    items.push({ type: 'item', label: 'Copy tag name', onClick: () => p.onCopyName(node.name) });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: `Delete tag '${node.name}'…`, onClick: () => p.onDelete(node), danger: true });
    return items;
  }

  if (node.kind === 'stash') {
    items.push({ type: 'item', label: `Apply ${node.ref}`, onClick: () => p.onStashApply(node.ref) });
    items.push({ type: 'item', label: `Pop ${node.ref} (apply + drop)`, onClick: () => p.onStashPop(node.ref) });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: `Drop ${node.ref}…`, onClick: () => p.onDelete(node), danger: true });
    return items;
  }

  if (node.kind === 'commit') {
    items.push({ type: 'item', label: `Checkout ${node.shortSha} (detached)`, onClick: () => p.onCheckout(node.sha) });
    items.push({ type: 'divider' });
    if (node.isHead && p.onReword) {
      items.push({ type: 'item', label: 'Reword commit message…', onClick: () => p.onReword!(node.sha) });
      items.push({ type: 'divider' });
    }
    items.push({ type: 'item', label: onBranch ? `Merge ${node.shortSha} into '${currentBranch}'` : 'Merge — checkout a branch first', onClick: () => p.onMergeInto(node.sha), disabled: !onBranch });
    items.push({ type: 'item', label: onBranch ? `Cherry-pick ${node.shortSha}` : 'Cherry-pick — checkout a branch first', onClick: () => p.onCherryPick(node.sha), disabled: !onBranch });
    items.push({ type: 'item', label: onBranch ? `Revert ${node.shortSha}…` : 'Revert — checkout a branch first', onClick: () => p.onRevert(node.sha), disabled: !onBranch });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: `New branch from ${node.shortSha}…`, onClick: () => p.onNewBranch(node.sha, '') });
    items.push({ type: 'item', label: `New tag at ${node.shortSha}…`, onClick: () => p.onNewTag(node.sha, '') });
    items.push({ type: 'divider' });
    items.push({ type: 'item', label: onBranch ? `Reset '${currentBranch}' to ${node.shortSha}…` : 'Reset — checkout a branch first', onClick: () => p.onReset(node.sha), disabled: !onBranch, danger: true });
    items.push({ type: 'item', label: 'Copy SHA', onClick: () => p.onCopyName(node.sha) });
    return items;
  }

  return items;
}

// ── Hook: own all dialog state + handlers, return ops + JSX ───────

export interface UseGitRefOpsArgs {
  workingDirectory: string;
  /** Called after every git op so the caller can refresh its data. */
  onAfterOp: () => void | Promise<void>;
  /** Existing remote refs — used by the Tracking dialog to populate
   * its upstream picker. */
  remotes: GitRef[];
  /** Status snapshot — drives the rebase banner. Optional; if absent
   * the banner just doesn't render. */
  status: GitStatus | null;
  /** Current branch name — used in dialog labels and the rebase banner. */
  currentBranch: string;
}

export interface UseGitRefOpsResult {
  ops: RefOps;
  modals: React.ReactNode;
  banner: React.ReactNode;
  errorBar: React.ReactNode;
}

interface DeleteDialogState {
  node: LocalBranchNode | RemoteBranchNode | TagNode | StashNode;
  forceFromError?: string;
}

export function useGitRefOps({
  workingDirectory, onAfterOp, remotes, status, currentBranch,
}: UseGitRefOpsArgs): UseGitRefOpsResult {
  // Generic op-error banner (one slot — newest wins).
  const [opError, setOpError] = useState<string | null>(null);

  // Dialogs.
  const [stashSaveOpen, setStashSaveOpen] = useState(false);
  const [stashSaveMessage, setStashSaveMessage] = useState('');
  const [newBranchDialog, setNewBranchDialog] = useState<{ startPoint: string; defaultName: string } | null>(null);
  const [newBranchName, setNewBranchName] = useState('');
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ branch: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [worktreeDialog, setWorktreeDialog] = useState<{ branch: string } | null>(null);
  const [worktreePath, setWorktreePath] = useState('');
  const [prDialog, setPrDialog] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prResultUrl, setPrResultUrl] = useState<string | null>(null);
  const [trackingDialog, setTrackingDialog] = useState<{ branch: string } | null>(null);
  const [confirmRebase, setConfirmRebase] = useState<{ ontoRef: string } | null>(null);
  // Commit-level dialogs.
  const [newTagDialog, setNewTagDialog] = useState<{ commitRef: string } | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagMessage, setNewTagMessage] = useState('');
  const [confirmCherryPick, setConfirmCherryPick] = useState<{ sha: string } | null>(null);
  const [confirmRevert, setConfirmRevert] = useState<{ sha: string } | null>(null);
  const [resetDialog, setResetDialog] = useState<{ sha: string; mode: 'soft' | 'mixed' | 'hard' } | null>(null);

  const onBranch = !!currentBranch && !/^[0-9a-f]{7,}$/i.test(currentBranch);

  // ── Op runners ────────────────────────────────────────────

  const runOp = useCallback(async (
    op: () => Promise<{ ok: boolean; message?: string }>,
    fallbackErr: string,
  ) => {
    const result = await op();
    if (!result.ok) setOpError(result.message ?? fallbackErr);
    await onAfterOp();
    return result;
  }, [onAfterOp]);

  const handleCheckout = useCallback(async (target: string) => {
    setOpError(null);
    const result = await window.api.gitCheckoutCommit(workingDirectory, target);
    if (!result.ok) {
      setOpError(
        result.error === 'dirty'
          ? 'Working tree has uncommitted changes — commit or stash first.'
          : result.error === 'failed'
            ? `Checkout failed: ${result.message ?? 'unknown error'}`
            : `Checkout failed (${result.error}).`,
      );
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleMergeInto = useCallback(async (sourceRef: string) => {
    setOpError(null);
    const result = await window.api.gitMerge(workingDirectory, sourceRef);
    if (!result.ok) {
      if (result.error === 'dirty') setOpError('Working tree has uncommitted changes — commit or stash first.');
      else if (result.error === 'detached') setOpError('Detached HEAD — checkout a branch first.');
      else if (result.error === 'self') setOpError('Cannot merge a branch into itself.');
      else if (result.error === 'conflict') {
        // Banner above the panel surfaces this.
      } else if (result.error === 'failed') {
        setOpError(result.message ?? 'Merge failed.');
      }
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleRebase = useCallback(async (ontoRef: string) => {
    setConfirmRebase(null);
    setOpError(null);
    const result = await window.api.gitRebase(workingDirectory, ontoRef);
    if (!result.ok) {
      if (result.error === 'dirty') setOpError('Working tree has uncommitted changes — commit or stash first.');
      else if (result.error === 'detached') setOpError('Detached HEAD — checkout a branch first.');
      else if (result.error === 'self') setOpError('Cannot rebase a branch onto itself.');
      else if (result.error === 'invalid') setOpError('Invalid branch name.');
      else if (result.error === 'conflict') {
        // Banner.
      } else if (result.error === 'failed') {
        setOpError(result.message ?? 'Rebase failed.');
      }
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleRebaseAbort = useCallback(async () => {
    await runOp(() => window.api.gitRebaseAbort(workingDirectory), 'rebase --abort failed');
  }, [workingDirectory, runOp]);

  const handleMergeAbort = useCallback(async () => {
    await runOp(() => window.api.gitMergeAbort(workingDirectory), 'merge --abort failed');
  }, [workingDirectory, runOp]);

  const handleRebaseContinue = useCallback(async () => {
    setOpError(null);
    const result = await window.api.gitRebaseContinue(workingDirectory);
    if (!result.ok && result.error !== 'conflict') {
      setOpError(result.message ?? 'rebase --continue failed');
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleStashSave = useCallback(async () => {
    setStashSaveOpen(false);
    await runOp(() => window.api.gitStashSave(workingDirectory, stashSaveMessage), 'stash failed');
    setStashSaveMessage('');
  }, [workingDirectory, stashSaveMessage, runOp]);

  const handleDeleteConfirm = useCallback(async (force: boolean) => {
    if (!deleteDialog) return;
    const node = deleteDialog.node;
    setDeleteDialog(null);
    let result: { ok: boolean; message?: string };
    if (node.kind === 'localBranch') {
      result = await window.api.gitDeleteBranch(workingDirectory, node.fullName, force);
      if (!result.ok && /not fully merged/i.test(result.message ?? '')) {
        setDeleteDialog({ node, forceFromError: result.message });
        return;
      }
    } else if (node.kind === 'remoteBranch') {
      result = await window.api.gitDeleteRemoteBranch(workingDirectory, node.remote, node.branch);
    } else if (node.kind === 'tag') {
      result = await window.api.gitDeleteTag(workingDirectory, node.name);
    } else {
      result = await window.api.gitStashDrop(workingDirectory, node.ref);
    }
    if (!result.ok) setOpError(result.message ?? 'delete failed');
    await onAfterOp();
  }, [deleteDialog, workingDirectory, onAfterOp]);

  const handleNewBranchSubmit = useCallback(async () => {
    if (!newBranchDialog || !newBranchName.trim()) return;
    const name = newBranchName.trim();
    const startPoint = newBranchDialog.startPoint;
    setNewBranchDialog(null);
    setNewBranchName('');
    await runOp(() => window.api.gitCreateBranch(workingDirectory, name, startPoint), 'create branch failed');
  }, [newBranchDialog, newBranchName, workingDirectory, runOp]);

  const handleRename = useCallback(async () => {
    if (!renameDialog || !renameValue.trim()) return;
    const oldName = renameDialog.branch;
    const newName = renameValue.trim();
    setRenameDialog(null);
    setRenameValue('');
    await runOp(() => window.api.gitRenameBranch(workingDirectory, oldName, newName), 'rename failed');
  }, [renameDialog, renameValue, workingDirectory, runOp]);

  const handleWorktreeBrowse = useCallback(async () => {
    const dir = await window.api.selectDirectory();
    if (dir) setWorktreePath(dir);
  }, []);

  const handleWorktreeSubmit = useCallback(async () => {
    if (!worktreeDialog || !worktreePath.trim()) return;
    const branch = worktreeDialog.branch;
    const wp = worktreePath.trim();
    setWorktreeDialog(null);
    setWorktreePath('');
    await runOp(() => window.api.gitAddWorktree(workingDirectory, wp, branch), 'worktree add failed');
  }, [worktreeDialog, worktreePath, workingDirectory, runOp]);

  const handleCreatePr = useCallback(async () => {
    setPrDialog(false);
    const title = prTitle;
    const body = prBody;
    setPrTitle('');
    setPrBody('');
    setOpError(null);
    const result = await window.api.gitCreatePr(workingDirectory, title, body);
    if (!result.ok) setOpError(result.message ?? 'PR creation failed');
    else if (result.url) setPrResultUrl(result.url);
    await onAfterOp();
  }, [prTitle, prBody, workingDirectory, onAfterOp]);

  const handleSetUpstream = useCallback(async (branch: string, upstream: string) => {
    setTrackingDialog(null);
    await runOp(() => window.api.gitSetUpstream(workingDirectory, branch, upstream), 'set upstream failed');
  }, [workingDirectory, runOp]);

  const handleUnsetUpstream = useCallback(async (branch: string) => {
    setTrackingDialog(null);
    await runOp(() => window.api.gitUnsetUpstream(workingDirectory, branch), 'unset upstream failed');
  }, [workingDirectory, runOp]);

  // ── Commit-level handlers ────────────────────────────────

  const handleNewTagSubmit = useCallback(async () => {
    if (!newTagDialog || !newTagName.trim()) return;
    const name = newTagName.trim();
    const ref = newTagDialog.commitRef;
    const message = newTagMessage;
    setNewTagDialog(null);
    setNewTagName('');
    setNewTagMessage('');
    await runOp(() => window.api.gitCreateTag(workingDirectory, name, ref, message), 'create tag failed');
  }, [newTagDialog, newTagName, newTagMessage, workingDirectory, runOp]);

  const handleCherryPick = useCallback(async (sha: string) => {
    setConfirmCherryPick(null);
    setOpError(null);
    const result = await window.api.gitCherryPick(workingDirectory, sha);
    if (!result.ok) {
      if (result.error === 'invalid') setOpError('Invalid commit SHA.');
      else if (result.error === 'conflict') {
        // Banner shows it.
      } else if (result.error === 'failed') setOpError(result.message ?? 'Cherry-pick failed.');
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleCherryPickAbort = useCallback(async () => {
    await runOp(() => window.api.gitCherryPickAbort(workingDirectory), 'cherry-pick --abort failed');
  }, [workingDirectory, runOp]);

  const handleCherryPickContinue = useCallback(async () => {
    setOpError(null);
    const result = await window.api.gitCherryPickContinue(workingDirectory);
    if (!result.ok && result.error !== 'conflict') {
      setOpError(result.message ?? 'cherry-pick --continue failed');
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleRevert = useCallback(async (sha: string) => {
    setConfirmRevert(null);
    setOpError(null);
    const result = await window.api.gitRevert(workingDirectory, sha);
    if (!result.ok) {
      if (result.error === 'invalid') setOpError('Invalid commit SHA.');
      else if (result.error === 'conflict') {
        // Banner shows it.
      } else if (result.error === 'failed') setOpError(result.message ?? 'Revert failed.');
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleRevertAbort = useCallback(async () => {
    await runOp(() => window.api.gitRevertAbort(workingDirectory), 'revert --abort failed');
  }, [workingDirectory, runOp]);

  const handleRevertContinue = useCallback(async () => {
    setOpError(null);
    const result = await window.api.gitRevertContinue(workingDirectory);
    if (!result.ok && result.error !== 'conflict') {
      setOpError(result.message ?? 'revert --continue failed');
    }
    await onAfterOp();
  }, [workingDirectory, onAfterOp]);

  const handleResetSubmit = useCallback(async () => {
    if (!resetDialog) return;
    const { sha, mode } = resetDialog;
    setResetDialog(null);
    await runOp(() => window.api.gitReset(workingDirectory, sha, mode), 'reset failed');
  }, [resetDialog, workingDirectory, runOp]);

  // ── Triggers exposed to the menu ──────────────────────────

  const ops: RefOps = {
    onCheckout: handleCheckout,
    onMergeInto: handleMergeInto,
    onRebase: (ontoRef) => setConfirmRebase({ ontoRef }),
    onStashApply: async (ref) => { await runOp(() => window.api.gitStashApply(workingDirectory, ref), 'apply failed'); },
    onStashPop: async (ref) => { await runOp(() => window.api.gitStashPop(workingDirectory, ref), 'pop failed'); },
    onStashSave: () => setStashSaveOpen(true),
    onDelete: (node) => setDeleteDialog({ node }),
    onCopyName: (name) => navigator.clipboard.writeText(name).catch((): void => undefined),
    onNewBranch: (startPoint, defaultName) => {
      setNewBranchDialog({ startPoint, defaultName });
      setNewBranchName(defaultName);
    },
    onPushCurrent: async () => { await runOp(() => window.api.gitPush(workingDirectory), 'push failed'); },
    onPullCurrent: async () => { await runOp(() => window.api.gitPull(workingDirectory), 'pull failed'); },
    onRename: (branch) => {
      setRenameDialog({ branch });
      setRenameValue(branch.split('/').pop() ?? branch);
    },
    onWorktree: (branch) => {
      setWorktreeDialog({ branch });
      const parent = workingDirectory.replace(/\/[^/]+$/, '');
      const repoName = workingDirectory.split('/').pop() ?? 'repo';
      const safeBranch = branch.replace(/[^A-Za-z0-9._-]/g, '-');
      setWorktreePath(`${parent}/${repoName}-${safeBranch}`);
    },
    onCreatePr: () => {
      setPrTitle('');
      setPrBody('');
      setPrDialog(true);
    },
    onTracking: (branch) => setTrackingDialog({ branch }),
    onNewTag: (commitRef) => {
      setNewTagDialog({ commitRef });
      setNewTagName('');
      setNewTagMessage('');
    },
    onCherryPick: (sha) => setConfirmCherryPick({ sha }),
    onRevert: (sha) => setConfirmRevert({ sha }),
    onReset: (sha) => setResetDialog({ sha, mode: 'mixed' }),
  };

  // ── Banner / error / modal JSX ────────────────────────────

  const errorBar = opError ? (
    <div className="git-tree-error">
      {opError}
      <button className="git-tree-error-close" onClick={() => setOpError(null)} aria-label="Dismiss">×</button>
    </div>
  ) : null;

  const banner = (
    <>
      {status?.mergeInProgress && (
        <div className="git-tree-merge-banner">
          <div className="git-tree-merge-banner-text">
            <strong>Merge in progress</strong>
            {status.mergeFromBranch && (
              <> — <code>{status.mergeFromBranch}</code> → <code>{status.branch}</code></>
            )}
            {status.conflictedFiles.length > 0 ? (
              <>
                {' '}— {status.conflictedFiles.length} file{status.conflictedFiles.length === 1 ? '' : 's'} in conflict.
                <div className="git-tree-merge-banner-files">
                  {status.conflictedFiles.slice(0, 5).map((f) => <code key={f}>{f}</code>)}
                  {status.conflictedFiles.length > 5 && (
                    <span className="git-tree-merge-banner-more">+{status.conflictedFiles.length - 5} more</span>
                  )}
                </div>
                <div className="git-tree-merge-banner-hint">Resolve in your shell, then <code>git commit</code>.</div>
              </>
            ) : (
              <> — finish with <code>git commit</code> in your shell.</>
            )}
          </div>
          <button className="git-tree-merge-banner-abort" onClick={handleMergeAbort}>Abort merge</button>
        </div>
      )}
      {status?.rebaseInProgress && (
        <div className="git-tree-merge-banner">
          <div className="git-tree-merge-banner-text">
            <strong>Rebase in progress</strong>
            {status.rebaseHeadName && status.rebaseOnto && (
              <> — <code>{status.rebaseHeadName}</code> onto <code>{status.rebaseOnto}</code></>
            )}
            {status.conflictedFiles.length > 0 ? (
              <>
                {' '}— {status.conflictedFiles.length} file{status.conflictedFiles.length === 1 ? '' : 's'} in conflict.
                <div className="git-tree-merge-banner-files">
                  {status.conflictedFiles.slice(0, 5).map((f) => <code key={f}>{f}</code>)}
                  {status.conflictedFiles.length > 5 && (
                    <span className="git-tree-merge-banner-more">+{status.conflictedFiles.length - 5} more</span>
                  )}
                </div>
                <div className="git-tree-merge-banner-hint">Resolve in your shell, <code>git add</code> the files, then click Continue.</div>
              </>
            ) : (
              <> — click Continue when ready, or Abort to roll back.</>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="git-tree-merge-banner-abort" onClick={handleRebaseAbort}>Abort rebase</button>
            <button className="git-tree-merge-banner-continue" onClick={handleRebaseContinue}>Continue</button>
          </div>
        </div>
      )}
      {status?.cherryPickInProgress && (
        <div className="git-tree-merge-banner">
          <div className="git-tree-merge-banner-text">
            <strong>Cherry-pick in progress</strong>
            {status.conflictedFiles.length > 0 ? (
              <>
                {' '}— {status.conflictedFiles.length} file{status.conflictedFiles.length === 1 ? '' : 's'} in conflict.
                <div className="git-tree-merge-banner-files">
                  {status.conflictedFiles.slice(0, 5).map((f) => <code key={f}>{f}</code>)}
                </div>
                <div className="git-tree-merge-banner-hint">Resolve in your shell, <code>git add</code>, then click Continue.</div>
              </>
            ) : (<> — click Continue when ready.</>)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="git-tree-merge-banner-abort" onClick={handleCherryPickAbort}>Abort</button>
            <button className="git-tree-merge-banner-continue" onClick={handleCherryPickContinue}>Continue</button>
          </div>
        </div>
      )}
      {status?.revertInProgress && (
        <div className="git-tree-merge-banner">
          <div className="git-tree-merge-banner-text">
            <strong>Revert in progress</strong>
            {status.conflictedFiles.length > 0 ? (
              <>
                {' '}— {status.conflictedFiles.length} file{status.conflictedFiles.length === 1 ? '' : 's'} in conflict.
                <div className="git-tree-merge-banner-files">
                  {status.conflictedFiles.slice(0, 5).map((f) => <code key={f}>{f}</code>)}
                </div>
                <div className="git-tree-merge-banner-hint">Resolve in your shell, <code>git add</code>, then click Continue.</div>
              </>
            ) : (<> — click Continue when ready.</>)}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="git-tree-merge-banner-abort" onClick={handleRevertAbort}>Abort</button>
            <button className="git-tree-merge-banner-continue" onClick={handleRevertContinue}>Continue</button>
          </div>
        </div>
      )}
    </>
  );

  const modals = (
    <>
      {stashSaveOpen && (
        <div className="modal-overlay" onClick={() => setStashSaveOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Save Stash</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                Stash your current working changes. Untracked files are included.
              </p>
              <input
                type="text"
                placeholder="Optional message"
                value={stashSaveMessage}
                onChange={(e) => setStashSaveMessage(e.target.value)}
                autoFocus
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 12 }}
              />
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setStashSaveOpen(false)}>Cancel</button>
                <button className="save-btn" onClick={handleStashSave}>Save Stash</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {newBranchDialog && (
        <div className="modal-overlay" onClick={() => setNewBranchDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>New Branch</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                Create a branch from <code>{newBranchDialog.startPoint}</code>.
              </p>
              <input
                type="text"
                placeholder="branch-name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleNewBranchSubmit(); } }}
                autoFocus
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 12 }}
              />
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setNewBranchDialog(null)}>Cancel</button>
                <button className="save-btn" disabled={!newBranchName.trim()} onClick={handleNewBranchSubmit}>Create</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteDialog && (
        <div className="modal-overlay" onClick={() => setDeleteDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Delete {labelForKind(deleteDialog.node.kind)}</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                {deleteDialog.node.kind === 'localBranch' && (<>Delete local branch <strong>{(deleteDialog.node as LocalBranchNode).fullName}</strong>?</>)}
                {deleteDialog.node.kind === 'remoteBranch' && (<>Delete remote branch <strong>{(deleteDialog.node as RemoteBranchNode).fullName}</strong> from <strong>{(deleteDialog.node as RemoteBranchNode).remote}</strong>? This pushes the deletion to the server and can&apos;t be undone here.</>)}
                {deleteDialog.node.kind === 'tag' && (<>Delete local tag <strong>{(deleteDialog.node as TagNode).name}</strong>?</>)}
                {deleteDialog.node.kind === 'stash' && (<>Drop <strong>{(deleteDialog.node as StashNode).ref}</strong>? This is permanent.</>)}
                {deleteDialog.forceFromError && (<><br /><br /><span style={{ color: 'var(--c-yellow)' }}>{deleteDialog.forceFromError}</span><br />Use <strong>Force delete</strong> to discard the unmerged commits.</>)}
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setDeleteDialog(null)}>Cancel</button>
                <button className="delete-btn" onClick={() => handleDeleteConfirm(!!deleteDialog.forceFromError)}>{deleteDialog.forceFromError ? 'Force delete' : 'Delete'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmRebase && (
        <div className="modal-overlay" onClick={() => setConfirmRebase(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Rebase</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Rebase <strong>{currentBranch}</strong> onto <strong>{confirmRebase.ontoRef}</strong>?
                {' '}If a conflict happens the rebase is left in-progress so you can resolve it in
                your shell pane and click <em>Continue</em>, or click <em>Abort rebase</em> to roll back.
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setConfirmRebase(null)}>Cancel</button>
                <button className="save-btn" onClick={() => handleRebase(confirmRebase.ontoRef)}>Rebase</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {renameDialog && (
        <div className="modal-overlay" onClick={() => setRenameDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Rename branch</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>Rename <strong>{renameDialog.branch}</strong> to:</p>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleRename(); } }}
                autoFocus
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 12 }}
              />
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setRenameDialog(null)}>Cancel</button>
                <button className="save-btn" disabled={!renameValue.trim() || renameValue.trim() === renameDialog.branch} onClick={handleRename}>Rename</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {worktreeDialog && (
        <div className="modal-overlay" onClick={() => setWorktreeDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Add worktree</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                Check out <strong>{worktreeDialog.branch}</strong> into a separate working tree at:
              </p>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={worktreePath}
                  onChange={(e) => setWorktreePath(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleWorktreeSubmit(); } }}
                  autoFocus
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 12 }}
                />
                <button className="cancel-btn" onClick={handleWorktreeBrowse}>Browse…</button>
              </div>
              <p style={{ fontSize: 11, color: 'var(--c-overlay0)', marginTop: 8 }}>
                The directory must not exist yet. You can open the new worktree as a separate Vyb profile.
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setWorktreeDialog(null)}>Cancel</button>
                <button className="save-btn" disabled={!worktreePath.trim()} onClick={handleWorktreeSubmit}>Create</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {prDialog && (
        <div className="modal-overlay" onClick={() => setPrDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Create pull request</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                Open a PR for <strong>{currentBranch}</strong> via <code>gh pr create</code>.
                {' '}Leave fields empty to use the latest commit message (<code>--fill</code>).
              </p>
              <input
                type="text"
                placeholder="Title (optional)"
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 12, marginBottom: 6 }}
              />
              <textarea
                placeholder="Body (optional)"
                value={prBody}
                onChange={(e) => setPrBody(e.target.value)}
                rows={4}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 11.5, fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace", resize: 'none' }}
              />
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setPrDialog(false)}>Cancel</button>
                <button className="save-btn" onClick={handleCreatePr}>Create PR</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {prResultUrl && (
        <div className="modal-overlay" onClick={() => setPrResultUrl(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Pull request opened</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                <a href={prResultUrl} onClick={(e) => { e.preventDefault(); window.api.openUrl(prResultUrl); }} style={{ color: 'var(--c-blue)' }}>
                  {prResultUrl}
                </a>
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="save-btn" onClick={() => setPrResultUrl(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {trackingDialog && (
        <TrackingDialog
          branch={trackingDialog.branch}
          remotes={remotes}
          onClose={() => setTrackingDialog(null)}
          onSet={(upstream) => handleSetUpstream(trackingDialog.branch, upstream)}
          onUnset={() => handleUnsetUpstream(trackingDialog.branch)}
        />
      )}

      {newTagDialog && (
        <div className="modal-overlay" onClick={() => setNewTagDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>New tag</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                Tag <code>{newTagDialog.commitRef.length >= 8 ? newTagDialog.commitRef.slice(0, 8) : newTagDialog.commitRef}</code>:
              </p>
              <input
                type="text"
                placeholder="tag-name (e.g. v1.0.0)"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleNewTagSubmit(); } }}
                autoFocus
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 12, marginBottom: 6 }}
              />
              <textarea
                placeholder="Message (optional — non-empty creates an annotated tag)"
                value={newTagMessage}
                onChange={(e) => setNewTagMessage(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: '6px 8px', borderRadius: 4, border: '1px solid var(--c-surface0)', background: 'var(--c-base)', color: 'var(--c-text)', fontSize: 11.5, fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace", resize: 'none' }}
              />
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setNewTagDialog(null)}>Cancel</button>
                <button className="save-btn" disabled={!newTagName.trim()} onClick={handleNewTagSubmit}>Create tag</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmCherryPick && (
        <div className="modal-overlay" onClick={() => setConfirmCherryPick(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Cherry-pick</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Apply commit <strong>{confirmCherryPick.sha.slice(0, 8)}</strong> on top of <strong>{currentBranch || 'HEAD'}</strong>?
                {' '}On conflict the cherry-pick is left in-progress so you can resolve in your shell and click <em>Continue</em>.
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setConfirmCherryPick(null)}>Cancel</button>
                <button className="save-btn" onClick={() => handleCherryPick(confirmCherryPick.sha)}>Cherry-pick</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmRevert && (
        <div className="modal-overlay" onClick={() => setConfirmRevert(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Revert commit</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Create a commit on <strong>{currentBranch || 'HEAD'}</strong> that undoes the changes
                from <strong>{confirmRevert.sha.slice(0, 8)}</strong>?
                {' '}On conflict the revert is left in-progress.
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setConfirmRevert(null)}>Cancel</button>
                <button className="save-btn" onClick={() => handleRevert(confirmRevert.sha)}>Revert</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {resetDialog && (
        <div className="modal-overlay" onClick={() => setResetDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Reset branch</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
                Move <strong>{currentBranch || 'HEAD'}</strong> to <strong>{resetDialog.sha.slice(0, 8)}</strong>.
                Pick what happens to your working tree + index:
              </p>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
                <input
                  type="radio"
                  checked={resetDialog.mode === 'soft'}
                  onChange={() => setResetDialog({ ...resetDialog, mode: 'soft' })}
                  style={{ marginRight: 6 }}
                />
                <strong>Soft</strong> — keep working tree + index. Changes stay <em>staged</em>.
              </label>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
                <input
                  type="radio"
                  checked={resetDialog.mode === 'mixed'}
                  onChange={() => setResetDialog({ ...resetDialog, mode: 'mixed' })}
                  style={{ marginRight: 6 }}
                />
                <strong>Mixed</strong> — keep working tree, unstage. (git default)
              </label>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: 'var(--c-red)' }}>
                <input
                  type="radio"
                  checked={resetDialog.mode === 'hard'}
                  onChange={() => setResetDialog({ ...resetDialog, mode: 'hard' })}
                  style={{ marginRight: 6 }}
                />
                <strong>Hard</strong> — discard all working tree + index changes. <strong>Cannot be undone.</strong>
              </label>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setResetDialog(null)}>Cancel</button>
                <button
                  className={resetDialog.mode === 'hard' ? 'delete-btn' : 'save-btn'}
                  onClick={handleResetSubmit}
                >
                  Reset {resetDialog.mode}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return { ops, modals, banner, errorBar };
}

function TrackingDialog({
  branch, remotes, onClose, onSet, onUnset,
}: {
  branch: string;
  remotes: GitRef[];
  onClose: () => void;
  onSet: (upstream: string) => void;
  onUnset: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Tracking — {branch}</h3></div>
        <div className="modal-body">
          <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
            Pick an upstream branch to track:
          </p>
          {remotes.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--c-overlay0)' }}>No remote branches available.</p>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--c-surface0)', borderRadius: 4 }}>
            {remotes.map((r) => (
              <button
                key={r.fullName}
                onClick={() => onSet(r.name)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  color: 'var(--c-text)',
                  fontSize: 12,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-surface0)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="delete-btn" onClick={onUnset} title="Remove the upstream tracking">Unset</button>
          <div className="modal-footer-right">
            <button className="cancel-btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function labelForKind(kind: RefMenuNode['kind']): string {
  switch (kind) {
    case 'localBranch': return 'branch';
    case 'remoteBranch': return 'remote branch';
    case 'tag': return 'tag';
    case 'stash': return 'stash';
    default: return 'item';
  }
}
