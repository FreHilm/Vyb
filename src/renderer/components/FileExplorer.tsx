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

function FileTreeNode({
  entry,
  depth,
  selectedPath,
  onSelect,
}: {
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  const handleToggle = async () => {
    if (entry.isDirectory) {
      if (!expanded) {
        const entries = await window.api.listDir(entry.path);
        setChildren(entries);
      }
      setExpanded(!expanded);
    } else {
      onSelect(entry.path);
    }
  };

  const isSelected = entry.path === selectedPath;

  return (
    <>
      <div
        className={`file-tree-item ${isSelected ? 'file-tree-selected' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={handleToggle}
      >
        {entry.isDirectory && (
          <span className="file-tree-arrow">{expanded ? '▾' : '▸'}</span>
        )}
        <FileIcon filename={entry.name} isDirectory={entry.isDirectory} isExpanded={expanded} />
        <span className="file-tree-name">{entry.name}</span>
      </div>
      {expanded &&
        children.map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

export function FileExplorer({ workingDirectory, closeRequested, onCloseHandled }: FileExplorerProps) {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedIsImage, setSelectedIsImage] = useState(false);
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const currentFileRef = useRef<string | null>(null);
  const modifiedRef = useRef(false);

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

      // Destroy existing editor
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
        // Show unsaved changes dialog
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
      <div className="file-tree-pane">
        <div className="file-tree-header">Files</div>
        <div className="file-tree-list">
          {rootEntries.map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              selectedPath={selectedFile}
              onSelect={handleSelectFile}
            />
          ))}
        </div>
      </div>

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
