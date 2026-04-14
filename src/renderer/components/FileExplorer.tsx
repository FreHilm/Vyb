import { useEffect, useState, useRef, useCallback } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';
import { FileEntry } from '../../shared/types';
import { FileIcon } from '../file-icons';
import { ResizeHandle } from './ResizeHandle';

interface FileExplorerProps {
  workingDirectory: string;
  closeRequested: boolean;
  onCloseHandled: (proceed: boolean) => void;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

function getLanguageExtension(filename: string) {
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
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  const loadChildren = useCallback(async () => {
    const entries = await window.api.listDir(entry.path);
    setChildren(entries);
  }, [entry.path]);

  useEffect(() => {
    if (expanded && entry.isDirectory) {
      loadChildren();
    }
  }, [refreshKey, expanded, entry.isDirectory, loadChildren]);

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

  return (
    <>
      <div
        className={`file-tree-item ${isSelected ? 'file-tree-selected' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={handleToggle}
        onContextMenu={handleCtxMenu}
      >
        {entry.isDirectory && (
          <span className="file-tree-arrow">{expanded ? '▾' : '▸'}</span>
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
          />
        ))}
    </>
  );
}

// ── Main FileExplorer ────────────────────────────────────────────

export function FileExplorer({ workingDirectory, closeRequested, onCloseHandled }: FileExplorerProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [modifiedSet, setModifiedSet] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const activePathRef = useRef<string | null>(null);
  // Store editor doc content per tab so we can restore on switch
  const docCacheRef = useRef<Map<string, string>>(new Map());

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [clipboard, setClipboard] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [creating, setCreating] = useState<{ type: 'file' | 'dir'; dir: string } | null>(null);
  const [treeWidth, setTreeWidth] = useState(240);

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
    };
  }, []);

  // ── Editor helpers ───────────────────────────────────────────

  const saveCurrentDoc = useCallback(() => {
    if (activePathRef.current && viewRef.current) {
      docCacheRef.current.set(activePathRef.current, viewRef.current.state.doc.toString());
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!activePathRef.current || !viewRef.current) return;
    setSaving(true);
    const content = viewRef.current.state.doc.toString();
    await window.api.saveFile(activePathRef.current, content);
    docCacheRef.current.set(activePathRef.current, content);
    setModifiedSet((s) => { const n = new Set(s); n.delete(activePathRef.current!); return n; });
    setSaving(false);
  }, []);

  const handleSaveAs = useCallback(async () => {
    if (!activePathRef.current || !viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    const newPath = await window.api.saveFileAs(content, activePathRef.current);
    if (newPath) {
      // Update the tab to point to the new path
      const oldPath = activePathRef.current;
      docCacheRef.current.delete(oldPath);
      docCacheRef.current.set(newPath, content);
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
    if (!editorRef.current) return;

    // Use cached content or load from disk
    let content = docCacheRef.current.get(filePath);
    if (content === undefined) {
      content = await window.api.readFile(filePath) || '';
      docCacheRef.current.set(filePath, content);
    }

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
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setModifiedSet((s) => new Set(s).add(thisPath));
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace" },
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
      setTabs((t) => t.map((tab) => tab.path === activePath ? newTab : tab));
      mountEditor(filePath);
    }
  }, [tabs, modifiedSet, saveCurrentDoc, mountEditor]);

  const switchTab = useCallback((filePath: string) => {
    if (filePath === activePathRef.current) return;
    saveCurrentDoc();
    mountEditor(filePath);
  }, [saveCurrentDoc, mountEditor]);

  const closeTab = useCallback((filePath: string) => {
    if (modifiedSet.has(filePath)) {
      setClosingTabPath(filePath);
      return;
    }
    doCloseTab(filePath);
  }, [modifiedSet]);

  const doCloseTab = useCallback((filePath: string) => {
    docCacheRef.current.delete(filePath);
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
    } else {
      await window.api.createFile(fullPath);
    }
    setCreating(null);
    refresh();
  }, [creating, refresh]);

  const activeIsImage = activeTabPath ? isImageFile(fileName(activeTabPath)) : false;
  const activeIsModified = activeTabPath ? modifiedSet.has(activeTabPath) : false;

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
            </div>
          )}
        </div>

        {/* Editor area */}
        {activeTabPath && activeIsImage && (
          <div className="file-image-viewer">
            <img src={`local-file://${activeTabPath}`} alt={fileName(activeTabPath)} />
          </div>
        )}
        <div
          className="file-editor-content"
          ref={editorRef}
          style={{ display: activeTabPath && !activeIsImage ? 'block' : 'none' }}
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
          </div>
        </div>
        <div className="file-tree-list" onContextMenu={handleTreeContextMenu}>
          {creating && creating.dir === workingDirectory && (
            <div className="file-tree-item" style={{ paddingLeft: 12 }}>
              <FileIcon filename={creating.type === 'dir' ? '__dir__' : 'untitled'} isDirectory={creating.type === 'dir'} />
              <InlineInput
                initialValue={creating.type === 'dir' ? 'new-folder' : 'untitled.txt'}
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
