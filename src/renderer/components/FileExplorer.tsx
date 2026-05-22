import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, EditorSelection, type Extension } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';
import { EditMenuAction, FileEntry } from '../../shared/types';
import { FileIcon } from '../file-icons';
import { ResizeHandle } from './ResizeHandle';
import { MermaidBlock } from './MermaidBlock';
import { ExcalidrawEditor, type ExcalidrawEditorHandle } from './ExcalidrawEditor';
import { SWORD_SHAPE } from '../file-icons';
import { FileHistoryView } from './FileHistoryView';
import { blameGutter } from '../lib/blame-gutter';
import { stickyScroll } from '../lib/sticky-scroll';
import type { GitBlameLine } from '../../shared/types';

interface FileExplorerProps {
  workingDirectory: string;
  /** When true the explorer is rendered with `display: none` so its open
   * tabs + unsaved edits survive tab toggles and profile switches.
   * Also suppresses menu / pendingOpenPath wiring while hidden so an
   * inactive instance doesn't fight an active sibling for the menu state. */
  hidden?: boolean;
  /** External request to open a file in a tab — typically from a click on
   * a file link in the agent terminal. The `nonce` discriminates re-opens
   * of the same path so the effect re-runs. Optional `line` jumps the
   * CodeMirror caret to that 1-based line once the editor is mounted. */
  pendingOpenPath?: { path: string; nonce: number; line?: number } | null;
  onPendingOpenHandled?: () => void;
  /** T-045: run Prettier on every save when true. The explicit
   * Format Document action (toolbar / Shift+Alt+F) always works
   * regardless of this flag. */
  formatOnSave?: boolean;
  /** T-046: include the sticky-scroll plugin in the editor. */
  stickyScroll?: boolean;
  /** Show dotfiles in the file tree. Filter happens renderer-side
   * so toggling is live — no IPC round-trip, no tree reload. */
  showHiddenFiles?: boolean;
  /** T-047: callback for Cmd+= / Cmd+- / Cmd+0. `delta === 0` is
   * the reset path; otherwise the value gets added to the current
   * setting and clamped to [8, 32] by the caller. */
  onAdjustEditorFontSize?: (delta: number) => void;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
const MD_EXT = /\.mdx?$/i;
const EXCALIDRAW_EXT = /\.excalidraw$/i;

const EMPTY_EXCALIDRAW = JSON.stringify(
  {
    type: 'excalidraw',
    version: 2,
    source: 'vyb',
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  },
  null,
  2,
);

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

function isMdFile(filename: string): boolean {
  return MD_EXT.test(filename);
}

function isExcalidrawFile(filename: string): boolean {
  return EXCALIDRAW_EXT.test(filename);
}

function getLanguageExtension(filename: string): Extension {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
      return javascript({ jsx: true });
    case 'ts':
    case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'json':
      return json();
    case 'css':
    case 'scss':
      return css();
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return html();
    case 'py':
      return python();
    case 'md':
    case 'mdx':
      return markdown();
    default:
      return [];
  }
}

function parentDir(filePath: string): string {
  return filePath.replace(/\/[^/]+$/, '');
}

function fileName(filePath: string): string {
  return filePath.split('/').pop() || '';
}

// ── Tab type ─────────────────────────────────────────────────────

interface FileTab {
  path: string;
  name: string;
}

// ── Context Menu ─────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  entry: FileEntry | null;
  clipboard: string | null;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onRename: () => void;
  onNewFile: () => void;
  onNewDir: () => void;
  onOpenNewTab: (() => void) | null;
  /** T-026: optional "Show history" callback. Only rendered for files
   * (not directories). Skipped when undefined so dirs / new-file
   * contexts don't see it. */
  onShowHistory: (() => void) | null;
}

function ContextMenu({ x, y, entry, clipboard, onClose, onCopy, onPaste, onDelete, onRename, onNewFile, onNewDir, onOpenNewTab, onShowHistory }: ContextMenuProps) {
  useEffect(() => {
    const handleClick = () => onClose();
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [onClose]);

  return (
    <div className="file-context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      {entry && !entry.isDirectory && onOpenNewTab && (
        <>
          <button className="file-ctx-item" onClick={onOpenNewTab}>
            <span className="file-ctx-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2h7v2h4v10H3V2zm1 1v11h9V5H9V3H4zm6 0v2h2l-2-2z" /></svg>
            </span>
            Open in New Tab
          </button>
          {onShowHistory && (
            <button className="file-ctx-item" onClick={onShowHistory}>
              <span className="file-ctx-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="6" />
                  <path d="M8 4v4l3 2" />
                </svg>
              </span>
              Show history
            </button>
          )}
          <div className="file-ctx-divider" />
        </>
      )}
      {entry && (
        <>
          <button className="file-ctx-item" onClick={onCopy}>
            <span className="file-ctx-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5 1h6.5L14 3.5V11a1 1 0 01-1 1H5a1 1 0 01-1-1V2a1 1 0 011-1zm6 1v2h2M2 5v9a1 1 0 001 1h7" /></svg>
            </span>
            Copy
          </button>
          <button className="file-ctx-item" onClick={onRename}>
            <span className="file-ctx-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9zm-1 4l-7 7v1h1l7-7-1-1z" /></svg>
            </span>
            Rename
          </button>
          <button className="file-ctx-item file-ctx-danger" onClick={onDelete}>
            <span className="file-ctx-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 1h5l.5.5V3h3.5v1H13l-.7 10.2a1 1 0 01-1 .8H4.7a1 1 0 01-1-.8L3 4h-.5V3H6V1.5l.5-.5zM6 3h4V2H6v1z" /></svg>
            </span>
            Delete
          </button>
          <div className="file-ctx-divider" />
        </>
      )}
      <button className="file-ctx-item" onClick={onPaste} disabled={!clipboard}>
        <span className="file-ctx-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 1H6a1 1 0 00-1 1v1H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V4a1 1 0 00-1-1h-2V2a1 1 0 00-1-1zM6 2h4v1H6V2z" /></svg>
        </span>
        Paste
      </button>
      <div className="file-ctx-divider" />
      <button className="file-ctx-item" onClick={onNewFile}>
        <span className="file-ctx-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v3.5H12M7 8v4m-2-2h4" /></svg>
        </span>
        New File
      </button>
      <button className="file-ctx-item" onClick={onNewDir}>
        <span className="file-ctx-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3A1.5 1.5 0 013 1.5h3.3l1.2 1.5H13a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3zM7 7v4m-2-2h4" /></svg>
        </span>
        New Folder
      </button>
    </div>
  );
}

// ── Inline rename input ──────────────────────────────────────────

function InlineInput({ initialValue, onSubmit, onCancel }: {
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const dot = initialValue.lastIndexOf('.');
    if (dot > 0) {
      inputRef.current?.setSelectionRange(0, dot);
    } else {
      inputRef.current?.select();
    }
  }, [initialValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const trimmed = value.trim();
      if (trimmed && trimmed !== initialValue) onSubmit(trimmed);
      else onCancel();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      className="file-inline-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={onCancel}
    />
  );
}

// ── File Tree Node ───────────────────────────────────────────────

function FileTreeNode({
  entry,
  depth,
  selectedPath,
  onSelect,
  onContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  refreshKey,
  revealRequest,
  dragHover,
  onDragStartItem,
  onDragOverItem,
  onDropItem,
  onDragEndItem,
  gitDecorations,
  showHiddenFiles,
}: {
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  renamingPath: string | null;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  refreshKey: number;
  revealRequest: { path: string; nonce: number } | null;
  dragHover: string | null;
  onDragStartItem: (e: React.DragEvent, entry: FileEntry) => void;
  onDragOverItem: (e: React.DragEvent, entry: FileEntry) => void;
  onDropItem: (e: React.DragEvent, entry: FileEntry) => void;
  onDragEndItem: () => void;
  gitDecorations: Map<string, string>;
  showHiddenFiles: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const rowRef = useRef<HTMLDivElement>(null);
  const appliedRevealRef = useRef<number>(-1);

  const loadChildren = useCallback(async () => {
    const entries = await window.api.listDir(entry.path);
    setChildren(entries);
  }, [entry.path]);

  useEffect(() => {
    if (expanded && entry.isDirectory) {
      loadChildren();
    }
  }, [refreshKey, expanded, entry.isDirectory, loadChildren]);

  // External reveal request — expand ancestor directories on the path to
  // the target, and scroll the matching leaf row into view. Nonce-gated so
  // re-clicking the same file from the terminal still triggers expansion
  // even if the user has since collapsed the tree manually.
  useEffect(() => {
    if (!revealRequest) return;
    if (appliedRevealRef.current === revealRequest.nonce) return;
    const target = revealRequest.path;
    const isAncestor =
      entry.isDirectory &&
      (target.startsWith(entry.path + '/') || target.startsWith(entry.path + '\\'));
    if (isAncestor) {
      appliedRevealRef.current = revealRequest.nonce;
      if (!expanded) setExpanded(true);
      return;
    }
    if (!entry.isDirectory && entry.path === target) {
      appliedRevealRef.current = revealRequest.nonce;
      // Wait one frame so the row's final layout (after sibling expansions)
      // is settled before scrolling.
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }, [revealRequest, entry.isDirectory, entry.path, expanded]);

  const handleToggle = async () => {
    if (entry.isDirectory) {
      if (!expanded) {
        await loadChildren();
      }
      setExpanded(!expanded);
    } else {
      onSelect(entry.path);
    }
  };

  const handleCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, entry);
  };

  const isSelected = entry.path === selectedPath;
  const isRenaming = entry.path === renamingPath;
  const dropTargetDir = entry.isDirectory ? entry.path : parentDir(entry.path);
  const isDropTarget = dragHover === dropTargetDir;

  // T-043: git decoration for this row. Map keys are absolute paths
  // (same shape as entry.path), so the lookup is a single get.
  const gitStatus = !entry.isDirectory ? gitDecorations.get(entry.path) : undefined;
  const gitClass = gitStatus ? ` git-${gitStatus}` : '';
  const gitBadge = gitStatus
    ? (gitStatus === 'modified' ? 'M'
      : gitStatus === 'added' ? 'A'
      : gitStatus === 'deleted' ? 'D'
      : gitStatus === 'untracked' ? '?'
      : gitStatus === 'renamed' ? 'R'
      : '')
    : '';

  return (
    <>
      <div
        ref={rowRef}
        className={`file-tree-item${isSelected ? ' file-tree-selected' : ''}${isDropTarget ? ' file-tree-drop-target' : ''}${gitClass}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={handleToggle}
        onContextMenu={handleCtxMenu}
        draggable={!isRenaming}
        onDragStart={(e) => onDragStartItem(e, entry)}
        onDragOver={(e) => onDragOverItem(e, entry)}
        onDrop={(e) => onDropItem(e, entry)}
        onDragEnd={onDragEndItem}
      >
        {entry.isDirectory && (
          <span className="file-tree-arrow" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 3 11 8 6 13" />
            </svg>
          </span>
        )}
        <FileIcon filename={entry.name} isDirectory={entry.isDirectory} isExpanded={expanded} />
        {isRenaming ? (
          <InlineInput
            initialValue={entry.name}
            onSubmit={(newName) => onRenameSubmit(entry.path, newName)}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className="file-tree-name">{entry.name}</span>
        )}
        {gitBadge && <span className="file-tree-git-badge" title={`git: ${gitStatus}`}>{gitBadge}</span>}
      </div>
      {expanded &&
        children
          .filter((child) => showHiddenFiles || !child.name.startsWith('.'))
          .map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            renamingPath={renamingPath}
            onRenameSubmit={onRenameSubmit}
            onRenameCancel={onRenameCancel}
            refreshKey={refreshKey}
            revealRequest={revealRequest}
            dragHover={dragHover}
            onDragStartItem={onDragStartItem}
            onDragOverItem={onDragOverItem}
            onDropItem={onDropItem}
            onDragEndItem={onDragEndItem}
            gitDecorations={gitDecorations}
            showHiddenFiles={showHiddenFiles}
          />
        ))}
    </>
  );
}

// ── Main FileExplorer ────────────────────────────────────────────

export function FileExplorer({
  workingDirectory,
  hidden = false,
  pendingOpenPath,
  onPendingOpenHandled,
  formatOnSave = false,
  stickyScroll: stickyScrollEnabled = true,
  showHiddenFiles = true,
  onAdjustEditorFontSize,
}: FileExplorerProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [modifiedSet, setModifiedSet] = useState<Set<string>>(new Set());
  // Mirror tabs + modifiedSet into refs so the once-attached fs.watch
  // listener (registered in a useEffect with stable deps) can read the
  // latest tab list / dirty flags without re-subscribing on every render.
  const tabsRef = useRef<FileTab[]>([]);
  tabsRef.current = tabs;
  const modifiedSetRef = useRef<Set<string>>(new Set());
  modifiedSetRef.current = modifiedSet;
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Per-tab view/edit mode for .md files. Default is 'view' on first open
  // — Fork-style. Tabs of non-md files just don't appear here. We mirror
  // the state into a ref so `mountEditor` and other useCallback closures
  // can read the current value without forming a stale-state bug.
  const [mdViewMode, setMdViewMode] = useState<Map<string, 'view' | 'edit'>>(new Map());
  const mdViewModeRef = useRef<Map<string, 'view' | 'edit'>>(new Map());
  // Snapshot of the rendered-markdown content per md tab. Updated on
  // (re)mount + on save so the view-mode preview stays fresh without
  // re-reading from disk on every render.
  const [mdContent, setMdContent] = useState<Map<string, string>>(new Map());
  // Per-tab loaded content for `.excalidraw` files. Drives the
  // ExcalidrawEditor's initialContent — gating the editor's mount on this
  // map being populated avoids a race where the editor mounts with `''`
  // before the disk read completes (which would later overwrite the file
  // on save with an empty scene).
  const [excalidrawContent, setExcalidrawContent] = useState<Map<string, string>>(new Map());
  // Drives the tree's auto-expand + scroll-into-view when a file is opened
  // externally (e.g. by clicking a file link in the agent terminal).
  const [revealRequest, setRevealRequest] = useState<{ path: string; nonce: number } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const excalidrawRef = useRef<ExcalidrawEditorHandle | null>(null);
  const activePathRef = useRef<string | null>(null);
  // Store editor doc content per tab so we can restore on switch
  const docCacheRef = useRef<Map<string, string>>(new Map());
  // Last-saved (baseline) content per file — used to clear the dirty flag
  // when the user undoes back to the saved state.
  const savedContentRef = useRef<Map<string, string>>(new Map());

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [clipboard, setClipboard] = useState<string | null>(null);
  // T-043 tab right-click menu state.
  const [tabCtxMenu, setTabCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  // T-043 git decorations for the file tree — map of absolute path
  // to short status code (M/A/D/?/R). Refreshed periodically and
  // whenever the user invokes a tree refresh.
  const [gitDecorations, setGitDecorations] = useState<Map<string, string>>(new Map());
  // T-026: when set, render the FileHistoryView overlay for this path.
  // Cleared by the overlay's close button or Esc keypress.
  const [historyFile, setHistoryFile] = useState<{ path: string; name: string; initialSha?: string }| null>(null);
  // T-027: per-path toggle for the blame gutter, plus cached blame data
  // so reopening a file doesn't refetch unnecessarily. Toggling flips
  // the set and remounts the editor with the gutter included.
  const [blameEnabled, setBlameEnabled] = useState<Set<string>>(new Set());
  const [blameDataByPath, setBlameDataByPath] = useState<Map<string, GitBlameLine[]>>(new Map());
  // Mirrored into refs so `mountEditor` (a useCallback that depends on
  // many stable values) can read the current state without forming a
  // dependency cycle that re-creates the editor on every keystroke.
  const blameEnabledRef = useRef<Set<string>>(new Set());
  blameEnabledRef.current = blameEnabled;
  const blameDataByPathRef = useRef<Map<string, GitBlameLine[]>>(new Map());
  blameDataByPathRef.current = blameDataByPath;
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [creating, setCreating] = useState<{ type: 'file' | 'dir' | 'excalidraw'; dir: string } | null>(null);
  const [treeWidth, setTreeWidth] = useState(240);
  // DnD: source path tracked in a ref (no re-render needed during drag);
  // current target dir in state (drives the drop highlight).
  const dragSourceRef = useRef<string | null>(null);
  const [dragHover, setDragHover] = useState<string | null>(null);

  // Close-tab dialog
  const [closingTabPath, setClosingTabPath] = useState<string | null>(null);

  // Files whose on-disk content differs from what's in the editor AND
  // the editor has unsaved local edits — surfaces a "this file changed
  // outside Vyb" banner so the user can pick: reload (lose local edits)
  // or keep editing (will overwrite the disk version on save).
  const [conflictPaths, setConflictPaths] = useState<Set<string>>(new Set());

  const handleTreeResize = useCallback((delta: number) => {
    setTreeWidth((w) => Math.max(140, Math.min(500, w - delta)));
  }, []);

  const refresh = useCallback(() => {
    window.api.listDir(workingDirectory).then(setRootEntries);
    setRefreshKey((k) => k + 1);
  }, [workingDirectory]);

  /** A file the user has open changed underneath us. If their working
   * copy is clean, reload the buffer silently so they always see the
   * latest disk contents. If they have unsaved edits, flag the tab as
   * conflicted — a banner appears in the editor area letting them
   * choose between "Reload from disk" (drops local edits) and "Keep
   * mine" (ignores the change; the next Save overwrites). */
  const handleExternalFileChange = useCallback(async (absPath: string) => {
    const tab = tabsRef.current.find((t) => t.path === absPath);
    if (!tab) return;
    let diskContent: string | null = null;
    try {
      diskContent = await window.api.readFile(absPath);
    } catch {
      diskContent = null;
    }
    if (diskContent === null) {
      // File was deleted underneath the editor. Best-effort: leave the
      // buffer alone but mark conflict so the user knows the next save
      // will recreate it.
      setConflictPaths((prev) => {
        if (prev.has(absPath)) return prev;
        const next = new Set(prev);
        next.add(absPath);
        return next;
      });
      return;
    }
    const isDirty = modifiedSetRef.current.has(absPath);
    const baseline = savedContentRef.current.get(absPath);
    if (diskContent === baseline) {
      // Spurious watch event (e.g. atime touch on the same content) —
      // nothing to do.
      return;
    }
    if (isDirty) {
      setConflictPaths((prev) => {
        if (prev.has(absPath)) return prev;
        const next = new Set(prev);
        next.add(absPath);
        return next;
      });
      return;
    }
    // Clean — apply the new content silently. Update both the saved
    // baseline (so the dirty detector keeps tracking against the new
    // disk content) and the in-editor doc if this is the active tab.
    docCacheRef.current.set(absPath, diskContent);
    savedContentRef.current.set(absPath, diskContent);
    if (isMdFile(fileName(absPath))) {
      setMdContent((m) => { const n = new Map(m); n.set(absPath, diskContent); return n; });
    }
    if (isExcalidrawFile(fileName(absPath))) {
      setExcalidrawContent((m) => { const n = new Map(m); n.set(absPath, diskContent); return n; });
    }
    if (activePathRef.current === absPath && viewRef.current) {
      const view = viewRef.current;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: diskContent },
      });
    }
  }, []);

  // Subscribe to filesystem changes under workingDirectory. Tree refresh
  // T-043: poll git status periodically to drive tree decorations.
  // Cheap — `getGitChangedFiles` is the same call the Git panel
  // makes. Skipped when the FileExplorer is hidden so we don't spin
  // on background profiles. 10s cadence matches the StatusBar's
  // own poll.
  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const changed = await window.api.getGitChangedFiles(workingDirectory);
        if (cancelled) return;
        const map = new Map<string, string>();
        const base = workingDirectory.replace(/\/+$/, '');
        for (const f of changed) {
          // git returns paths relative to repo root; we key by the
          // absolute path so tree entries (which carry absolute
          // paths) can look up without conversion.
          const abs = `${base}/${f.path}`;
          map.set(abs, f.status);
        }
        setGitDecorations(map);
      } catch { /* not a repo, etc. */ }
    };
    // Initial refresh runs right away; the recurring poll starts on
    // a 5 s offset so it doesn't fire in the same tick as the
    // StatusBar's git status poll (both used to align on mount,
    // doubling main-process load every 10 s). With the offset they
    // alternate every 5 s instead of pile-up every 10 s.
    refresh();
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = setTimeout(() => {
      if (cancelled) return;
      interval = setInterval(refresh, 10_000);
    }, 5_000);
    return () => {
      cancelled = true;
      clearTimeout(start);
      if (interval) clearInterval(interval);
    };
  }, [hidden, workingDirectory, refreshKey]);

  // T-043 reveal-in-tree handler. Bumps the existing revealRequest
  // ref with the current active tab's path so the tree expands its
  // ancestors and scrolls the leaf into view. Wired to a toolbar
  // button and to Cmd+Shift+E.
  const revealActiveInTree = useCallback(() => {
    if (!activeTabPath) return;
    setRevealRequest({ path: activeTabPath, nonce: Date.now() });
  }, [activeTabPath]);

  // Close the tab context menu on outside click.
  useEffect(() => {
    if (!tabCtxMenu) return;
    const handler = () => setTabCtxMenu(null);
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [tabCtxMenu]);

  // T-043: Find & Replace button. Opens CodeMirror's standard
  // search panel, then dispatches the panel's own Mod-Alt-f keymap
  // entry to flip on replace mode. `@codemirror/search` exports
  // `openSearchPanel` but not the "show replace" command, so we
  // synthesise the keystroke against the editor DOM — basicSetup's
  // searchKeymap is what binds Mod-Alt-f to that internal toggle.
  const openFindReplace = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    openSearchPanel(view);
    view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f',
      code: 'KeyF',
      altKey: true,
      metaKey: true,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    }));
  }, []);

  useEffect(() => {
    if (hidden) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        revealActiveInTree();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hidden, revealActiveInTree]);

  // happens on every event; open-tab content gets the silent-reload /
  // conflict-banner treatment via handleExternalFileChange.
  useEffect(() => {
    let cancelled = false;
    let watchId: string | null = null;
    let unsub: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    window.api.watchDir(workingDirectory).then((id) => {
      if (cancelled || !id) return;
      watchId = id;
      unsub = window.api.onFileWatchChange((p) => {
        if (p.watchId !== watchId) return;
        // Debounce tree refresh — fs.watch can fire several events for a
        // single save (rename + write + chmod).
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { refresh(); }, 80);
        // For an open tab whose path matches, reconcile content.
        if (p.absPath) handleExternalFileChange(p.absPath);
      });
    });

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (unsub) unsub();
      if (watchId) window.api.unwatchDir(watchId).catch((): void => undefined);
    };
  }, [workingDirectory, refresh, handleExternalFileChange]);

  // ── DnD move (drag a tree item into another folder) ─────────────
  // We use the same conventions as ReadmeViewer's tree: posix-style `/`
  // separator, custom MIME so we don't react to OS file drops here, and
  // a refusal to move a folder into itself or into a descendant.
  const isValidDndMove = (src: string, targetDir: string): boolean => {
    if (!src || !targetDir) return false;
    if (parentDir(src) === targetDir) return false;
    if (targetDir === src) return false;
    if (targetDir.startsWith(src + '/')) return false;
    return true;
  };

  const handleDragStartItem = useCallback((e: React.DragEvent, entry: FileEntry) => {
    dragSourceRef.current = entry.path;
    e.dataTransfer.setData('application/x-vyb-path', entry.path);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOverItem = useCallback((e: React.DragEvent, entry: FileEntry) => {
    if (!e.dataTransfer.types.includes('application/x-vyb-path')) return;
    const src = dragSourceRef.current;
    if (!src) return;
    const targetDir = entry.isDirectory ? entry.path : parentDir(entry.path);
    if (!isValidDndMove(src, targetDir)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragHover(targetDir);
  }, []);

  const handleDropItem = useCallback(async (e: React.DragEvent, entry: FileEntry) => {
    const src = e.dataTransfer.getData('application/x-vyb-path') || dragSourceRef.current;
    dragSourceRef.current = null;
    setDragHover(null);
    if (!src) return;
    const targetDir = entry.isDirectory ? entry.path : parentDir(entry.path);
    if (!isValidDndMove(src, targetDir)) return;
    e.preventDefault();
    e.stopPropagation();
    const newPath = `${targetDir.replace(/\/$/, '')}/${fileName(src)}`;
    if (newPath === src) return;
    const ok = await window.api.renameFile(src, newPath);
    if (ok) {
      // Follow the file in any open tab so the user doesn't get a
      // mysterious "missing file" after the move.
      setTabs((prev) => prev.map((t) => (t.path === src ? { ...t, path: newPath, name: fileName(newPath) } : t)));
      if (activePathRef.current === src) {
        activePathRef.current = newPath;
        setActiveTabPath(newPath);
      }
      // Move per-tab caches under the new key.
      const cached = docCacheRef.current.get(src);
      if (cached !== undefined) { docCacheRef.current.set(newPath, cached); docCacheRef.current.delete(src); }
      const saved = savedContentRef.current.get(src);
      if (saved !== undefined) { savedContentRef.current.set(newPath, saved); savedContentRef.current.delete(src); }
      if (modifiedSet.has(src)) {
        setModifiedSet((s) => { const n = new Set(s); n.delete(src); n.add(newPath); return n; });
      }
      refresh();
    }
  }, [refresh, modifiedSet]);

  const handleDragEndItem = useCallback(() => {
    dragSourceRef.current = null;
    setDragHover(null);
  }, []);

  // Root drop target — drag a file out of a folder back to the working dir.
  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-vyb-path')) return;
    const src = dragSourceRef.current;
    if (!src || !isValidDndMove(src, workingDirectory)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragHover(workingDirectory);
  }, [workingDirectory]);

  const handleRootDrop = useCallback(async (e: React.DragEvent) => {
    const src = e.dataTransfer.getData('application/x-vyb-path') || dragSourceRef.current;
    dragSourceRef.current = null;
    setDragHover(null);
    if (!src || !isValidDndMove(src, workingDirectory)) return;
    e.preventDefault();
    e.stopPropagation();
    const newPath = `${workingDirectory.replace(/\/$/, '')}/${fileName(src)}`;
    if (newPath === src) return;
    const ok = await window.api.renameFile(src, newPath);
    if (ok) {
      setTabs((prev) => prev.map((t) => (t.path === src ? { ...t, path: newPath, name: fileName(newPath) } : t)));
      if (activePathRef.current === src) {
        activePathRef.current = newPath;
        setActiveTabPath(newPath);
      }
      refresh();
    }
  }, [workingDirectory, refresh]);

  // Load root directory
  useEffect(() => {
    window.api.listDir(workingDirectory).then(setRootEntries);
  }, [workingDirectory]);

  // Cleanup editor on unmount
  useEffect(() => {
    return () => {
      viewRef.current?.destroy();
      // Disable the Edit menu when the file explorer goes away. The menu
      // lives in the application menu (main process), so we have to tell
      // main that we're no longer the editor in scope.
      window.api.setEditMenuState({ hasFile: false, canSave: false });
    };
  }, []);

  // ── Editor helpers ───────────────────────────────────────────

  const saveCurrentDoc = useCallback(() => {
    const path = activePathRef.current;
    if (!path) return;
    if (excalidrawRef.current && isExcalidrawFile(fileName(path))) {
      docCacheRef.current.set(path, excalidrawRef.current.serialize());
      return;
    }
    if (viewRef.current) {
      docCacheRef.current.set(path, viewRef.current.state.doc.toString());
    }
  }, []);

  // T-045: format error (transient toast). Cleared after a few
  // seconds so it doesn't linger after the user has retried.
  const [formatError, setFormatError] = useState<string | null>(null);
  // Mirror formatOnSave into a ref so handleSave (with empty deps)
  // reads the latest value without rebinding when the setting changes.
  const formatOnSaveRef = useRef(formatOnSave);
  formatOnSaveRef.current = formatOnSave;
  // T-046: sticky-scroll toggle. Read by mountEditor at editor
  // construction time — toggling the setting takes effect on the
  // next tab open / remount, not the live editor.
  const stickyScrollEnabledRef = useRef(stickyScrollEnabled);
  stickyScrollEnabledRef.current = stickyScrollEnabled;
  // T-047: mountEditor closes over an empty deps array; ref-shim so
  // the keymap can fire the latest version of the callback even if
  // the prop changes between mounts.
  const onAdjustEditorFontSizeRef = useRef(onAdjustEditorFontSize);
  onAdjustEditorFontSizeRef.current = onAdjustEditorFontSize;

  // T-045: run Prettier against the active editor buffer.
  // Cursor is approximately preserved via line/column snap — Prettier
  // can rewrite arbitrarily, so we don't try for byte-perfect
  // restoration.
  const handleFormat = useCallback(async (): Promise<boolean> => {
    const path = activePathRef.current;
    if (!path) return false;
    const view = viewRef.current;
    if (!view) return false;
    const sel = view.state.selection.main;
    const lineBefore = view.state.doc.lineAt(sel.head);
    const lineNo = lineBefore.number;
    const col = sel.head - lineBefore.from;
    const content = view.state.doc.toString();
    const result = await window.api.formatDocument(path, content);
    if (result.error) {
      setFormatError(result.error);
      setTimeout(() => setFormatError(null), 5000);
      return false;
    }
    if (!result.content || result.content === content) return true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result.content },
    });
    try {
      const targetLine = Math.min(lineNo, view.state.doc.lines);
      const lineAfter = view.state.doc.line(targetLine);
      const pos = Math.min(lineAfter.from + col, lineAfter.to);
      view.dispatch({ selection: EditorSelection.cursor(pos) });
    } catch { /* best-effort */ }
    return true;
  }, []);

  const handleSave = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    // Format-on-save: run Prettier first so what we write to disk
    // and what's in the buffer end up identical. Format failures
    // surface in the toast but don't block the save.
    if (formatOnSaveRef.current && viewRef.current && !isExcalidrawFile(fileName(path))) {
      await handleFormat();
    }
    let content: string | null = null;
    if (excalidrawRef.current && isExcalidrawFile(fileName(path))) {
      content = excalidrawRef.current.serialize();
    } else if (viewRef.current) {
      content = viewRef.current.state.doc.toString();
    }
    if (content === null) return;
    setSaving(true);
    await window.api.saveFile(path, content);
    docCacheRef.current.set(path, content);
    savedContentRef.current.set(path, content);
    setModifiedSet((s) => { const n = new Set(s); n.delete(path); return n; });
    // Save overwrites the disk content with the buffer, so any
    // outstanding conflict warning for this path is now resolved.
    setConflictPaths((prev) => {
      if (!prev.has(path)) return prev;
      const n = new Set(prev);
      n.delete(path);
      return n;
    });
    // Keep the markdown preview in sync so switching to view mode after a
    // save shows the just-saved content.
    if (isMdFile(fileName(path))) {
      setMdContent((m) => { const n = new Map(m); n.set(path, content!); return n; });
    }
    setSaving(false);
  }, []);

  const handleSaveAs = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
    let content: string | null = null;
    if (excalidrawRef.current && isExcalidrawFile(fileName(path))) {
      content = excalidrawRef.current.serialize();
    } else if (viewRef.current) {
      content = viewRef.current.state.doc.toString();
    }
    if (content === null) return;
    const newPath = await window.api.saveFileAs(content, path);
    if (newPath) {
      // Update the tab to point to the new path
      const oldPath = path;
      docCacheRef.current.delete(oldPath);
      docCacheRef.current.set(newPath, content);
      savedContentRef.current.delete(oldPath);
      savedContentRef.current.set(newPath, content);
      setTabs((t) => t.map((tab) => tab.path === oldPath ? { path: newPath, name: fileName(newPath) } : tab));
      setActiveTabPath(newPath);
      activePathRef.current = newPath;
      setModifiedSet((s) => { const n = new Set(s); n.delete(oldPath); return n; });
      refresh();
    }
  }, [refresh]);

  const mountEditor = useCallback(async (filePath: string, gotoLine?: number) => {
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    activePathRef.current = filePath;
    setActiveTabPath(filePath);

    if (isImageFile(fileName(filePath))) return;

    // Use cached content or load from disk. Always populate the cache so
    // both the editor and the markdown-view path read from the same
    // source.
    let content = docCacheRef.current.get(filePath);
    if (content === undefined) {
      content = await window.api.readFile(filePath) || '';
      docCacheRef.current.set(filePath, content);
    }
    // Capture the disk baseline once per file — used to detect undo-to-clean.
    if (!savedContentRef.current.has(filePath)) {
      savedContentRef.current.set(filePath, content);
    }

    // Excalidraw files render via the ExcalidrawEditor component (sibling of
    // the CodeMirror host). Stash the loaded content in state so the editor
    // only mounts once it's available — otherwise it'd mount with an empty
    // scene before the disk read finishes and the next save would clobber
    // the file.
    if (isExcalidrawFile(fileName(filePath))) {
      setExcalidrawContent((m) => { const n = new Map(m); n.set(filePath, content!); return n; });
      return;
    }

    // Markdown files default to view mode and skip the CodeMirror mount.
    // We still preload the content so the rendered preview is instant.
    // Read from the ref (not state) so a freshly-toggled mode is seen
    // even when this callback was captured under the previous render.
    if (isMdFile(fileName(filePath))) {
      let mode = mdViewModeRef.current.get(filePath);
      if (mode === undefined) {
        mode = 'view';
        const next = new Map(mdViewModeRef.current);
        next.set(filePath, mode);
        mdViewModeRef.current = next;
        setMdViewMode(next);
      }
      setMdContent((m) => { const n = new Map(m); n.set(filePath, content!); return n; });
      if (mode === 'view') return;
      // Otherwise fall through to mount the editor.
    }

    if (!editorRef.current) return;

    const lang = getLanguageExtension(fileName(filePath));
    const thisPath = filePath;

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
        // T-027 blame gutter. Only included when blame is toggled on
        // for this path. The empty-array fallback (built into
        // `blameGutter`) makes this a no-op otherwise.
        ...(blameEnabledRef.current.has(thisPath) && blameDataByPathRef.current.has(thisPath)
          ? [blameGutter(blameDataByPathRef.current.get(thisPath)!, (sha) => {
            const name = thisPath.split('/').pop() || thisPath;
            const relPath = thisPath.startsWith(workingDirectory)
              ? thisPath.slice(workingDirectory.length).replace(/^\/+/, '')
              : thisPath;
            setHistoryFile({ path: relPath, name, initialSha: sha });
          })]
          : []),
        // T-046 sticky scroll. Plugin no-ops when the open file's
        // language doesn't expose scope nodes (plain text, JSON, etc.),
        // so it's safe to include for every buffer.
        ...(stickyScrollEnabledRef.current ? [stickyScroll()] : []),
        ...(Array.isArray(lang) ? lang : [lang]),
        keymap.of([
          { key: 'Mod-s', run: () => { handleSave(); return true; } },
          { key: 'Mod-Shift-s', run: () => { handleSaveAs(); return true; } },
          { key: 'Shift-Alt-f', run: () => { handleFormat(); return true; } },
          // T-047 font-size shortcuts. `Mod-+` is the same physical
          // key as `Mod-=` on a US layout; both are bound so users
          // who hit Shift can still bump up.
          { key: 'Mod-=', run: () => { onAdjustEditorFontSizeRef.current?.(+1); return true; } },
          { key: 'Mod-+', run: () => { onAdjustEditorFontSizeRef.current?.(+1); return true; } },
          { key: 'Mod--', run: () => { onAdjustEditorFontSizeRef.current?.(-1); return true; } },
          { key: 'Mod-0', run: () => { onAdjustEditorFontSizeRef.current?.(0); return true; } },
          // Clipboard. CodeMirror 6 normally relies on the browser's native
          // copy/cut/paste events, but Electron on macOS doesn't fire those
          // for Cmd+C/V/X without an Edit-menu role accelerator (which we
          // deliberately don't register so xterm.js can keep Cmd+C). So we
          // bind them in the keymap and route through navigator.clipboard.
          {
            key: 'Mod-c',
            run: (view) => {
              const sel = view.state.selection.main;
              if (sel.empty) return false;
              const text = view.state.sliceDoc(sel.from, sel.to);
              navigator.clipboard.writeText(text).catch((): void => undefined);
              return true;
            },
          },
          {
            key: 'Mod-x',
            run: (view) => {
              const sel = view.state.selection.main;
              if (sel.empty) return false;
              const text = view.state.sliceDoc(sel.from, sel.to);
              navigator.clipboard.writeText(text).catch((): void => undefined);
              view.dispatch({
                changes: { from: sel.from, to: sel.to, insert: '' },
                selection: EditorSelection.cursor(sel.from),
                scrollIntoView: true,
              });
              return true;
            },
          },
          {
            key: 'Mod-v',
            run: (view) => {
              navigator.clipboard.readText().then((text) => {
                if (!text) return;
                const sel = view.state.selection.main;
                view.dispatch({
                  changes: { from: sel.from, to: sel.to, insert: text },
                  selection: EditorSelection.cursor(sel.from + text.length),
                  scrollIntoView: true,
                });
              }).catch((): void => undefined);
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const baseline = savedContentRef.current.get(thisPath);
          const matchesSaved = baseline !== undefined && update.state.doc.toString() === baseline;
          setModifiedSet((s) => {
            if (matchesSaved) {
              if (!s.has(thisPath)) return s;
              const n = new Set(s); n.delete(thisPath); return n;
            }
            if (s.has(thisPath)) return s;
            return new Set(s).add(thisPath);
          });
        }),
        EditorView.theme({
          // T-047 — driven by --cm-editor-font-size on :root.
          // Background uses --c-base so the editor matches the agent
          // terminal's background exactly (same Catppuccin Mocha
          // surface). Gutters get the same so the line-number column
          // doesn't look like a different surface.
          '&': {
            height: '100%',
            fontSize: 'var(--cm-editor-font-size, 13px)',
            backgroundColor: 'var(--c-base)',
            color: 'var(--c-text)',
          },
          '.cm-scroller': { overflow: 'auto', backgroundColor: 'var(--c-base)' },
          '.cm-content': { fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace", caretColor: 'var(--c-rosewater)' },
          // Gutters: cover both the container and each individual
          // gutter element because oneDark colours `.cm-gutter`
          // separately and would otherwise show through.
          '.cm-gutters': {
            backgroundColor: 'var(--c-base)',
            color: 'var(--c-overlay0)',
            borderRight: '1px solid var(--c-surface0)',
          },
          '.cm-gutter': { backgroundColor: 'var(--c-base)' },
          '.cm-lineNumbers': { backgroundColor: 'var(--c-base)' },
          '.cm-foldGutter': { backgroundColor: 'var(--c-base)' },
          '.cm-gutterElement': { backgroundColor: 'transparent' },
          '.cm-activeLine': { backgroundColor: 'var(--c-surface0)' },
          '.cm-activeLineGutter': { backgroundColor: 'var(--c-surface0)' },

          // ── Search panel (Cmd+F / Cmd+Shift+F) — match app aesthetic ──
          '.cm-panels': {
            background: 'var(--c-mantle)',
            color: 'var(--c-text)',
            fontFamily: 'inherit',
          },
          '.cm-panels.cm-panels-top': {
            borderBottom: '1px solid var(--c-surface1)',
          },
          '.cm-panels.cm-panels-bottom': {
            borderTop: '1px solid var(--c-surface1)',
          },
          '.cm-panel.cm-search': {
            padding: '8px 36px 8px 10px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            position: 'relative',
          },
          '.cm-panel.cm-search input.cm-textfield': {
            background: 'var(--c-base)',
            border: '1px solid var(--c-surface1)',
            borderRadius: '6px',
            color: 'var(--c-text)',
            padding: '4px 8px',
            fontSize: '12px',
            fontFamily: 'inherit',
            margin: 0,
            height: '26px',
            outline: 'none',
            transition: 'border-color 100ms',
          },
          '.cm-panel.cm-search input.cm-textfield:focus': {
            borderColor: 'var(--c-overlay1)',
          },
          '.cm-panel.cm-search button': {
            background: 'transparent',
            border: '1px solid var(--c-surface1)',
            borderRadius: '6px',
            color: 'var(--c-text)',
            padding: '0 10px',
            fontSize: '11px',
            fontWeight: '500',
            fontFamily: 'inherit',
            cursor: 'pointer',
            height: '26px',
            margin: 0,
            textTransform: 'none',
            transition: 'background 100ms, border-color 100ms',
          },
          '.cm-panel.cm-search button:hover': {
            background: 'rgba(255, 255, 255, 0.05)',
            borderColor: 'var(--c-surface2)',
          },
          '.cm-panel.cm-search label': {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            color: 'var(--c-subtext0)',
            cursor: 'pointer',
            margin: '0 2px',
          },
          '.cm-panel.cm-search label input[type="checkbox"]': {
            margin: 0,
            cursor: 'pointer',
          },
          '.cm-panel.cm-search button[name="close"]': {
            position: 'absolute',
            top: '6px',
            right: '6px',
            width: '22px',
            height: '22px',
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--c-overlay0)',
            fontSize: '18px',
            lineHeight: '20px',
            borderRadius: '4px',
          },
          '.cm-panel.cm-search button[name="close"]:hover': {
            color: 'var(--c-text)',
            background: 'rgba(255, 255, 255, 0.06)',
            borderColor: 'transparent',
          },

          // ── Search match highlights inside the editor ──
          '.cm-searchMatch': {
            background: 'color-mix(in srgb, var(--c-yellow) 25%, transparent)',
            borderRadius: '2px',
          },
          '.cm-searchMatch-selected': {
            background: 'color-mix(in srgb, var(--c-yellow) 50%, transparent)',
            outline: '1px solid var(--c-yellow)',
          },
        }),
      ],
    });

    viewRef.current = new EditorView({ state, parent: editorRef.current });

    // Jump to the requested line (1-based, clamped to the doc range)
    // when the caller asked for a specific row — e.g. a click on
    // `file.py:254-273` in the agent terminal.
    if (gotoLine && gotoLine > 0) {
      try {
        const view = viewRef.current;
        const clamped = Math.min(view.state.doc.lines, Math.max(1, gotoLine));
        const lineInfo = view.state.doc.line(clamped);
        view.dispatch({
          selection: EditorSelection.cursor(lineInfo.from),
          scrollIntoView: true,
        });
        // Give scrollIntoView a frame to settle, then focus so the user
        // can start typing/navigating from the target row.
        requestAnimationFrame(() => view.focus());
      } catch {
        // best-effort — corrupt doc state shouldn't break the open.
      }
    }
  }, [handleSave, handleSaveAs, handleFormat]);

  // ── Tab management ───────────────────────────────────────────

  const openInTab = useCallback((filePath: string, forceNew: boolean, gotoLine?: number) => {
    if (isImageFile(fileName(filePath))) {
      // Images: always open directly, no tab reuse logic for modified check
    }

    const existingIdx = tabs.findIndex((t) => t.path === filePath);
    if (existingIdx >= 0) {
      // Tab already open — switch to it
      saveCurrentDoc();
      mountEditor(filePath, gotoLine);
      return;
    }

    const newTab: FileTab = { path: filePath, name: fileName(filePath) };

    if (forceNew || (activePathRef.current && modifiedSet.has(activePathRef.current))) {
      // Open in new tab (keep current modified tab)
      saveCurrentDoc();
      setTabs((t) => [...t, newTab]);
      mountEditor(filePath, gotoLine);
    } else if (tabs.length === 0) {
      // No tabs yet
      setTabs([newTab]);
      mountEditor(filePath, gotoLine);
    } else {
      // Reuse active tab (no modifications)
      saveCurrentDoc();
      const activePath = activePathRef.current;
      docCacheRef.current.delete(activePath || '');
      savedContentRef.current.delete(activePath || '');
      setTabs((t) => t.map((tab) => tab.path === activePath ? newTab : tab));
      mountEditor(filePath, gotoLine);
    }
  }, [tabs, modifiedSet, saveCurrentDoc, mountEditor]);

  const switchTab = useCallback((filePath: string) => {
    if (filePath === activePathRef.current) return;
    saveCurrentDoc();
    mountEditor(filePath);
  }, [saveCurrentDoc, mountEditor]);

  // External open-file request (e.g. file link clicked in the agent
  // terminal). Opens in a new tab so we don't clobber unsaved work in the
  // active tab; if the file is already open we just switch to its tab.
  // Also drives the tree to expand the path and scroll the row into view.
  useEffect(() => {
    if (hidden) return;
    if (!pendingOpenPath) return;
    openInTab(pendingOpenPath.path, true, pendingOpenPath.line);
    setRevealRequest({ path: pendingOpenPath.path, nonce: pendingOpenPath.nonce });
    onPendingOpenHandled?.();
  }, [hidden, pendingOpenPath, openInTab, onPendingOpenHandled]);

  const closeTab = useCallback((filePath: string) => {
    if (modifiedSet.has(filePath)) {
      setClosingTabPath(filePath);
      return;
    }
    doCloseTab(filePath);
  }, [modifiedSet]);

  // T-043 tab right-click ops. Close-others / close-to-right operate
  // on the snapshot of `tabs` taken when the menu was opened so
  // mid-iteration mutations don't drop the wrong ones.
  const closeOthers = useCallback((keepPath: string) => {
    const targets = tabs.map((t) => t.path).filter((p) => p !== keepPath);
    for (const p of targets) closeTab(p);
  }, [tabs, closeTab]);

  const closeToRight = useCallback((pivotPath: string) => {
    const idx = tabs.findIndex((t) => t.path === pivotPath);
    if (idx < 0) return;
    const targets = tabs.slice(idx + 1).map((t) => t.path);
    for (const p of targets) closeTab(p);
  }, [tabs, closeTab]);

  const closeAllTabs = useCallback(() => {
    for (const t of tabs.slice()) closeTab(t.path);
  }, [tabs, closeTab]);

  const doCloseTab = useCallback((filePath: string) => {
    docCacheRef.current.delete(filePath);
    savedContentRef.current.delete(filePath);
    setExcalidrawContent((m) => {
      if (!m.has(filePath)) return m;
      const n = new Map(m);
      n.delete(filePath);
      return n;
    });
    setModifiedSet((s) => { const n = new Set(s); n.delete(filePath); return n; });
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== filePath);
      if (activePathRef.current === filePath) {
        if (next.length > 0) {
          // Switch to neighbor tab
          const oldIdx = prev.findIndex((t) => t.path === filePath);
          const newIdx = Math.min(oldIdx, next.length - 1);
          mountEditor(next[newIdx].path);
        } else {
          // No tabs left
          if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null; }
          activePathRef.current = null;
          setActiveTabPath(null);
        }
      }
      return next;
    });
  }, [mountEditor]);

  // Close-tab dialog handlers
  const handleCloseTabSave = useCallback(async () => {
    if (!closingTabPath) return;
    // Save the file being closed
    const content = docCacheRef.current.get(closingTabPath);
    if (content !== undefined) {
      await window.api.saveFile(closingTabPath, content);
    }
    const p = closingTabPath;
    setClosingTabPath(null);
    doCloseTab(p);
  }, [closingTabPath, doCloseTab]);

  const handleCloseTabDiscard = useCallback(() => {
    if (!closingTabPath) return;
    const p = closingTabPath;
    setModifiedSet((s) => { const n = new Set(s); n.delete(p); return n; });
    setClosingTabPath(null);
    doCloseTab(p);
  }, [closingTabPath, doCloseTab]);

  // ── Tree file selection ──────────────────────────────────────

  const handleSelectFile = useCallback((filePath: string) => {
    openInTab(filePath, false);
  }, [openInTab]);

  // ── File operations ──────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const handleTreeContextMenu = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.file-tree-item')) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry: null });
  }, []);

  const handleCopy = useCallback(() => {
    if (ctxMenu?.entry) setClipboard(ctxMenu.entry.path);
    setCtxMenu(null);
  }, [ctxMenu]);

  // T-027: toggle the blame gutter for the active tab. On first
  // enable we fetch via `git blame --line-porcelain`, cache it, and
  // remount the editor. Subsequent toggles reuse the cached data.
  // When the file's modified buffer drifts from disk the cached blame
  // is stale; we mark the file's blame as off in that case to avoid
  // visual misalignment — the user can re-enable after saving.
  const toggleBlame = useCallback(async () => {
    if (!activeTabPath) return;
    const enabled = blameEnabledRef.current.has(activeTabPath);
    if (enabled) {
      const next = new Set(blameEnabledRef.current);
      next.delete(activeTabPath);
      setBlameEnabled(next);
      mountEditor(activeTabPath);
      return;
    }
    const relPath = activeTabPath.startsWith(workingDirectory)
      ? activeTabPath.slice(workingDirectory.length).replace(/^\/+/, '')
      : activeTabPath;
    let data = blameDataByPathRef.current.get(activeTabPath);
    if (!data) {
      data = await window.api.gitBlameFile(workingDirectory, relPath);
      if (!data || data.length === 0) {
        // Likely outside a git repo or file untracked — surface a
        // soft no-op rather than spinning forever. The button doesn't
        // disable yet (V2: detect repo state up front).
        return;
      }
      setBlameDataByPath((prev) => new Map(prev).set(activeTabPath, data!));
    }
    const next = new Set(blameEnabledRef.current);
    next.add(activeTabPath);
    setBlameEnabled(next);
    mountEditor(activeTabPath);
  }, [activeTabPath, workingDirectory, mountEditor]);

  // T-026: open the file-history overlay for the right-clicked entry.
  // Only wired for files (not directories) via the ContextMenu prop.
  const handleShowHistory = useCallback(() => {
    if (ctxMenu?.entry && !ctxMenu.entry.isDirectory) {
      const relPath = ctxMenu.entry.path.startsWith(workingDirectory)
        ? ctxMenu.entry.path.slice(workingDirectory.length).replace(/^\/+/, '')
        : ctxMenu.entry.path;
      setHistoryFile({ path: relPath, name: ctxMenu.entry.name });
    }
    setCtxMenu(null);
  }, [ctxMenu, workingDirectory]);

  // Paste with an explicit target dir. Right-click "Paste" uses
  // `handlePaste` (below) which picks the target from the context
  // menu; the file-tree keyboard handler calls this directly to
  // skip the menu state.
  const pasteIntoDir = useCallback(async (targetDir: string) => {
    if (!clipboard) return;
    const name = clipboard.split('/').pop() || '';
    let destPath = `${targetDir}/${name}`;
    let i = 0;
    const baseName = name.replace(/(\.[^.]+)$/, '');
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    while (await window.api.readFile(destPath) !== null || destPath === clipboard) {
      i++;
      destPath = `${targetDir}/${baseName} copy${i > 1 ? ` ${i}` : ''}${ext}`;
    }
    await window.api.copyFile(clipboard, destPath);
    refresh();
  }, [clipboard, refresh]);

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    const targetDir = ctxMenu?.entry?.isDirectory
      ? ctxMenu.entry.path
      : ctxMenu?.entry
        ? parentDir(ctxMenu.entry.path)
        : workingDirectory;
    setCtxMenu(null);
    await pasteIntoDir(targetDir);
  }, [clipboard, ctxMenu, workingDirectory, pasteIntoDir]);

  const handleDelete = useCallback(() => {
    if (ctxMenu?.entry) setDeleteTarget(ctxMenu.entry);
    setCtxMenu(null);
  }, [ctxMenu]);

  // Keyboard Cmd+C / Cmd+V inside the file tree pane. The right-click
  // Copy / Paste menu items already work; this just makes the
  // matching shortcuts behave the same way. Cmd+C copies the path of
  // the currently-active tab (what the user has open in the editor);
  // Cmd+V pastes into that file's parent directory. Falls back to
  // the working directory when no tab is open.
  useEffect(() => {
    if (hidden) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'c' && key !== 'v') return;
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      // Only intercept when the keystroke originated inside the tree
      // pane. Editor / CodeMirror / inputs / xterm all have their
      // own handling further up the chain.
      if (!target.closest('.file-tree-pane')) return;
      // Stay out of edit-in-place inputs (rename / new file/folder).
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (key === 'c') {
        if (activeTabPath) {
          e.preventDefault();
          setClipboard(activeTabPath);
        }
      } else if (key === 'v') {
        if (clipboard) {
          e.preventDefault();
          const targetDir = activeTabPath ? parentDir(activeTabPath) : workingDirectory;
          pasteIntoDir(targetDir);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hidden, activeTabPath, clipboard, workingDirectory, pasteIntoDir]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    await window.api.deleteFile(deleteTarget.path);
    // Close tab if open
    const tabOpen = tabs.find((t) => t.path === deleteTarget.path);
    if (tabOpen) {
      setModifiedSet((s) => { const n = new Set(s); n.delete(deleteTarget.path); return n; });
      doCloseTab(deleteTarget.path);
    }
    setDeleteTarget(null);
    refresh();
  }, [deleteTarget, tabs, doCloseTab, refresh]);

  const handleRename = useCallback(() => {
    if (ctxMenu?.entry) setRenamingPath(ctxMenu.entry.path);
    setCtxMenu(null);
  }, [ctxMenu]);

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    const dir = parentDir(oldPath);
    const newPath = `${dir}/${newName}`;
    await window.api.renameFile(oldPath, newPath);
    // Update tab if open
    setTabs((t) => t.map((tab) => tab.path === oldPath ? { path: newPath, name: newName } : tab));
    if (activePathRef.current === oldPath) {
      activePathRef.current = newPath;
      setActiveTabPath(newPath);
    }
    const cached = docCacheRef.current.get(oldPath);
    if (cached !== undefined) {
      docCacheRef.current.delete(oldPath);
      docCacheRef.current.set(newPath, cached);
    }
    const baseline = savedContentRef.current.get(oldPath);
    if (baseline !== undefined) {
      savedContentRef.current.delete(oldPath);
      savedContentRef.current.set(newPath, baseline);
    }
    setRenamingPath(null);
    refresh();
  }, [refresh]);

  const handleOpenNewTab = useCallback(() => {
    if (ctxMenu?.entry && !ctxMenu.entry.isDirectory) {
      openInTab(ctxMenu.entry.path, true);
    }
    setCtxMenu(null);
  }, [ctxMenu, openInTab]);

  const handleNewFile = useCallback(() => {
    const dir = ctxMenu?.entry?.isDirectory
      ? ctxMenu.entry.path
      : ctxMenu?.entry
        ? parentDir(ctxMenu.entry.path)
        : workingDirectory;
    setCreating({ type: 'file', dir });
    setCtxMenu(null);
  }, [ctxMenu, workingDirectory]);

  const handleNewDir = useCallback(() => {
    const dir = ctxMenu?.entry?.isDirectory
      ? ctxMenu.entry.path
      : ctxMenu?.entry
        ? parentDir(ctxMenu.entry.path)
        : workingDirectory;
    setCreating({ type: 'dir', dir });
    setCtxMenu(null);
  }, [ctxMenu, workingDirectory]);

  const handleCreateSubmit = useCallback(async (name: string) => {
    if (!creating) return;
    const fullPath = `${creating.dir}/${name}`;
    if (creating.type === 'dir') {
      await window.api.createDir(fullPath);
    } else if (creating.type === 'excalidraw') {
      // Make sure the new file ends in `.excalidraw` so isExcalidrawFile()
      // routes it to the Excalidraw editor on first open.
      const finalPath = isExcalidrawFile(name) ? fullPath : `${fullPath}.excalidraw`;
      await window.api.saveFile(finalPath, EMPTY_EXCALIDRAW);
    } else {
      await window.api.createFile(fullPath);
    }
    setCreating(null);
    refresh();
  }, [creating, refresh]);

  const activeIsImage = activeTabPath ? isImageFile(fileName(activeTabPath)) : false;
  const activeIsMd = activeTabPath ? isMdFile(fileName(activeTabPath)) : false;
  const activeIsExcalidraw = activeTabPath ? isExcalidrawFile(fileName(activeTabPath)) : false;
  const activeIsModified = activeTabPath ? modifiedSet.has(activeTabPath) : false;
  // For markdown tabs: 'view' (default) renders the rendered markdown,
  // 'edit' mounts CodeMirror.
  const activeMdMode: 'view' | 'edit' = activeTabPath
    ? (mdViewMode.get(activeTabPath) ?? 'view')
    : 'view';
  const activeMdShowing = activeIsMd && activeMdMode === 'view';

  // Toggle a markdown tab between view and edit. edit→view auto-saves
  // dirty content first; view→edit mounts CodeMirror with the latest
  // disk content. We update both the ref AND state so the next render
  // shows the new mode and any callback that reads `mdViewModeRef.current`
  // (notably `mountEditor`) sees it synchronously.
  const toggleMdMode = useCallback(async () => {
    if (!activeTabPath || !activeIsMd) return;
    const path = activeTabPath;
    const current = mdViewModeRef.current.get(path) ?? 'view';
    const next = current === 'view' ? 'edit' : 'view';
    if (next === 'view' && viewRef.current && modifiedSet.has(path)) {
      // Auto-save before flipping to view so the rendered preview is
      // up-to-date.
      await handleSave();
    }
    const updated = new Map(mdViewModeRef.current);
    updated.set(path, next);
    mdViewModeRef.current = updated;
    setMdViewMode(updated);
    if (next === 'edit') {
      // Mount the editor — needs a frame so the host div has flipped
      // back to display:block before we attach CodeMirror.
      requestAnimationFrame(() => { mountEditor(path); });
    } else if (viewRef.current) {
      // Tear down the editor when leaving edit mode.
      viewRef.current.destroy();
      viewRef.current = null;
      // Refresh the rendered content from the in-memory cache.
      const cached = docCacheRef.current.get(path);
      if (cached !== undefined) {
        setMdContent((m) => { const n = new Map(m); n.set(path, cached); return n; });
      }
    }
  }, [activeTabPath, activeIsMd, modifiedSet, handleSave, mountEditor]);

  // Memoise the markdown components prop — same trick as ReadmeViewer.
  // Inline components on every render would cause react-markdown to
  // remount custom blocks (notably MermaidBlock) and re-render their
  // SVGs from scratch each time the parent updates.
  const markdownComponents = useMemo(() => ({
    code(props: { className?: string; children?: React.ReactNode; inline?: boolean }) {
      const { className, children, ...rest } = props;
      const lang = /language-(\w+)/.exec(className ?? '')?.[1];
      if (lang === 'mermaid') {
        return <MermaidBlock code={String(children ?? '').trim()} />;
      }
      return <code className={className} {...rest}>{children}</code>;
    },
  }), []);

  // Keep the application Edit menu (main process) in sync with what's actually
  // editable here: text-file open ⇒ items enabled; modified ⇒ Save enabled too.
  // Skip when hidden so a background FileExplorer doesn't fight the visible
  // one for the menu state.
  useEffect(() => {
    if (hidden) return;
    window.api.setEditMenuState({
      hasFile: !!activeTabPath && !activeIsImage,
      canSave: !!activeTabPath && !activeIsImage && activeIsModified,
    });
  }, [hidden, activeTabPath, activeIsImage, activeIsModified]);

  // Handle clicks coming back from the Edit menu in the application menu.
  // CodeMirror's basicSetup already binds Cmd+Z / Cmd+F / etc. to the editor,
  // so this only runs when the user clicks the menu item itself. Hidden
  // instances ignore menu clicks so they don't act on the visible one's
  // behalf.
  useEffect(() => {
    if (hidden) return;
    const unsub = window.api.onEditMenuAction(async (action: EditMenuAction) => {
      if (action === 'save') { handleSave(); return; }
      if (action === 'saveAs') { handleSaveAs(); return; }

      const view = viewRef.current;
      if (!view) return;
      view.focus();

      if (action === 'undo') { undo(view); return; }
      if (action === 'redo') { redo(view); return; }
      if (action === 'find') { openSearchPanel(view); return; }
      if (action === 'selectAll') {
        view.dispatch({
          selection: EditorSelection.single(0, view.state.doc.length),
        });
        return;
      }

      const sel = view.state.selection.main;
      if (action === 'copy' || action === 'cut') {
        const text = view.state.sliceDoc(sel.from, sel.to);
        if (text) {
          try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
        }
        if (action === 'cut' && !sel.empty) {
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: '' },
            selection: EditorSelection.cursor(sel.from),
            scrollIntoView: true,
          });
        }
        return;
      }
      if (action === 'paste') {
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch { /* ignore */ }
        if (!text) return;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: EditorSelection.cursor(sel.from + text.length),
          scrollIntoView: true,
        });
        return;
      }
    });
    return unsub;
  }, [hidden, handleSave, handleSaveAs]);

  return (
    <div
      className="file-explorer"
      style={hidden ? { display: 'none' } : undefined}
    >
      <div className="file-editor-pane">
        {/* Tab bar — tabs only. Action buttons live in the toolbar
            below the tab bar. */}
        <div className="file-tab-bar">
          <div className="file-tabs-scroll">
            {tabs.map((tab) => {
              const isActive = tab.path === activeTabPath;
              const isMod = modifiedSet.has(tab.path);
              return (
                <div
                  key={tab.path}
                  className={`file-tab ${isActive ? 'file-tab-active' : ''}`}
                  onClick={() => switchTab(tab.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabCtxMenu({ x: e.clientX, y: e.clientY, path: tab.path });
                  }}
                  title={tab.path}
                >
                  <FileIcon filename={tab.name} isDirectory={false} />
                  <span className="file-tab-name">{tab.name}{isMod ? ' *' : ''}</span>
                  <button
                    className="file-tab-close"
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
                    title="Close"
                  >
                    <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor">
                      <path d="M1.7 0.3a1 1 0 00-1.4 1.4L5.6 7l-5.3 5.3a1 1 0 101.4 1.4L7 8.4l5.3 5.3a1 1 0 001.4-1.4L8.4 7l5.3-5.3a1 1 0 00-1.4-1.4L7 5.6 1.7 0.3z" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Action toolbar — sits below the tab bar so the tabs stay
            at the top while frequently-used actions hang just above
            the editor body. */}
        {activeTabPath && !activeIsImage && (
          <div className="file-editor-toolbar">
            <button
              className="file-tab-action-btn"
              onClick={handleSave}
              disabled={saving || !activeIsModified}
              title="Save (Cmd+S)"
            >
              Save
            </button>
            <button
              className="file-tab-action-btn"
              onClick={handleSaveAs}
              disabled={saving}
              title="Save As (Cmd+Shift+S)"
            >
              Save As
            </button>
            <button
              className={`file-tab-action-btn ${blameEnabled.has(activeTabPath) ? 'is-active' : ''}`}
              onClick={toggleBlame}
              title={blameEnabled.has(activeTabPath) ? 'Hide blame gutter' : 'Show blame gutter (git blame)'}
            >
              Blame
            </button>
            <button
              className="file-tab-action-btn"
              onClick={openFindReplace}
              title="Find and Replace (Cmd+Alt+F)"
              disabled={!activeTabPath || activeIsImage}
            >
              Find/Replace
            </button>
            <button
              className="file-tab-action-btn"
              onClick={revealActiveInTree}
              title="Reveal this file in the tree (Cmd+Shift+E)"
              disabled={!activeTabPath}
            >
              Reveal
            </button>
            <button
              className="file-tab-action-btn"
              onClick={handleFormat}
              title="Format with Prettier (Shift+Alt+F)"
              disabled={!activeTabPath || activeIsImage || activeIsExcalidraw}
            >
              Format
            </button>
            {activeIsMd && (
              <button
                className={`file-tab-action-btn ${activeMdMode === 'edit' ? 'is-active' : ''}`}
                onClick={toggleMdMode}
                title={activeMdMode === 'view' ? 'Edit markdown source' : 'View rendered markdown'}
              >
                {activeMdMode === 'view' ? (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1.5 8s2-5 6.5-5 6.5 5 6.5 5-2 5-6.5 5S1.5 8 1.5 8z" />
                    <circle cx="8" cy="8" r="2" />
                  </svg>
                )}
              </button>
            )}
          </div>
        )}

        {/* External-change conflict banner — visible when this tab's
            disk content changed while the user had unsaved edits. */}
        {activeTabPath && conflictPaths.has(activeTabPath) && (
          <div className="file-conflict-banner">
            <span className="file-conflict-msg">
              This file changed outside Vyb and your edits are unsaved.
            </span>
            <button
              className="file-conflict-btn"
              onClick={async () => {
                const path = activeTabPath;
                const diskContent = await window.api.readFile(path);
                if (diskContent === null) return;
                docCacheRef.current.set(path, diskContent);
                savedContentRef.current.set(path, diskContent);
                setModifiedSet((s) => { const n = new Set(s); n.delete(path); return n; });
                if (isMdFile(fileName(path))) {
                  setMdContent((m) => { const n = new Map(m); n.set(path, diskContent); return n; });
                }
                if (isExcalidrawFile(fileName(path))) {
                  setExcalidrawContent((m) => { const n = new Map(m); n.set(path, diskContent); return n; });
                }
                if (viewRef.current) {
                  const view = viewRef.current;
                  view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: diskContent },
                  });
                }
                setConflictPaths((prev) => { const n = new Set(prev); n.delete(path); return n; });
              }}
            >
              Reload from disk
            </button>
            <button
              className="file-conflict-btn file-conflict-btn-secondary"
              onClick={() => {
                if (!activeTabPath) return;
                setConflictPaths((prev) => { const n = new Set(prev); n.delete(activeTabPath); return n; });
              }}
            >
              Keep mine
            </button>
          </div>
        )}

        {/* Editor area */}
        {activeTabPath && activeIsImage && (
          <div className="file-image-viewer">
            <img src={`local-file://${activeTabPath}`} alt={fileName(activeTabPath)} />
          </div>
        )}
        {/* Markdown view mode — replaces the editor with rendered markdown.
            Editor host stays in the DOM (just hidden) so toggling back to
            edit can re-mount it without React tearing down the parent. */}
        {activeMdShowing && activeTabPath && (
          <div className="file-md-content readme-content">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {mdContent.get(activeTabPath) ?? ''}
            </Markdown>
          </div>
        )}
        {/* Excalidraw editor — same swap-with-CodeMirror pattern as the md
            view above. Keyed on the path so a tab switch fully remounts the
            canvas with fresh initialData (Excalidraw doesn't observe its
            initialData prop after mount). Gated on `excalidrawContent.has`
            so we never mount before the disk read finishes — mounting empty
            and then saving would otherwise wipe the file. */}
        {activeIsExcalidraw && activeTabPath && excalidrawContent.has(activeTabPath) && (
          <ExcalidrawEditor
            ref={excalidrawRef}
            key={activeTabPath}
            filePath={activeTabPath}
            initialContent={excalidrawContent.get(activeTabPath) ?? ''}
            savedBaseline={savedContentRef.current.get(activeTabPath) ?? ''}
            theme="dark"
            onModifiedChange={(modified) => {
              setModifiedSet((s) => {
                const has = s.has(activeTabPath);
                if (has === modified) return s;
                const n = new Set(s);
                if (modified) n.add(activeTabPath); else n.delete(activeTabPath);
                return n;
              });
            }}
            onSaveRequested={handleSave}
          />
        )}
        <div
          className="file-editor-content"
          ref={editorRef}
          style={{
            display: activeTabPath && !activeIsImage && !activeMdShowing && !activeIsExcalidraw ? 'block' : 'none',
          }}
        />
        {!activeTabPath && (
          <div className="file-editor-empty">Select a file to view</div>
        )}
      </div>

      <ResizeHandle direction="horizontal" onResize={handleTreeResize} />
      <div className="file-tree-pane" style={{ width: treeWidth }}>
        <div className="file-tree-header">
          <span>Files</span>
          <div className="file-tree-actions">
            <button
              className="file-tree-action-btn"
              onClick={() => setCreating({ type: 'file', dir: workingDirectory })}
              title="New File"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="0.5">
                <path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v3.5H12" fill="none" />
                <path d="M7 8v4m-2-2h4" fill="none" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className="file-tree-action-btn"
              onClick={() => setCreating({ type: 'dir', dir: workingDirectory })}
              title="New Folder"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="0.5">
                <path d="M1.5 3A1.5 1.5 0 013 1.5h3.3l1.2 1.5H13a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" fill="none" />
                <path d="M7 7v4m-2-2h4" fill="none" strokeWidth="1.5" />
              </svg>
            </button>
            <button
              className="file-tree-action-btn"
              onClick={() => setCreating({ type: 'excalidraw', dir: workingDirectory })}
              title="New Excalidraw drawing"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                {SWORD_SHAPE}
                {/* "New" plus badge in the top-right — same convention as
                    the New File button's plus inside the page outline. */}
                <path d="M13 1.5v3M11.5 3h3" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </div>
        <div
          className="file-tree-list"
          onContextMenu={handleTreeContextMenu}
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
        >
          {creating && creating.dir === workingDirectory && (
            <div className="file-tree-item" style={{ paddingLeft: 12 }}>
              <FileIcon
                filename={
                  creating.type === 'dir' ? '__dir__'
                    : creating.type === 'excalidraw' ? 'untitled.excalidraw'
                      : 'untitled'
                }
                isDirectory={creating.type === 'dir'}
              />
              <InlineInput
                initialValue={
                  creating.type === 'dir' ? 'new-folder'
                    : creating.type === 'excalidraw' ? 'untitled.excalidraw'
                      : 'untitled.txt'
                }
                onSubmit={handleCreateSubmit}
                onCancel={() => setCreating(null)}
              />
            </div>
          )}
          {rootEntries
            .filter((entry) => showHiddenFiles || !entry.name.startsWith('.'))
            .map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              selectedPath={activeTabPath}
              onSelect={handleSelectFile}
              onContextMenu={handleContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={handleRenameSubmit}
              onRenameCancel={() => setRenamingPath(null)}
              refreshKey={refreshKey}
              revealRequest={revealRequest}
              dragHover={dragHover}
              onDragStartItem={handleDragStartItem}
              onDragOverItem={handleDragOverItem}
              onDropItem={handleDropItem}
              onDragEndItem={handleDragEndItem}
              gitDecorations={gitDecorations}
              showHiddenFiles={showHiddenFiles}
            />
          ))}
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          entry={ctxMenu.entry}
          clipboard={clipboard}
          onClose={() => setCtxMenu(null)}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onDelete={handleDelete}
          onRename={handleRename}
          onNewFile={handleNewFile}
          onNewDir={handleNewDir}
          onOpenNewTab={ctxMenu.entry && !ctxMenu.entry.isDirectory ? handleOpenNewTab : null}
          onShowHistory={ctxMenu.entry && !ctxMenu.entry.isDirectory ? handleShowHistory : null}
        />
      )}

      {/* T-045 format error toast */}
      {formatError && (
        <div className="file-format-toast">
          <span className="file-format-toast-label">Format failed</span>
          <code className="file-format-toast-msg">{formatError}</code>
          <button className="file-format-toast-close" onClick={() => setFormatError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* T-043 tab right-click menu */}
      {tabCtxMenu && (() => {
        const target = tabs.find((t) => t.path === tabCtxMenu.path);
        if (!target) return null;
        const base = workingDirectory.replace(/\/+$/, '');
        const rel = target.path.startsWith(base) ? target.path.slice(base.length + 1) : target.path;
        const idx = tabs.findIndex((t) => t.path === tabCtxMenu.path);
        const canCloseRight = idx >= 0 && idx < tabs.length - 1;
        const canCloseOthers = tabs.length > 1;
        const close = () => setTabCtxMenu(null);
        return (
          <div
            className="file-context-menu file-tab-ctx-menu"
            style={{ left: tabCtxMenu.x, top: tabCtxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="file-ctx-item" onClick={() => { closeTab(target.path); close(); }}>Close</button>
            <button className="file-ctx-item" disabled={!canCloseOthers} onClick={() => { closeOthers(target.path); close(); }}>Close Others</button>
            <button className="file-ctx-item" disabled={!canCloseRight} onClick={() => { closeToRight(target.path); close(); }}>Close to the Right</button>
            <button className="file-ctx-item" onClick={() => { closeAllTabs(); close(); }}>Close All</button>
            <div className="file-ctx-divider" />
            <button className="file-ctx-item" onClick={() => { window.api.openInFinder(target.path); close(); }}>Reveal in Finder</button>
            <div className="file-ctx-divider" />
            <button className="file-ctx-item" onClick={() => { navigator.clipboard.writeText(target.path).catch((): void => undefined); close(); }}>Copy Path</button>
            <button className="file-ctx-item" onClick={() => { navigator.clipboard.writeText(rel).catch((): void => undefined); close(); }}>Copy Relative Path</button>
          </div>
        );
      })()}

      {historyFile && (
        <FileHistoryView
          workingDirectory={workingDirectory}
          filePath={historyFile.path}
          fileName={historyFile.name}
          initialSha={historyFile.initialSha}
          onClose={() => setHistoryFile(null)}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete {deleteTarget.isDirectory ? 'Folder' : 'File'}</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Are you sure you want to delete <strong>{deleteTarget.name}</strong>?
                {deleteTarget.isDirectory && ' This will delete all files inside it.'}
                <br /><span style={{ opacity: 0.6 }}>This cannot be undone.</span>
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setDeleteTarget(null)}>Cancel</button>
                <button className="delete-btn" onClick={handleConfirmDelete}>Delete</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Close tab with unsaved changes */}
      {closingTabPath && (
        <div className="modal-overlay" onClick={() => setClosingTabPath(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Unsaved Changes</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                <strong>{fileName(closingTabPath)}</strong> has unsaved changes.
              </p>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={() => setClosingTabPath(null)}>Cancel</button>
              <div className="modal-footer-right">
                <button className="delete-btn" onClick={handleCloseTabDiscard}>Discard</button>
                <button className="save-btn" onClick={handleCloseTabSave}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
