import { useEffect, useState, useCallback, useMemo } from 'react';
import { GitRef, GitStash, GitStatus } from '../../shared/types';
import {
  LocalBranchNode, RemoteBranchNode, TagNode, StashNode, RefMenuNode,
  RefContextMenu, useGitRefOps,
} from './git-ref-ops';

interface BranchTreeProps {
  workingDirectory: string;
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

export function BranchTree({ workingDirectory }: BranchTreeProps) {
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Per-section open/closed state. Default: branches + stashes open,
  // remotes + tags collapsed (they tend to be larger).
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(['branches', 'stashes']),
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
      const [r, s, st] = await Promise.all([
        window.api.getGitRefs(workingDirectory),
        window.api.gitListStashes(workingDirectory),
        window.api.getGitStatus(workingDirectory),
      ]);
      setRefs(r);
      setStashes(s);
      setStatus(st);
    } finally {
      setLoading(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    load();
  }, [load]);

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
  });

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
          title={`Remotes${remoteTree.length === 0 ? '' : ` (${refs.filter((r) => r.type === 'remote').length})`}`}
          sectionKey="remotes"
          isOpen={openSections.has('remotes')}
          onToggle={toggleSection}
        >
          {remoteTree.length === 0 && <div className="git-branches-empty">No remote branches</div>}
          {remoteTree.map((n) => (
            <NodeRow
              key={'remotes:' + nodeKey(n)}
              node={n}
              section="remotes"
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
        />
      )}
      {modals}

    </div>
  );
}


// ── Section header ─────────────────────────────────────────────────

function Section({
  title, sectionKey, isOpen, onToggle, children, onContextMenu,
}: {
  title: string;
  sectionKey: string;
  isOpen: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
  onContextMenu?: (e: React.MouseEvent) => void;
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

