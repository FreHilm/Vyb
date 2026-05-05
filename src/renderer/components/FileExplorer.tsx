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

interface FileExplorerProps {
  workingDirectory: string;
  closeRequested: boolean;
  onCloseHandled: (proceed: boolean) => void;
  /** External request to open a file in a tab — typically from a click on
   * a file link in the agent terminal. The `nonce` discriminates re-opens
   * of the same path so the effect re-runs. */
  pendingOpenPath?: { path: string; nonce: number } | null;
  onPendingOpenHandled?: () => void;
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
}

function ContextMenu({ x, y, entry, clipboard, onClose, onCopy, onPaste, onDelete, onRename, onNewFile, onNewDir, onOpenNewTab }: ContextMenuProps) {
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

  return (
    <>
      <div
        ref={rowRef}
        className={`file-tree-item${isSelected ? ' file-tree-selected' : ''}${isDropTarget ? ' file-tree-drop-target' : ''}`}
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
      </div>
      {expanded &&
        children.map((child) => (
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
          />
        ))}
    </>
  );
}

// ── Main FileExplorer ────────────────────────────────────────────

export function FileExplorer({
  workingDirectory,
  closeRequested,
  onCloseHandled,
  pendingOpenPath,
  onPendingOpenHandled,
}: FileExplorerProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [modifiedSet, setModifiedSet] = useState<Set<string>>(new Set());
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
  // Close-all dialog (parent requesting close)
  const [pendingClose, setPendingClose] = useState(false);

  const handleTreeResize = useCallback((delta: number) => {
    setTreeWidth((w) => Math.max(140, Math.min(500, w - delta)));
  }, []);

  const refresh = useCallback(() => {
    window.api.listDir(workingDirectory).then(setRootEntries);
    setRefreshKey((k) => k + 1);
  }, [workingDirectory]);

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

  // ── Handle parent close request ──────────────────────────────
  useEffect(() => {
    if (!closeRequested) return;
    if (modifiedSet.size > 0) {
      setPendingClose(true);
    } else {
      onCloseHandled(true);
    }
  }, [closeRequested, onCloseHandled, modifiedSet.size]);

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

  const handleSave = useCallback(async () => {
    const path = activePathRef.current;
    if (!path) return;
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

  const mountEditor = useCallback(async (filePath: string) => {
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
        ...(Array.isArray(lang) ? lang : [lang]),
        keymap.of([
          { key: 'Mod-s', run: () => { handleSave(); return true; } },
          { key: 'Mod-Shift-s', run: () => { handleSaveAs(); return true; } },
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
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace" },

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
  }, [handleSave, handleSaveAs]);

  // ── Tab management ───────────────────────────────────────────

  const openInTab = useCallback((filePath: string, forceNew: boolean) => {
    if (isImageFile(fileName(filePath))) {
      // Images: always open directly, no tab reuse logic for modified check
    }

    const existingIdx = tabs.findIndex((t) => t.path === filePath);
    if (existingIdx >= 0) {
      // Tab already open — switch to it
      saveCurrentDoc();
      mountEditor(filePath);
      return;
    }

    const newTab: FileTab = { path: filePath, name: fileName(filePath) };

    if (forceNew || (activePathRef.current && modifiedSet.has(activePathRef.current))) {
      // Open in new tab (keep current modified tab)
      saveCurrentDoc();
      setTabs((t) => [...t, newTab]);
      mountEditor(filePath);
    } else if (tabs.length === 0) {
      // No tabs yet
      setTabs([newTab]);
      mountEditor(filePath);
    } else {
      // Reuse active tab (no modifications)
      saveCurrentDoc();
      const activePath = activePathRef.current;
      docCacheRef.current.delete(activePath || '');
      savedContentRef.current.delete(activePath || '');
      setTabs((t) => t.map((tab) => tab.path === activePath ? newTab : tab));
      mountEditor(filePath);
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
    if (!pendingOpenPath) return;
    openInTab(pendingOpenPath.path, true);
    setRevealRequest({ path: pendingOpenPath.path, nonce: pendingOpenPath.nonce });
    onPendingOpenHandled?.();
  }, [pendingOpenPath, openInTab, onPendingOpenHandled]);

  const closeTab = useCallback((filePath: string) => {
    if (modifiedSet.has(filePath)) {
      setClosingTabPath(filePath);
      return;
    }
    doCloseTab(filePath);
  }, [modifiedSet]);

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

  // Parent close-all handlers
  const handleCloseAllDiscard = useCallback(() => {
    setPendingClose(false);
    setModifiedSet(new Set());
    onCloseHandled(true);
  }, [onCloseHandled]);

  const handleCloseAllCancel = useCallback(() => {
    setPendingClose(false);
    onCloseHandled(false);
  }, [onCloseHandled]);

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

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    const targetDir = ctxMenu?.entry?.isDirectory
      ? ctxMenu.entry.path
      : ctxMenu?.entry
        ? parentDir(ctxMenu.entry.path)
        : workingDirectory;
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
    setCtxMenu(null);
    refresh();
  }, [clipboard, ctxMenu, workingDirectory, refresh]);

  const handleDelete = useCallback(() => {
    if (ctxMenu?.entry) setDeleteTarget(ctxMenu.entry);
    setCtxMenu(null);
  }, [ctxMenu]);

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
  useEffect(() => {
    window.api.setEditMenuState({
      hasFile: !!activeTabPath && !activeIsImage,
      canSave: !!activeTabPath && !activeIsImage && activeIsModified,
    });
  }, [activeTabPath, activeIsImage, activeIsModified]);

  // Handle clicks coming back from the Edit menu in the application menu.
  // CodeMirror's basicSetup already binds Cmd+Z / Cmd+F / etc. to the editor,
  // so this only runs when the user clicks the menu item itself.
  useEffect(() => {
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
  }, [handleSave, handleSaveAs]);

  return (
    <div className="file-explorer">
      <div className="file-editor-pane">
        {/* Tab bar */}
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
          {activeTabPath && !activeIsImage && (
            <div className="file-tab-actions">
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
              {activeIsMd && (
                <button
                  className={`file-tab-action-btn ${activeMdMode === 'edit' ? 'is-active' : ''}`}
                  onClick={toggleMdMode}
                  title={activeMdMode === 'view' ? 'Edit markdown source' : 'View rendered markdown'}
                >
                  {activeMdMode === 'view' ? (
                    /* Pencil icon = edit (the action when clicked). */
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z" />
                    </svg>
                  ) : (
                    /* Eye icon = view. */
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.5 8s2-5 6.5-5 6.5 5 6.5 5-2 5-6.5 5S1.5 8 1.5 8z" />
                      <circle cx="8" cy="8" r="2" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          )}
        </div>

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
          {rootEntries.map((entry) => (
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

      {/* Close all with unsaved changes */}
      {pendingClose && (
        <div className="modal-overlay" onClick={handleCloseAllCancel}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Unsaved Changes</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                You have {modifiedSet.size} unsaved file{modifiedSet.size > 1 ? 's' : ''}. Close anyway?
              </p>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={handleCloseAllCancel}>Cancel</button>
              <div className="modal-footer-right">
                <button className="delete-btn" onClick={handleCloseAllDiscard}>Discard All</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
