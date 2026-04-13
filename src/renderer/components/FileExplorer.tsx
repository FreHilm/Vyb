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

// ── Context Menu ─────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  entry: FileEntry | null; // null = right-clicked empty area
  clipboard: string | null;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onRename: () => void;
  onNewFile: () => void;
  onNewDir: () => void;
}

function ContextMenu({ x, y, entry, clipboard, onClose, onCopy, onPaste, onDelete, onRename, onNewFile, onNewDir }: ContextMenuProps) {
  useEffect(() => {
    const handleClick = () => onClose();
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [onClose]);

  return (
    <div className="file-context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
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
    // Select name without extension
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

  // Reload children when refreshKey changes (after file ops)
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
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedIsImage, setSelectedIsImage] = useState(false);
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const currentFileRef = useRef<string | null>(null);
  const modifiedRef = useRef(false);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [clipboard, setClipboard] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Delete confirmation dialog
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  // New file/dir input
  const [creating, setCreating] = useState<{ type: 'file' | 'dir'; dir: string } | null>(null);
  const [treeWidth, setTreeWidth] = useState(240);
  const explorerRef = useRef<HTMLDivElement>(null);

  const handleTreeResize = useCallback((delta: number) => {
    setTreeWidth((w) => Math.max(140, Math.min(500, w - delta)));
  }, []);

  const refresh = useCallback(() => {
    window.api.listDir(workingDirectory).then(setRootEntries);
    setRefreshKey((k) => k + 1);
  }, [workingDirectory]);

  // Keep modifiedRef in sync
  useEffect(() => {
    modifiedRef.current = modified;
  }, [modified]);

  // Handle close request from parent
  useEffect(() => {
    if (!closeRequested) return;
    if (modifiedRef.current) {
      setPendingClose(true);
    } else {
      onCloseHandled(true);
    }
  }, [closeRequested, onCloseHandled]);

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

  const handleSave = useCallback(async () => {
    if (!currentFileRef.current || !viewRef.current) return;
    setSaving(true);
    const content = viewRef.current.state.doc.toString();
    await window.api.saveFile(currentFileRef.current, content);
    setModified(false);
    modifiedRef.current = false;
    setSaving(false);
  }, []);

  const openFile = useCallback(
    async (filePath: string) => {
      const fileName = filePath.split('/').pop() || '';

      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }

      setSelectedFile(filePath);
      currentFileRef.current = filePath;
      setModified(false);
      modifiedRef.current = false;

      if (isImageFile(fileName)) {
        setSelectedIsImage(true);
        return;
      }

      setSelectedIsImage(false);

      const content = await window.api.readFile(filePath);
      if (content === null) return;

      if (!editorRef.current) return;

      const lang = getLanguageExtension(fileName);

      const state = EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          oneDark,
          ...(Array.isArray(lang) ? lang : [lang]),
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                handleSave();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              setModified(true);
              modifiedRef.current = true;
            }
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-content': { fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace" },
          }),
        ],
      });

      viewRef.current = new EditorView({
        state,
        parent: editorRef.current,
      });
    },
    [handleSave],
  );

  const handleSelectFile = useCallback(
    (filePath: string) => {
      if (filePath === currentFileRef.current) return;

      if (modifiedRef.current) {
        setPendingFile(filePath);
      } else {
        openFile(filePath);
      }
    },
    [openFile],
  );

  const handleDialogSave = useCallback(async () => {
    await handleSave();
    if (pendingClose) {
      setPendingClose(false);
      onCloseHandled(true);
    } else if (pendingFile) {
      openFile(pendingFile);
      setPendingFile(null);
    }
  }, [handleSave, openFile, pendingFile, pendingClose, onCloseHandled]);

  const handleDialogDiscard = useCallback(() => {
    setModified(false);
    modifiedRef.current = false;
    if (pendingClose) {
      setPendingClose(false);
      onCloseHandled(true);
    } else if (pendingFile) {
      openFile(pendingFile);
      setPendingFile(null);
    }
  }, [openFile, pendingFile, pendingClose, onCloseHandled]);

  const handleDialogCancel = useCallback(() => {
    setPendingFile(null);
    if (pendingClose) {
      setPendingClose(false);
      onCloseHandled(false);
    }
  }, [pendingClose, onCloseHandled]);

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
    // Avoid overwriting — append " copy" if exists
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
    if (selectedFile === deleteTarget.path) {
      setSelectedFile(null);
      currentFileRef.current = null;
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    }
    setDeleteTarget(null);
    refresh();
  }, [deleteTarget, selectedFile, refresh]);

  const handleRename = useCallback(() => {
    if (ctxMenu?.entry) setRenamingPath(ctxMenu.entry.path);
    setCtxMenu(null);
  }, [ctxMenu]);

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    const dir = parentDir(oldPath);
    const newPath = `${dir}/${newName}`;
    await window.api.renameFile(oldPath, newPath);
    if (selectedFile === oldPath) {
      setSelectedFile(newPath);
      currentFileRef.current = newPath;
    }
    setRenamingPath(null);
    refresh();
  }, [selectedFile, refresh]);

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

  const fileName = selectedFile?.split('/').pop() || '';

  return (
    <div className="file-explorer">
      <div className="file-editor-pane">
        {selectedFile && (
          <div className="file-editor-header">
            <span className="file-editor-name">
              {fileName}
              {modified && <span className="file-modified-dot" />}
            </span>
            {!selectedIsImage && modified && (
              <button
                className="action-btn file-save-btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
        )}
        {selectedFile && selectedIsImage && (
          <div className="file-image-viewer">
            <img src={`local-file://${selectedFile}`} alt={fileName} />
          </div>
        )}
        <div
          className="file-editor-content"
          ref={editorRef}
          style={{ display: selectedFile && !selectedIsImage ? 'block' : 'none' }}
        />
        {!selectedFile && (
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
              selectedPath={selectedFile}
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
                <button className="cancel-btn" onClick={() => setDeleteTarget(null)}>
                  Cancel
                </button>
                <button className="delete-btn" onClick={handleConfirmDelete}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved changes dialog */}
      {(pendingFile || pendingClose) && (
        <div className="modal-overlay" onClick={handleDialogCancel}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Unsaved Changes</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                <strong>{fileName}</strong> has unsaved changes. What would you like to do?
              </p>
            </div>
            <div className="modal-footer">
              <button className="cancel-btn" onClick={handleDialogCancel}>
                Stay on file
              </button>
              <div className="modal-footer-right">
                <button className="delete-btn" onClick={handleDialogDiscard}>
                  Discard
                </button>
                <button className="save-btn" onClick={handleDialogSave}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
