import { useEffect, useState, useCallback, useMemo } from 'react';
import { GitLfsInfo, GitLfsLock, GitRef, GitRemote, GitStash, GitStatus, GitSubmodule, GitWorktree } from '../../shared/types';
import {
  LocalBranchNode, RemoteBranchNode, TagNode, StashNode, RefMenuNode,
  RefContextMenu, useGitRefOps,
} from './git-ref-ops';

interface BranchTreeProps {
  workingDirectory: string;
  /** Bumped by the parent panel after Push / Pull / Fetch so the
   * branches list reloads (new remotes, updated ahead/behind, etc). */
  reloadEpoch?: number;
  /** "Compare with…" handler injected by the panel. Maps each branch /
   * tag context-menu invocation to a compare against current branch. */
  onCompareWith?: (sourceRef: string, sourceLabel: string) => void;
  /** Conflict-file click handler injected by the panel. Routes through
   * the shared `useGitRefOps` banner. */
  onResolveConflictFile?: (path: string) => void;
}

// ── Tree model ─────────────────────────────────────────────────────
//
// Branches/remotes/tags get grouped into a folder tree by splitting their
// names on `/`. Stashes are flat. Each leaf carries enough metadata for
// the right-click menu to dispatch the correct git operation.

// Folder is BranchTree-specific (groups branches by /-separated path).
// The leaf node types (LocalBranchNode etc.) are shared with GitTree via
// `git-ref-ops`.
interface FolderNode {
  kind: 'folder';
  name: string;          // segment, e.g. "agent"
  fullPath: string;      // full prefix, e.g. "agent" or "agent/inner"
  children: TreeNode[];
}
type TreeNode = FolderNode | LocalBranchNode | RemoteBranchNode | TagNode | StashNode;

/**
 * Insert `leaf` into a folder tree under the path defined by `segments`.
 * `segments` is the path *above* the leaf (the leaf's own segment is part
 * of the leaf node itself, not a folder). Mutates `roots`.
 */
function insertLeaf(roots: TreeNode[], segments: string[], leaf: TreeNode, prefixSoFar: string) {
  if (segments.length === 0) {
    roots.push(leaf);
    return;
  }
  const [head, ...rest] = segments;
  const folderFullPath = prefixSoFar ? `${prefixSoFar}/${head}` : head;
  let folder = roots.find((n): n is FolderNode => n.kind === 'folder' && n.name === head);
  if (!folder) {
    folder = { kind: 'folder', name: head, fullPath: folderFullPath, children: [] };
    roots.push(folder);
  }
  insertLeaf(folder.children, rest, leaf, folderFullPath);
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    // Folders before leaves at each level.
    const aIsFolder = a.kind === 'folder' ? 0 : 1;
    const bIsFolder = b.kind === 'folder' ? 0 : 1;
    if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
    return a.kind === 'folder' && b.kind === 'folder'
      ? a.name.localeCompare(b.name)
      : (a as { name: string }).name.localeCompare((b as { name: string }).name);
  });
  for (const n of nodes) {
    if (n.kind === 'folder') sortTree(n.children);
  }
}

/** Split the local-branch refs into a folder tree. */
function buildLocalTree(refs: GitRef[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const r of refs) {
    if (r.type !== 'local') continue;
    const parts = r.name.split('/');
    const leafName = parts.pop() ?? r.name;
    insertLeaf(roots, parts, {
      kind: 'localBranch',
      name: leafName,
      fullName: r.name,
      sha: r.sha,
      isHead: r.isHead,
    }, '');
  }
  sortTree(roots);
  return roots;
}

/** Group remote refs first by remote (origin / upstream / …) then by `/`. */
function buildRemoteTree(refs: GitRef[]): TreeNode[] {
  // remote name → tree
  const byRemote = new Map<string, TreeNode[]>();
  for (const r of refs) {
    if (r.type !== 'remote' || !r.remote) continue;
    // r.name is "origin/agent/T-005"; strip the leading "origin/".
    const branchOnly = r.name.startsWith(r.remote + '/') ? r.name.slice(r.remote.length + 1) : r.name;
    const parts = branchOnly.split('/');
    const leafName = parts.pop() ?? branchOnly;
    const list = byRemote.get(r.remote) ?? [];
    insertLeaf(list, parts, {
      kind: 'remoteBranch',
      name: leafName,
      remote: r.remote,
      branch: branchOnly,
      fullName: r.name,
      sha: r.sha,
    }, '');
    byRemote.set(r.remote, list);
  }
  const roots: TreeNode[] = [];
  for (const [remote, kids] of byRemote) {
    sortTree(kids);
    roots.push({ kind: 'folder', name: remote, fullPath: remote, children: kids });
  }
  roots.sort((a, b) => (a as FolderNode).name.localeCompare((b as FolderNode).name));
  return roots;
}

/** Tags as a flat list (could be /-grouped later if needed). */
function buildTagList(refs: GitRef[]): TreeNode[] {
  return refs
    .filter((r) => r.type === 'tag')
    .map<TreeNode>((r) => ({ kind: 'tag', name: r.name, fullName: r.fullName, sha: r.sha }))
    .sort((a, b) => (a as TagNode).name.localeCompare((b as TagNode).name));
}

// ── Component ──────────────────────────────────────────────────────

interface CtxMenuState {
  x: number;
  y: number;
  node: TreeNode;
}

export function BranchTree({ workingDirectory, reloadEpoch = 0, onCompareWith, onResolveConflictFile }: BranchTreeProps) {
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // T-034: configured remotes (separate from remote-tracking refs in
  // `refs`). A remote can exist in `.git/config` without any fetched
  // branches yet — those still render as empty folders here.
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  // Remote ops UI state. Right-click on a remote folder opens this
  // menu; the modals below drive the actual add/rename/edit/remove
  // dialogs. Kept separate from `ctxMenu` (which is for ref pills).
  const [remoteMenu, setRemoteMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [editRemote, setEditRemote] = useState<{ mode: 'rename' | 'url'; current: GitRemote } | null>(null);
  const [removeRemote, setRemoveRemote] = useState<{ name: string; trackingBranches: string[] } | null>(null);
  const [remoteOpError, setRemoteOpError] = useState<string | null>(null);
  // T-035: worktree state + UI.
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [worktreeMenu, setWorktreeMenu] = useState<{ x: number; y: number; wt: GitWorktree } | null>(null);
  const [addWorktreeOpen, setAddWorktreeOpen] = useState(false);
  const [removeWorktreeConfirm, setRemoveWorktreeConfirm] = useState<{ wt: GitWorktree; needsForce: boolean; reason: string } | null>(null);
  const [worktreeOpError, setWorktreeOpError] = useState<string | null>(null);
  // T-040 LFS state. `lfs` is `null` until the first probe finishes;
  // we skip the section header entirely while loading to avoid flicker.
  const [lfs, setLfs] = useState<GitLfsInfo | null>(null);
  const [lfsLocks, setLfsLocks] = useState<GitLfsLock[]>([]);
  const [lfsBusy, setLfsBusy] = useState(false);
  const [lfsError, setLfsError] = useState<string | null>(null);
  // T-039 submodule state.
  const [submodules, setSubmodules] = useState<GitSubmodule[]>([]);
  const [submoduleMenu, setSubmoduleMenu] = useState<{ x: number; y: number; sm: GitSubmodule } | null>(null);
  const [submoduleBusy, setSubmoduleBusy] = useState(false);
  const [submoduleError, setSubmoduleError] = useState<string | null>(null);

  // Per-section open/closed state. Default: branches + stashes open,
  // remotes + tags collapsed (they tend to be larger).
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(['branches', 'worktrees', 'submodules', 'stashes']),
  );

  // Folder open state, keyed by `${section}:${fullPath}`.
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());

  // Right-click menu state — the menu's contents/dialogs/banners come
  // from the shared `useGitRefOps` hook below. Folder rows (path-prefix
  // groupings) aren't actionable, so they're filtered out before being
  // stored here.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: RefMenuNode } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s, st, rm, wt, li, sm] = await Promise.all([
        window.api.getGitRefs(workingDirectory),
        window.api.gitListStashes(workingDirectory),
        window.api.getGitStatus(workingDirectory),
        window.api.gitListRemotes(workingDirectory),
        window.api.gitListWorktrees(workingDirectory),
        window.api.gitLfsInfo(workingDirectory),
        window.api.gitSubmodulesList(workingDirectory),
      ]);
      setRefs(r);
      setStashes(s);
      setStatus(st);
      setRemotes(rm);
      setWorktrees(wt);
      setLfs(li);
      setSubmodules(sm);
      if (li.available && li.configured) {
        // Lazy second round-trip — locks are slower (network) so
        // fetch them only when LFS is actually in use.
        const locks = await window.api.gitLfsListLocks(workingDirectory);
        setLfsLocks(locks);
      } else {
        setLfsLocks([]);
      }
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    load();
    // Reload when the parent panel runs Push / Pull / Fetch.
  }, [load, reloadEpoch]);

  // Close the context menu on outside mousedown — see the comment in the
  // matching effect in GitTree for why mousedown beats click/contextmenu.
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.file-context-menu')) return;
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [ctxMenu]);

  const localTree = useMemo(() => buildLocalTree(refs), [refs]);
  const remoteTree = useMemo(() => buildRemoteTree(refs), [refs]);
  const tagList = useMemo(() => buildTagList(refs), [refs]);

  const currentBranch = status?.branch ?? '';
  const onBranch = !!currentBranch && !/^[0-9a-f]{7,}$/i.test(currentBranch);

  const remoteRefs = useMemo(() => refs.filter((r) => r.type === 'remote'), [refs]);
  const { ops, modals, banner, errorBar } = useGitRefOps({
    workingDirectory,
    onAfterOp: load,
    remotes: remoteRefs,
    status,
    currentBranch,
    onResolveConflictFile,
  });

  // ── T-034 remote ops handlers ────────────────────────────────
  // All four ops follow the same shape: call git via IPC, on success
  // reload + clear the modal, on failure surface the error inline in
  // the active modal. The error banner shows next to the field rather
  // than blocking the modal so the user can retry without losing
  // their input.
  const handleAddRemote = useCallback(async (name: string, url: string): Promise<boolean> => {
    setRemoteOpError(null);
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(trimmedName)) { setRemoteOpError('Invalid name. Use letters, digits, dots, dashes, or underscores.'); return false; }
    if (remotes.some((r) => r.name === trimmedName)) { setRemoteOpError(`A remote named "${trimmedName}" already exists.`); return false; }
    if (!trimmedUrl) { setRemoteOpError('URL is required.'); return false; }
    const result = await window.api.gitAddRemote(workingDirectory, trimmedName, trimmedUrl);
    if (!result.ok) { setRemoteOpError(result.message || 'Failed to add remote'); return false; }
    await load();
    return true;
  }, [workingDirectory, remotes, load]);

  const handleRenameRemote = useCallback(async (oldName: string, newName: string): Promise<boolean> => {
    setRemoteOpError(null);
    const trimmed = newName.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) { setRemoteOpError('Invalid name. Use letters, digits, dots, dashes, or underscores.'); return false; }
    if (trimmed === oldName) { setRemoteOpError('New name is the same as the old name.'); return false; }
    if (remotes.some((r) => r.name === trimmed)) { setRemoteOpError(`A remote named "${trimmed}" already exists.`); return false; }
    const result = await window.api.gitRenameRemote(workingDirectory, oldName, trimmed);
    if (!result.ok) { setRemoteOpError(result.message || 'Failed to rename remote'); return false; }
    await load();
    return true;
  }, [workingDirectory, remotes, load]);

  const handleSetRemoteUrl = useCallback(async (name: string, url: string): Promise<boolean> => {
    setRemoteOpError(null);
    const trimmed = url.trim();
    if (!trimmed) { setRemoteOpError('URL is required.'); return false; }
    const result = await window.api.gitSetRemoteUrl(workingDirectory, name, trimmed);
    if (!result.ok) { setRemoteOpError(result.message || 'Failed to update URL'); return false; }
    await load();
    return true;
  }, [workingDirectory, load]);

  const handleRemoveRemote = useCallback(async (name: string): Promise<boolean> => {
    setRemoteOpError(null);
    const result = await window.api.gitRemoveRemote(workingDirectory, name);
    if (!result.ok) { setRemoteOpError(result.message || 'Failed to remove remote'); return false; }
    await load();
    return true;
  }, [workingDirectory, load]);

  // Open the Remove confirmation, prefetching the count of local
  // branches that track this remote so the warning text is accurate.
  const openRemoveConfirm = useCallback(async (name: string) => {
    const branches = await window.api.gitRemoteTrackingBranches(workingDirectory, name);
    setRemoteOpError(null);
    setRemoveRemote({ name, trackingBranches: branches });
  }, [workingDirectory]);

  // Close the remote ops context menu on outside mousedown — same
  // pattern as the ref context menu above.
  useEffect(() => {
    if (!remoteMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.file-context-menu')) return;
      setRemoteMenu(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [remoteMenu]);

  // ── T-035 worktree ops handlers ────────────────────────────────
  // Add reuses the existing GIT_ADD_WORKTREE IPC. Remove first tries
  // without --force; if git refuses for dirty/locked state, we
  // re-prompt with a "Force remove" checkbox and the git message so
  // the user can decide. This mirrors git's own gate without an
  // extra status round-trip.
  const handleAddWorktree = useCallback(async (worktreePath: string, branch: string): Promise<boolean> => {
    setWorktreeOpError(null);
    if (!worktreePath.trim()) { setWorktreeOpError('Path is required.'); return false; }
    if (!branch.trim()) { setWorktreeOpError('Branch is required.'); return false; }
    const result = await window.api.gitAddWorktree(workingDirectory, worktreePath.trim(), branch.trim());
    if (!result.ok) { setWorktreeOpError(result.message || 'Failed to add worktree'); return false; }
    await load();
    return true;
  }, [workingDirectory, load]);

  const handleRemoveWorktree = useCallback(async (wt: GitWorktree, force: boolean): Promise<boolean> => {
    setWorktreeOpError(null);
    const result = await window.api.gitRemoveWorktree(workingDirectory, wt.path, force);
    if (!result.ok) {
      const msg = result.message || 'Failed to remove worktree';
      // Re-prompt with a Force checkbox when git refuses because of
      // dirty / untracked / locked state — git's own gate.
      if (/contains modified|untracked|is dirty|locked|not\s+clean/i.test(msg) && !force) {
        setRemoveWorktreeConfirm({ wt, needsForce: true, reason: msg });
        return false;
      }
      setWorktreeOpError(msg);
      return false;
    }
    await load();
    return true;
  }, [workingDirectory, load]);

  useEffect(() => {
    if (!worktreeMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.file-context-menu')) return;
      setWorktreeMenu(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [worktreeMenu]);

  // ── T-040 LFS ops ──────────────────────────────────────────────
  const runLfsOp = useCallback(async (op: () => Promise<{ ok: boolean; message?: string }>, label: string) => {
    if (lfsBusy) return;
    setLfsBusy(true);
    setLfsError(null);
    try {
      const result = await op();
      if (!result.ok) { setLfsError(result.message || `${label} failed`); return; }
      // Re-fetch LFS state to pick up new locks / pruned cache / etc.
      const [info, locks] = await Promise.all([
        window.api.gitLfsInfo(workingDirectory),
        window.api.gitLfsListLocks(workingDirectory),
      ]);
      setLfs(info);
      setLfsLocks(locks);
    } finally {
      setLfsBusy(false);
    }
  }, [lfsBusy, workingDirectory]);

  const handleLfsFetch = useCallback(() => runLfsOp(() => window.api.gitLfsFetch(workingDirectory), 'lfs fetch'), [runLfsOp, workingDirectory]);
  const handleLfsPrune = useCallback(() => runLfsOp(() => window.api.gitLfsPrune(workingDirectory), 'lfs prune'), [runLfsOp, workingDirectory]);
  const handleLfsUnlock = useCallback((lockPath: string) => runLfsOp(() => window.api.gitLfsUnlock(workingDirectory, lockPath, false), 'lfs unlock'), [runLfsOp, workingDirectory]);
  const handleLfsForceUnlock = useCallback((lockPath: string) => runLfsOp(() => window.api.gitLfsUnlock(workingDirectory, lockPath, true), 'lfs unlock --force'), [runLfsOp, workingDirectory]);

  // ── T-039 submodule ops ────────────────────────────────────────
  const runSubmoduleOp = useCallback(async (op: () => Promise<{ ok: boolean; message?: string }>, label: string) => {
    if (submoduleBusy) return;
    setSubmoduleBusy(true);
    setSubmoduleError(null);
    try {
      const result = await op();
      if (!result.ok) { setSubmoduleError(result.message || `${label} failed`); return; }
      // Re-fetch status so the row's flag flips after init/update/sync.
      const next = await window.api.gitSubmodulesList(workingDirectory);
      setSubmodules(next);
    } finally {
      setSubmoduleBusy(false);
    }
  }, [submoduleBusy, workingDirectory]);

  useEffect(() => {
    if (!submoduleMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.file-context-menu')) return;
      setSubmoduleMenu(null);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [submoduleMenu]);

  const toggleSection = (key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleFolder = (key: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Render ────────────────────────────────────────────────

  if (loading && refs.length === 0 && stashes.length === 0) {
    return <div className="git-changes-loading">Loading branches…</div>;
  }

  return (
    <div className="git-branches">
      <div className="git-tree-toolbar">
        <span className="git-tree-count">
          {refs.filter((r) => r.type === 'local').length} branches · {refs.filter((r) => r.type === 'remote').length} remote · {stashes.length} stash{stashes.length === 1 ? '' : 'es'}
        </span>
        <button className="git-changes-btn" onClick={load} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
            <polyline points="13 3 13 6 10 6" />
            <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
            <polyline points="3 13 3 10 6 10" />
          </svg>
        </button>
      </div>

      {errorBar}
      {banner}

      <div className="git-branches-list">
        <Section
          title={`Branches${localTree.length === 0 ? '' : ` (${refs.filter((r) => r.type === 'local').length})`}`}
          sectionKey="branches"
          isOpen={openSections.has('branches')}
          onToggle={toggleSection}
          onContextMenu={undefined}
        >
          {localTree.length === 0 && <div className="git-branches-empty">No branches</div>}
          {localTree.map((n) => (
            <NodeRow
              key={'branches:' + nodeKey(n)}
              node={n}
              section="branches"
              depth={0}
              currentBranch={currentBranch}
              openFolders={openFolders}
              onToggleFolder={toggleFolder}
              onActivate={(target) => ops.onCheckout(target)}
              onContextMenu={(e, node) => {
                if (node.kind === 'folder') return; // path-prefix folders aren't actionable
                setCtxMenu({ x: e.clientX, y: e.clientY, node });
              }}
            />
          ))}
        </Section>

        <Section
          title={`Worktrees${worktrees.length === 0 ? '' : ` (${worktrees.length})`}`}
          sectionKey="worktrees"
          isOpen={openSections.has('worktrees')}
          onToggle={toggleSection}
          headerAction={(
            <button
              className="git-branches-add-remote"
              onClick={() => { setWorktreeOpError(null); setAddWorktreeOpen(true); }}
              title="Add a new worktree"
              aria-label="Add worktree"
            >+</button>
          )}
        >
          {worktrees.length === 0 && <div className="git-branches-empty">Loading…</div>}
          {(() => {
            // Render main + user-managed first, then a sub-header
            // before any system-managed (Vyb parallel-agent) worktrees
            // so users can tell them apart at a glance.
            const userWts = worktrees.filter((w) => !w.isSystemManaged);
            const systemWts = worktrees.filter((w) => w.isSystemManaged);
            return (
              <>
                {userWts.map((wt) => (
                  <WorktreeRow
                    key={wt.path}
                    wt={wt}
                    isCurrent={wt.path === workingDirectory}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setWorktreeOpError(null);
                      setWorktreeMenu({ x: e.clientX, y: e.clientY, wt });
                    }}
                  />
                ))}
                {systemWts.length > 0 && (
                  <>
                    <div className="git-branches-subheader" title="Worktrees owned by Vyb's parallel-agent dispatcher">
                      Managed by Vyb ({systemWts.length})
                    </div>
                    {systemWts.map((wt) => (
                      <WorktreeRow
                        key={wt.path}
                        wt={wt}
                        isCurrent={wt.path === workingDirectory}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setWorktreeOpError(null);
                          setWorktreeMenu({ x: e.clientX, y: e.clientY, wt });
                        }}
                      />
                    ))}
                  </>
                )}
              </>
            );
          })()}
        </Section>

        <Section
          title={`Remotes${remotes.length === 0 ? '' : ` (${remotes.length})`}`}
          sectionKey="remotes"
          isOpen={openSections.has('remotes')}
          onToggle={toggleSection}
          headerAction={(
            <button
              className="git-branches-add-remote"
              onClick={() => { setRemoteOpError(null); setAddRemoteOpen(true); }}
              title="Add a new remote"
              aria-label="Add remote"
            >+</button>
          )}
        >
          {remotes.length === 0 && <div className="git-branches-empty">No remotes configured</div>}
          {remotes.map((rem) => {
            // Look up the tree node for this remote (if any branches
            // are fetched) so we can render its sub-tree below the
            // folder header. Remotes that exist in config but have no
            // fetched branches yet render as empty folders.
            const treeNode = remoteTree.find((n) => n.kind === 'folder' && (n as FolderNode).name === rem.name) as FolderNode | undefined;
            const folderKey = `remotes:${rem.name}`;
            const isOpen = openFolders.has(folderKey);
            return (
              <div key={`remote:${rem.name}`}>
                <div
                  className="file-tree-item git-branches-remote-row"
                  style={{ paddingLeft: 12 }}
                  onClick={() => toggleFolder(folderKey)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setRemoteOpError(null);
                    setRemoteMenu({ x: e.clientX, y: e.clientY, name: rem.name });
                  }}
                  title={rem.fetchUrl === rem.pushUrl ? rem.fetchUrl : `fetch: ${rem.fetchUrl}\npush: ${rem.pushUrl}`}
                >
                  <span className="file-tree-arrow" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 3 11 8 6 13" />
                    </svg>
                  </span>
                  <FolderIcon isOpen={isOpen} />
                  <span className="file-tree-name">{rem.name}</span>
                  <span className="git-branches-remote-url">{rem.fetchUrl}</span>
                </div>
                {isOpen && treeNode && treeNode.children.map((child) => (
                  <NodeRow
                    key={'remotes:' + nodeKey(child)}
                    node={child}
                    section="remotes"
                    depth={1}
                    currentBranch={currentBranch}
                    openFolders={openFolders}
                    onToggleFolder={toggleFolder}
                    onActivate={(target) => ops.onCheckout(target)}
                    onContextMenu={(e, node) => {
                      if (node.kind === 'folder') return;
                      setCtxMenu({ x: e.clientX, y: e.clientY, node });
                    }}
                  />
                ))}
                {isOpen && !treeNode && (
                  <div className="git-branches-empty" style={{ paddingLeft: 36 }}>No branches fetched — run Fetch to populate</div>
                )}
              </div>
            );
          })}
        </Section>

        <Section
          title={`Tags${tagList.length === 0 ? '' : ` (${tagList.length})`}`}
          sectionKey="tags"
          isOpen={openSections.has('tags')}
          onToggle={toggleSection}
        >
          {tagList.length === 0 && <div className="git-branches-empty">No tags</div>}
          {tagList.map((n) => (
            <NodeRow
              key={'tags:' + nodeKey(n)}
              node={n}
              section="tags"
              depth={0}
              currentBranch={currentBranch}
              openFolders={openFolders}
              onToggleFolder={toggleFolder}
              onActivate={(target) => ops.onCheckout(target)}
              onContextMenu={(e, node) => {
                if (node.kind === 'folder') return; // path-prefix folders aren't actionable
                setCtxMenu({ x: e.clientX, y: e.clientY, node });
              }}
            />
          ))}
        </Section>

        <Section
          title={`Stashes${stashes.length === 0 ? '' : ` (${stashes.length})`}`}
          sectionKey="stashes"
          isOpen={openSections.has('stashes')}
          onToggle={toggleSection}
          onContextMenu={(e) => setCtxMenu({
            x: e.clientX, y: e.clientY,
            node: { kind: 'stashesSection' },
          })}
        >
          {stashes.length === 0 && <div className="git-branches-empty">No stashes</div>}
          {stashes.map((s) => (
            <NodeRow
              key={'stashes:' + s.ref}
              node={{ kind: 'stash', index: s.index, ref: s.ref, message: s.message, branch: s.branch }}
              section="stashes"
              depth={0}
              currentBranch={currentBranch}
              openFolders={openFolders}
              onToggleFolder={toggleFolder}
              onActivate={() => undefined /* stashes don't checkout; menu only */}
              onContextMenu={(e, node) => {
                if (node.kind === 'folder') return; // path-prefix folders aren't actionable
                setCtxMenu({ x: e.clientX, y: e.clientY, node });
              }}
            />
          ))}
        </Section>

        {/* T-039: Submodules section. Rendered only when the repo
            actually has a .gitmodules file (the main-process handler
            returns an empty list otherwise). */}
        {submodules.length > 0 && (
          <Section
            title={`Submodules (${submodules.length})`}
            sectionKey="submodules"
            isOpen={openSections.has('submodules')}
            onToggle={toggleSection}
          >
            {submoduleError && <div className="git-tree-error" style={{ margin: '4px 12px' }}>{submoduleError}</div>}
            {submodules.map((sm) => (
              <div
                key={sm.path}
                className={`file-tree-item git-submodule-row git-submodule-${sm.status}`}
                style={{ paddingLeft: 18 }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSubmoduleError(null);
                  setSubmoduleMenu({ x: e.clientX, y: e.clientY, sm });
                }}
                title={`${sm.path}\n${sm.sha}${sm.url ? `\n${sm.url}` : ''}`}
              >
                <span className="git-submodule-status-dot" aria-hidden />
                <span className="git-submodule-name">{sm.path}</span>
                <span className="git-submodule-sha">{sm.shortSha}</span>
                {sm.describe && <span className="git-submodule-describe">{sm.describe}</span>}
                <span className={`git-submodule-status git-submodule-status-${sm.status}`}>
                  {sm.status === 'clean' ? 'clean'
                    : sm.status === 'modified' ? 'modified'
                    : sm.status === 'uninitialised' ? 'uninit'
                    : 'conflict'}
                </span>
              </div>
            ))}
          </Section>
        )}

        {/* T-040: LFS section. Always present so the user can see "LFS
            not installed" hints in repos that need it; the body
            content adapts based on availability. */}
        <Section
          title={`LFS${lfs?.available && lfs?.configured ? ` (${lfs.trackedCount} file${lfs.trackedCount === 1 ? '' : 's'})` : ''}`}
          sectionKey="lfs"
          isOpen={openSections.has('lfs')}
          onToggle={toggleSection}
        >
          {lfs === null && <div className="git-branches-empty">Loading…</div>}
          {lfs !== null && !lfs.available && (
            <div className="git-branches-empty" style={{ lineHeight: 1.5 }}>
              Git LFS isn't installed.{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); window.api.openUrl('https://git-lfs.com'); }} style={{ color: 'var(--c-blue)' }}>
                Install it
              </a>{' '} to manage large-file storage from this panel.
            </div>
          )}
          {lfs !== null && lfs.available && !lfs.configured && (
            <div className="git-branches-empty">This repo doesn't use LFS.</div>
          )}
          {lfs !== null && lfs.available && lfs.configured && (
            <>
              <div className="git-lfs-toolbar">
                <button className="git-tree-toolbar-btn" disabled={lfsBusy} onClick={handleLfsFetch} title="Download all LFS objects for the current commit">
                  Fetch
                </button>
                <button className="git-tree-toolbar-btn" disabled={lfsBusy} onClick={handleLfsPrune} title="Delete local LFS objects not currently referenced">
                  Prune
                </button>
                {lfsBusy && <span className="git-lfs-busy">Working…</span>}
              </div>
              {lfsError && <div className="git-tree-error" style={{ margin: '4px 12px' }}>{lfsError}</div>}
              <div className="git-lfs-subheader">Locks ({lfsLocks.length})</div>
              {lfsLocks.length === 0 && <div className="git-branches-empty">No active locks.</div>}
              {lfsLocks.map((lock) => (
                <div key={lock.id} className="git-lfs-lock-row" title={`${lock.path}\nlocked by ${lock.owner}`}>
                  <span className="git-lfs-lock-path">{lock.path}</span>
                  <span className="git-lfs-lock-owner">{lock.owner}</span>
                  <button
                    className="git-tree-toolbar-btn"
                    disabled={lfsBusy}
                    onClick={() => handleLfsUnlock(lock.path)}
                    title="Release this lock"
                  >Unlock</button>
                  <button
                    className="git-tree-toolbar-btn"
                    disabled={lfsBusy}
                    onClick={() => handleLfsForceUnlock(lock.path)}
                    title="Force release even if you don't own the lock (requires admin on the remote)"
                  >Force</button>
                </div>
              ))}
            </>
          )}
        </Section>
      </div>

      {ctxMenu && (
        <RefContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          node={ctxMenu.node}
          currentBranch={currentBranch}
          onBranch={onBranch}
          onClose={() => setCtxMenu(null)}
          {...ops}
          onCompareWith={onCompareWith}
        />
      )}
      {modals}

      {/* T-034 remote ops: menu + modals */}
      {remoteMenu && (() => {
        const target = remotes.find((r) => r.name === remoteMenu.name);
        if (!target) return null;
        return (
          <div className="file-context-menu" style={{ left: remoteMenu.x, top: remoteMenu.y }} onClick={(e) => e.stopPropagation()}>
            <button className="file-ctx-item" onClick={() => { setEditRemote({ mode: 'rename', current: target }); setRemoteMenu(null); }}>
              Rename remote…
            </button>
            <button className="file-ctx-item" onClick={() => { setEditRemote({ mode: 'url', current: target }); setRemoteMenu(null); }}>
              Edit URL…
            </button>
            <div className="file-ctx-divider" />
            <button className="file-ctx-item file-ctx-danger" onClick={() => { setRemoteMenu(null); openRemoveConfirm(target.name); }}>
              Remove remote
            </button>
          </div>
        );
      })()}

      {addRemoteOpen && (
        <RemoteFormModal
          title="Add remote"
          initialName=""
          initialUrl=""
          mode="add"
          error={remoteOpError}
          onCancel={() => { setAddRemoteOpen(false); setRemoteOpError(null); }}
          onSubmit={async (name, url) => {
            const ok = await handleAddRemote(name, url);
            if (ok) setAddRemoteOpen(false);
          }}
        />
      )}

      {editRemote && editRemote.mode === 'rename' && (
        <RemoteFormModal
          title={`Rename "${editRemote.current.name}"`}
          initialName={editRemote.current.name}
          initialUrl={editRemote.current.fetchUrl}
          mode="rename"
          error={remoteOpError}
          onCancel={() => { setEditRemote(null); setRemoteOpError(null); }}
          onSubmit={async (name) => {
            const ok = await handleRenameRemote(editRemote.current.name, name);
            if (ok) setEditRemote(null);
          }}
        />
      )}

      {editRemote && editRemote.mode === 'url' && (
        <RemoteFormModal
          title={`Edit URL for "${editRemote.current.name}"`}
          initialName={editRemote.current.name}
          initialUrl={editRemote.current.fetchUrl}
          mode="url"
          error={remoteOpError}
          onCancel={() => { setEditRemote(null); setRemoteOpError(null); }}
          onSubmit={async (_name, url) => {
            const ok = await handleSetRemoteUrl(editRemote.current.name, url);
            if (ok) setEditRemote(null);
          }}
        />
      )}

      {removeRemote && (
        <div className="modal-overlay" onClick={() => { setRemoveRemote(null); setRemoteOpError(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Remove remote "{removeRemote.name}"?</h3></div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                This drops the remote from <code>.git/config</code>.
                Remote-tracking branches for it will also be removed.
              </p>
              {removeRemote.trackingBranches.length > 0 && (
                <p style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8, color: 'var(--c-yellow)' }}>
                  ⚠ {removeRemote.trackingBranches.length} local branch{removeRemote.trackingBranches.length === 1 ? '' : 'es'} ({removeRemote.trackingBranches.slice(0, 3).join(', ')}{removeRemote.trackingBranches.length > 3 ? `, +${removeRemote.trackingBranches.length - 3} more` : ''}) will lose their upstream.
                </p>
              )}
              {remoteOpError && (
                <p style={{ fontSize: 12, color: 'var(--c-red)', marginTop: 8 }}>{remoteOpError}</p>
              )}
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => { setRemoveRemote(null); setRemoteOpError(null); }}>Cancel</button>
                <button className="delete-btn" onClick={async () => {
                  const ok = await handleRemoveRemote(removeRemote.name);
                  if (ok) setRemoveRemote(null);
                }}>Remove</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* T-039 submodule context menu */}
      {submoduleMenu && (
        <div className="file-context-menu" style={{ left: submoduleMenu.x, top: submoduleMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button className="file-ctx-item" disabled={submoduleBusy} onClick={() => { runSubmoduleOp(() => window.api.gitSubmoduleInit(workingDirectory, submoduleMenu.sm.path), 'submodule init'); setSubmoduleMenu(null); }}>
            Init
          </button>
          <button className="file-ctx-item" disabled={submoduleBusy} onClick={() => { runSubmoduleOp(() => window.api.gitSubmoduleUpdate(workingDirectory, submoduleMenu.sm.path, false), 'submodule update'); setSubmoduleMenu(null); }}>
            Update (checkout pinned SHA)
          </button>
          <button className="file-ctx-item" disabled={submoduleBusy} onClick={() => { runSubmoduleOp(() => window.api.gitSubmoduleUpdate(workingDirectory, submoduleMenu.sm.path, true), 'submodule update --remote'); setSubmoduleMenu(null); }}>
            Update --remote (fetch + advance)
          </button>
          <button className="file-ctx-item" disabled={submoduleBusy} onClick={() => { runSubmoduleOp(() => window.api.gitSubmoduleSync(workingDirectory, submoduleMenu.sm.path), 'submodule sync'); setSubmoduleMenu(null); }}>
            Sync URL
          </button>
          <div className="file-ctx-divider" />
          <button className="file-ctx-item" onClick={() => { window.api.openInFinder(`${workingDirectory}/${submoduleMenu.sm.path}`); setSubmoduleMenu(null); }}>
            Show in Finder
          </button>
        </div>
      )}

      {/* T-035 worktree ops: menu + modals */}
      {worktreeMenu && (
        <div className="file-context-menu" style={{ left: worktreeMenu.x, top: worktreeMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button className="file-ctx-item" onClick={() => { window.api.openInFinder(worktreeMenu.wt.path); setWorktreeMenu(null); }}>
            Show in Finder
          </button>
          <button className="file-ctx-item" onClick={() => { window.api.openInVSCode(worktreeMenu.wt.path); setWorktreeMenu(null); }}>
            Open in VS Code
          </button>
          <div className="file-ctx-divider" />
          {(() => {
            const wt = worktreeMenu.wt;
            const disabledReason = wt.isMain
              ? 'Cannot remove the main worktree.'
              : wt.isSystemManaged
                ? 'Owned by a Vyb parallel agent — stop the agent to remove.'
                : null;
            return (
              <button
                className="file-ctx-item file-ctx-danger"
                disabled={!!disabledReason}
                title={disabledReason ?? undefined}
                onClick={() => { setWorktreeMenu(null); if (!disabledReason) setRemoveWorktreeConfirm({ wt, needsForce: false, reason: '' }); }}
              >
                Remove worktree…
              </button>
            );
          })()}
        </div>
      )}

      {addWorktreeOpen && (
        <WorktreeAddModal
          localBranches={refs.filter((r) => r.type === 'local').map((r) => r.name)}
          error={worktreeOpError}
          onCancel={() => { setAddWorktreeOpen(false); setWorktreeOpError(null); }}
          onSubmit={async (worktreePath, branch) => {
            const ok = await handleAddWorktree(worktreePath, branch);
            if (ok) setAddWorktreeOpen(false);
          }}
        />
      )}

      {removeWorktreeConfirm && (
        <WorktreeRemoveModal
          wt={removeWorktreeConfirm.wt}
          needsForce={removeWorktreeConfirm.needsForce}
          reason={removeWorktreeConfirm.reason}
          error={worktreeOpError}
          onCancel={() => { setRemoveWorktreeConfirm(null); setWorktreeOpError(null); }}
          onConfirm={async (force) => {
            const ok = await handleRemoveWorktree(removeWorktreeConfirm.wt, force);
            if (ok) setRemoveWorktreeConfirm(null);
          }}
        />
      )}

    </div>
  );
}

// ── T-035 worktree row ─────────────────────────────────────────────
// Renders a single worktree entry. The header row mirrors the
// remote-row layout (folder-style icon, primary name, muted path)
// so the visual rhythm of the Branches tab stays consistent.
function WorktreeRow({ wt, isCurrent, onContextMenu }: {
  wt: GitWorktree;
  isCurrent: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const primary = wt.branch
    ? wt.branch
    : wt.isBare
      ? '(bare)'
      : wt.head
        ? `(detached @ ${wt.head.slice(0, 7)})`
        : '(unknown)';
  return (
    <div
      className={`file-tree-item git-branches-worktree-row${wt.isSystemManaged ? ' is-system' : ''}${isCurrent ? ' is-current' : ''}`}
      style={{ paddingLeft: 18 }}
      onContextMenu={onContextMenu}
      title={wt.path}
    >
      <span className="git-branches-worktree-icon" aria-hidden>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          {wt.isMain
            ? <path d="M2 8l6-5 6 5v6H2zM6 14V10h4v4" />
            : <path d="M3 5h4l1 1h5v8H3z" />}
        </svg>
      </span>
      <span className="git-branches-worktree-branch">{primary}</span>
      {wt.isMain && <span className="git-branches-worktree-badge">main</span>}
      {wt.isLocked && <span className="git-branches-worktree-badge git-branches-worktree-badge-locked" title={wt.lockedReason || 'Locked'}>locked</span>}
      {wt.isSystemManaged && <span className="git-branches-worktree-badge git-branches-worktree-badge-system" title="Owned by a Vyb parallel agent">vyb</span>}
      {isCurrent && <span className="git-branches-worktree-badge git-branches-worktree-badge-current">current</span>}
      <span className="git-branches-worktree-path">{wt.path}</span>
    </div>
  );
}

// ── T-035 add-worktree modal ────────────────────────────────────────
function WorktreeAddModal({ localBranches, error, onCancel, onSubmit }: {
  localBranches: string[];
  error: string | null;
  onCancel: () => void;
  onSubmit: (path: string, branch: string) => void | Promise<void>;
}) {
  const [pathInput, setPathInput] = useState('');
  const [branchInput, setBranchInput] = useState(localBranches[0] || '');
  const [busy, setBusy] = useState(false);
  const handleSubmit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await onSubmit(pathInput, branchInput); } finally { setBusy(false); }
  }, [busy, pathInput, branchInput, onSubmit]);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Add worktree</h3></div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Path</span>
            <input
              type="text"
              value={pathInput}
              autoFocus
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="../my-feature-worktree"
              spellCheck={false}
            />
            <span className="field-hint">
              Absolute or repo-relative. The directory must not exist yet.
            </span>
          </label>
          <label className="field" style={{ marginTop: 12 }}>
            <span className="field-label">Branch</span>
            <input
              type="text"
              list="worktree-branch-list"
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="main"
              spellCheck={false}
            />
            <datalist id="worktree-branch-list">
              {localBranches.map((b) => <option key={b} value={b} />)}
            </datalist>
          </label>
          {error && <p style={{ fontSize: 12, color: 'var(--c-red)', marginTop: 8 }}>{error}</p>}
        </div>
        <div className="modal-footer">
          <div className="modal-footer-right">
            <button className="cancel-btn" onClick={onCancel}>Cancel</button>
            <button className="save-btn" onClick={handleSubmit} disabled={busy || !pathInput.trim() || !branchInput.trim()}>
              {busy ? 'Adding…' : 'Add worktree'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── T-035 remove-worktree confirm ──────────────────────────────────
function WorktreeRemoveModal({ wt, needsForce, reason, error, onCancel, onConfirm }: {
  wt: GitWorktree;
  needsForce: boolean;
  reason: string;
  error: string | null;
  onCancel: () => void;
  onConfirm: (force: boolean) => void | Promise<void>;
}) {
  const [force, setForce] = useState(needsForce);
  const [busy, setBusy] = useState(false);
  const handleConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await onConfirm(force); } finally { setBusy(false); }
  }, [busy, force, onConfirm]);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Remove worktree?</h3></div>
        <div className="modal-body">
          <p style={{ fontSize: 13, lineHeight: 1.5 }}>
            <code>{wt.path}</code>
          </p>
          {needsForce ? (
            <>
              <p style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8, color: 'var(--c-yellow)' }}>
                ⚠ Git refused: {reason}
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12 }}>
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                <span>Force remove (discards uncommitted changes)</span>
              </label>
            </>
          ) : (
            <p style={{ fontSize: 12, lineHeight: 1.5, marginTop: 8, opacity: 0.75 }}>
              The worktree directory is deleted. The branch it pointed at is kept.
            </p>
          )}
          {error && <p style={{ fontSize: 12, color: 'var(--c-red)', marginTop: 8 }}>{error}</p>}
        </div>
        <div className="modal-footer">
          <div className="modal-footer-right">
            <button className="cancel-btn" onClick={onCancel}>Cancel</button>
            <button className="delete-btn" onClick={handleConfirm} disabled={busy || (needsForce && !force)}>
              {busy ? 'Removing…' : (force ? 'Force remove' : 'Remove')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── T-034 remote add/edit modal ────────────────────────────────────
// Shared between Add Remote, Rename Remote, and Edit URL. The fields
// shown depend on `mode`: 'add' shows both name + URL, 'rename' shows
// only name, 'url' shows only URL. Validation happens in the parent;
// this component just collects input and surfaces the parent's error.
function RemoteFormModal({
  title, initialName, initialUrl, mode, error, onCancel, onSubmit,
}: {
  title: string;
  initialName: string;
  initialUrl: string;
  mode: 'add' | 'rename' | 'url';
  error: string | null;
  onCancel: () => void;
  onSubmit: (name: string, url: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const handleSubmit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await onSubmit(name, url); } finally { setBusy(false); }
  }, [busy, name, url, onSubmit]);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>{title}</h3></div>
        <div className="modal-body">
          {(mode === 'add' || mode === 'rename') && (
            <label className="field">
              <span className="field-label">Name</span>
              <input
                type="text"
                value={name}
                autoFocus={mode === 'add' || mode === 'rename'}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                placeholder="origin"
                spellCheck={false}
              />
            </label>
          )}
          {(mode === 'add' || mode === 'url') && (
            <label className="field" style={{ marginTop: 12 }}>
              <span className="field-label">URL</span>
              <input
                type="text"
                value={url}
                autoFocus={mode === 'url'}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                placeholder="git@github.com:user/repo.git"
                spellCheck={false}
              />
              <span className="field-hint">
                Accepts any URL git understands — HTTPS, SSH, local paths.
              </span>
            </label>
          )}
          {error && <p style={{ fontSize: 12, color: 'var(--c-red)', marginTop: 8 }}>{error}</p>}
        </div>
        <div className="modal-footer">
          <div className="modal-footer-right">
            <button className="cancel-btn" onClick={onCancel}>Cancel</button>
            <button className="save-btn" onClick={handleSubmit} disabled={busy}>
              {busy ? 'Working…' : (mode === 'add' ? 'Add' : 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ── Section header ─────────────────────────────────────────────────

function Section({
  title, sectionKey, isOpen, onToggle, children, onContextMenu, headerAction,
}: {
  title: string;
  sectionKey: string;
  isOpen: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Optional control rendered on the right edge of the section
   * header (e.g. T-034's "+ Add remote" button). Stops click
   * propagation so it doesn't toggle the section. */
  headerAction?: React.ReactNode;
}) {
  return (
    <div className="git-branches-section">
      <div
        className="git-branches-section-header"
        onClick={() => onToggle(sectionKey)}
        onContextMenu={onContextMenu}
      >
        <span className={`file-tree-arrow ${isOpen ? 'file-tree-arrow-open' : ''}`} style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 3 11 8 6 13" />
          </svg>
        </span>
        <span className="git-branches-section-title">{title}</span>
        {headerAction && (
          <span className="git-branches-section-action" onClick={(e) => e.stopPropagation()}>
            {headerAction}
          </span>
        )}
      </div>
      {isOpen && <div className="git-branches-section-body">{children}</div>}
    </div>
  );
}

// ── Tree row (recursive) ───────────────────────────────────────────

function nodeKey(n: TreeNode): string {
  if (n.kind === 'folder') return 'f:' + n.fullPath;
  if (n.kind === 'localBranch' || n.kind === 'remoteBranch' || n.kind === 'tag') return 'r:' + n.fullName;
  return 's:' + n.ref;
}

interface NodeRowProps {
  node: TreeNode;
  section: string;
  depth: number;
  currentBranch: string;
  openFolders: Set<string>;
  onToggleFolder: (key: string) => void;
  onActivate: (target: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
}

function NodeRow({
  node, section, depth, currentBranch, openFolders, onToggleFolder, onActivate, onContextMenu,
}: NodeRowProps) {
  if (node.kind === 'folder') {
    const folderKey = `${section}:${node.fullPath}`;
    const isOpen = openFolders.has(folderKey);
    return (
      <>
        <div
          className="file-tree-item"
          style={{ paddingLeft: 12 + depth * 14 }}
          onClick={() => onToggleFolder(folderKey)}
        >
          <span className="file-tree-arrow" style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 3 11 8 6 13" />
            </svg>
          </span>
          <FolderIcon isOpen={isOpen} />
          <span className="file-tree-name">{node.name}</span>
        </div>
        {isOpen && node.children.map((child) => (
          <NodeRow
            key={nodeKey(child)}
            node={child}
            section={section}
            depth={depth + 1}
            currentBranch={currentBranch}
            openFolders={openFolders}
            onToggleFolder={onToggleFolder}
            onActivate={onActivate}
            onContextMenu={onContextMenu}
          />
        ))}
      </>
    );
  }

  // Leaf rows.
  if (node.kind === 'localBranch') {
    const isCurrent = node.isHead || (currentBranch && node.fullName === currentBranch);
    return (
      <div
        className={`file-tree-item ${isCurrent ? 'git-branches-current' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 + 14 /* arrow gutter */ }}
        onDoubleClick={() => onActivate(node.fullName)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node); }}
        title={node.fullName}
      >
        <BranchIcon current={!!isCurrent} />
        <span className="file-tree-name">{node.name}</span>
      </div>
    );
  }
  if (node.kind === 'remoteBranch') {
    return (
      <div
        className="file-tree-item"
        style={{ paddingLeft: 12 + depth * 14 + 14 }}
        onDoubleClick={() => onActivate(node.fullName)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node); }}
        title={node.fullName}
      >
        <BranchIcon current={false} />
        <span className="file-tree-name">{node.name}</span>
      </div>
    );
  }
  if (node.kind === 'tag') {
    return (
      <div
        className="file-tree-item"
        style={{ paddingLeft: 12 + depth * 14 + 14 }}
        onDoubleClick={() => onActivate(node.fullName)}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, node); }}
        title={node.fullName}
      >
        <TagIcon />
        <span className="file-tree-name">{node.name}</span>
      </div>
    );
  }
  // stash
  return (
    <div
      className="file-tree-item"
      style={{ paddingLeft: 12 + depth * 14 + 14 }}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node); }}
      title={node.message}
    >
      <StashIcon />
      <span className="file-tree-name git-branches-stash-name">{node.message}</span>
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────

function FolderIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--c-overlay0)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginRight: 4 }}>
      {isOpen ? (
        <>
          <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v1H2V4.5Z" />
          <path d="M2 7h12l-1.5 5.5a1.5 1.5 0 0 1-1.5 1H3.5A1.5 1.5 0 0 1 2 12V7Z" />
        </>
      ) : (
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />
      )}
    </svg>
  );
}

function BranchIcon({ current }: { current: boolean }) {
  const color = current ? 'var(--c-green)' : 'var(--c-overlay0)';
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill={color} aria-hidden style={{ flexShrink: 0, marginRight: 5 }}>
      <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6c0 .73-.593 1.25-1.25 1.25H8.25a.75.75 0 00-.75.75v1.378a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836l.015-.008A2.24 2.24 0 018.25 7h3c.14 0 .25-.11.25-.25v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--c-overlay0)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, marginRight: 5 }}>
      <path d="M2 7.5V2.5h5l7 7-5 5-7-7z" />
      <circle cx="5" cy="5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function StashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--c-overlay0)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, marginRight: 5 }}>
      <rect x="2.5" y="4.5" width="11" height="8" rx="1" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
    </svg>
  );
}

