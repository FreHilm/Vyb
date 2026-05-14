import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';
import { FileEntry } from '../../shared/types';
import { FileIcon } from '../file-icons';
import { ResizeHandle } from './ResizeHandle';
import { MermaidBlock } from './MermaidBlock';

interface ReadmeViewerProps {
  workingDirectory: string;
}

const MD_EXT = /\.mdx?$/i;
const DRAG_MIME = 'application/x-vyb-path';

// Path helpers using `/` (we run on macOS/Linux; Windows would need
// platform-aware versions, see `path.posix` etc).
function basename(p: string): string {
  return p.split('/').pop() || p;
}
function parentDir(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '';
}
/** Reject same-location moves and folder-into-its-own-descendant cycles. */
function isValidMove(src: string, targetDir: string): boolean {
  if (!src || !targetDir) return false;
  if (parentDir(src) === targetDir) return false;
  if (targetDir === src) return false;
  if (targetDir.startsWith(src + '/')) return false;
  return true;
}

// Tree node restricted to folders + .md/.mdx files. Mirrors FileExplorer's
// FileTreeNode but with no editing affordances and a built-in filter.
interface MdTreeNodeProps {
  entry: FileEntry;
  depth: number;
  currentFile: string;
  refreshKey: number;
  creatingIn: string | null;
  dragHover: string | null;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onCreateSubmit: (dir: string, name: string) => void;
  onCreateCancel: () => void;
  onDragStartItem: (e: React.DragEvent, entry: FileEntry) => void;
  onDragOverItem: (e: React.DragEvent, entry: FileEntry) => void;
  onDragLeaveItem: (e: React.DragEvent) => void;
  onDropItem: (e: React.DragEvent, entry: FileEntry) => void;
  onDragEndItem: () => void;
}

function MdTreeNode({
  entry, depth, currentFile, refreshKey, creatingIn, dragHover,
  onSelect, onContextMenu, onCreateSubmit, onCreateCancel,
  onDragStartItem, onDragOverItem, onDragLeaveItem, onDropItem, onDragEndItem,
}: MdTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  const loadChildren = useCallback(async () => {
    const entries = await window.api.listDir(entry.path);
    // Filter: keep folders (we'll recurse into them) and *.md/*.mdx files.
    // Folders that contain no markdown anywhere will still expand to empty
    // — acceptable for v1; we can prune empties later if it gets noisy.
    setChildren(entries.filter((e) => e.isDirectory || MD_EXT.test(e.name)));
  }, [entry.path]);

  useEffect(() => {
    if (expanded && entry.isDirectory) loadChildren();
  }, [expanded, entry.isDirectory, loadChildren, refreshKey]);

  // If a new file is being created inside this directory, keep this node
  // expanded so the inline input is visible.
  useEffect(() => {
    if (entry.isDirectory && creatingIn === entry.path && !expanded) {
      setExpanded(true);
    }
  }, [creatingIn, entry.isDirectory, entry.path, expanded]);

  const handleClick = () => {
    if (entry.isDirectory) {
      setExpanded((v) => !v);
    } else {
      onSelect(entry.path);
    }
  };

  const isSelected = entry.path === currentFile;
  const isCreatingHere = entry.isDirectory && creatingIn === entry.path;
  // Highlight when this node (folders) or this node's parent dir (files)
  // matches the active drop target.
  const dropTargetDir = entry.isDirectory ? entry.path : parentDir(entry.path);
  const isDropTarget = dragHover === dropTargetDir;

  return (
    <>
      <div
        className={`file-tree-item${isSelected ? ' file-tree-selected' : ''}${isDropTarget ? ' file-tree-drop-target' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, entry)}
        title={entry.path}
        draggable
        onDragStart={(e) => onDragStartItem(e, entry)}
        onDragOver={(e) => onDragOverItem(e, entry)}
        onDragLeave={onDragLeaveItem}
        onDrop={(e) => onDropItem(e, entry)}
        onDragEnd={onDragEndItem}
      >
        {entry.isDirectory && (
          <span
            className="file-tree-arrow"
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 3 11 8 6 13" />
            </svg>
          </span>
        )}
        <FileIcon filename={entry.name} isDirectory={entry.isDirectory} isExpanded={expanded} />
        <span className="file-tree-name">{entry.name}</span>
      </div>
      {expanded && isCreatingHere && (
        <NewFileInput
          dir={entry.path}
          depth={depth + 1}
          onSubmit={onCreateSubmit}
          onCancel={onCreateCancel}
        />
      )}
      {expanded && children.map((child) => (
        <MdTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          currentFile={currentFile}
          refreshKey={refreshKey}
          creatingIn={creatingIn}
          dragHover={dragHover}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onCreateSubmit={onCreateSubmit}
          onCreateCancel={onCreateCancel}
          onDragStartItem={onDragStartItem}
          onDragOverItem={onDragOverItem}
          onDragLeaveItem={onDragLeaveItem}
          onDropItem={onDropItem}
          onDragEndItem={onDragEndItem}
        />
      ))}
    </>
  );
}

// Tiny inline input for naming a new .md file.
function NewFileInput({
  dir, depth, onSubmit, onCancel,
}: { dir: string; depth: number; onSubmit: (dir: string, name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('untitled.md');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the basename so the user just types and overwrites.
    const dot = value.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
    // Run only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="file-tree-item" style={{ paddingLeft: 12 + depth * 16 }}>
      <FileIcon filename="untitled.md" isDirectory={false} />
      <input
        ref={ref}
        className="readme-tree-input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => onSubmit(dir, value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSubmit(dir, value); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
    </div>
  );
}

export function ReadmeViewer({ workingDirectory }: ReadmeViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [backVisible, setBackVisible] = useState(false);
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [treeWidth, setTreeWidth] = useState(220);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [modified, setModified] = useState(false);
  // Refresh-token bumped after file ops (create/etc.) — `MdTreeNode`
  // can't see this directly because it manages its own children, but
  // we use it to reload root entries.
  const [treeRefresh, setTreeRefresh] = useState(0);
  // Inline new-file input. `dir` is the parent directory; null = closed.
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  // Right-click context menu for tree nodes.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  // Pending delete confirmation (null = no dialog).
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  // DnD: source path lives in a ref (no re-render needed during drag);
  // target dir lives in state (drives the highlight).
  const dragSourceRef = useRef<string | null>(null);
  const [dragHover, setDragHover] = useState<string | null>(null);

  const viewerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  // Pinch-to-zoom state for the rendered markdown. Uses the CSS `zoom`
  // property so the content reflows at the new size (transform:scale
  // would just rescale pixels and keep wrapping at 1×).
  const [zoom, setZoom] = useState(1);

  // Memoise the react-markdown `components` prop so its identity is
  // stable across renders. Otherwise zoom changes (which re-render this
  // component) would cause react-markdown to unmount + remount the
  // custom `MermaidBlock`, losing its rendered SVG state and
  // re-running mermaid.render — visible as the diagram briefly
  // shrinking then "reloading" back to its original size.
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

  // Trackpad pinch arrives in Chromium as a `wheel` event with
  // `ctrlKey: true`. We intercept it on the viewer (passive:false so
  // preventDefault works) and turn deltaY into a zoom multiplier.
  // The deps include `mode/loading/content` because the viewer div is
  // conditionally rendered — the ref is null until the view-mode JSX
  // mounts, so we need to re-run the effect when it does.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // 0.01 step per wheel-tick reads naturally on a mac trackpad.
      setZoom((z) => Math.max(0.5, Math.min(3, z * (1 - e.deltaY * 0.01))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode, loading, content]);
  // Avoid stale closures for the latest editor content / mounted file.
  const currentFileRef = useRef('');
  const modifiedRef = useRef(false);
  useEffect(() => { currentFileRef.current = currentFile; }, [currentFile]);
  useEffect(() => { modifiedRef.current = modified; }, [modified]);

  // Load the working directory's top level once per cwd (or after a
  // create), filtered to folders + .md/.mdx files. Subfolders are loaded
  // lazily by MdTreeNode.
  useEffect(() => {
    window.api.listDir(workingDirectory).then((entries) => {
      setRootEntries(entries.filter((e) => e.isDirectory || MD_EXT.test(e.name)));
    });
  }, [workingDirectory, treeRefresh]);

  const handleTreeResize = useCallback((delta: number) => {
    // Tree sits on the right, so dragging left grows it (delta is positive
    // when the cursor moves left in ResizeHandle's convention).
    setTreeWidth((w) => Math.max(140, Math.min(500, w - delta)));
  }, []);

  // Save the editor's current contents back to disk. No-op when there's
  // no editor (view mode) or no current file.
  const saveEditor = useCallback(async (): Promise<boolean> => {
    const view = editorViewRef.current;
    const path = currentFileRef.current;
    if (!view || !path) return true;
    const text = view.state.doc.toString();
    const ok = await window.api.saveFile(path, text);
    if (ok) {
      setModified(false);
      // Reflect saved contents in the cached `content` so view-mode
      // renders the latest text without a re-read.
      setContent(text);
    }
    return ok;
  }, []);

  // Cache `content` in a ref so the editor-mount effect (which doesn't
  // depend on content — see below) reads the latest value when mounting.
  const contentRef = useRef<string | null>(null);
  useEffect(() => { contentRef.current = content; }, [content]);

  // Mount / unmount the CodeMirror editor based on mode + currentFile.
  // Deliberately NOT depending on `content`: saving (which calls
  // setContent to refresh the view-mode cache) shouldn't re-mount the
  // editor and lose cursor position. A real file change goes through
  // `currentFile` instead, which does re-mount.
  useEffect(() => {
    if (mode !== 'edit' || !currentFile) return;
    if (!editorHostRef.current) return;

    const initial = contentRef.current ?? '';
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        oneDark,
        markdown(),
        keymap.of([
          { key: 'Mod-s', run: () => { saveEditor(); return true; } },
          // Clipboard. CodeMirror 6 normally relies on the browser's
          // native copy/cut/paste events, but Electron on macOS doesn't
          // fire those for Cmd+C/V/X without an Edit-menu role accelerator
          // (which we deliberately don't register so xterm.js can keep
          // Cmd+C). Cmd+A and Cmd+Z come from basicSetup's defaultKeymap
          // / historyKeymap, so they don't need explicit bindings here.
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
          if (update.docChanged) setModified(true);
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: 'var(--cm-editor-font-size, 14px)',
            backgroundColor: 'var(--c-base)',
            color: 'var(--c-text)',
          },
          '.cm-scroller': { overflow: 'auto', backgroundColor: 'var(--c-base)' },
          '.cm-content': { fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace", caretColor: 'var(--c-rosewater)' },
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
        }),
      ],
    });
    editorViewRef.current = new EditorView({ state, parent: editorHostRef.current });
    setModified(false);

    return () => {
      const view = editorViewRef.current;
      if (!view) return;
      // Auto-save dirty work on the way out (mode flip or file switch).
      // Cleanup is sync, so the disk write is fire-and-forget — but
      // setContent fires after it resolves to keep view mode fresh.
      if (modifiedRef.current && currentFileRef.current) {
        const text = view.state.doc.toString();
        const path = currentFileRef.current;
        window.api.saveFile(path, text).then((ok) => {
          if (ok) setContent(text);
        });
      }
      view.destroy();
      editorViewRef.current = null;
    };
  }, [mode, currentFile, saveEditor]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === 'view' ? 'edit' : 'view'));
  }, []);

  // Create a new .md file in `dir`. Triggered after the inline-input
  // submit. We always ensure the .md extension. After creation, refresh
  // the tree and open the file in edit mode so the user can start typing.
  const handleCreateSubmit = useCallback(async (dir: string, rawName: string) => {
    setCreatingIn(null);
    const trimmed = rawName.trim();
    if (!trimmed) return;
    const name = MD_EXT.test(trimmed) ? trimmed : trimmed + '.md';
    const filePath = `${dir.replace(/\/$/, '')}/${name}`;
    await window.api.createFile(filePath);
    setTreeRefresh((n) => n + 1);
    setMode('edit');
    setLoading(true);
    const md = await window.api.readFile(filePath);
    setCurrentFile(filePath);
    setContent(md ?? '');
    setLoading(false);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const path = deleteTarget.path;
    setDeleteTarget(null);
    await window.api.deleteFile(path);
    // If the deleted file was the one we were viewing, drop the content
    // so we don't leave a stale render behind.
    if (currentFileRef.current === path) {
      setCurrentFile('');
      setContent(null);
      setHistory([]);
    }
    setTreeRefresh((n) => n + 1);
  }, [deleteTarget]);

  // ── Drag-and-drop move ────────────────────────────────────
  const handleDragStartItem = useCallback((e: React.DragEvent, entry: FileEntry) => {
    dragSourceRef.current = entry.path;
    e.dataTransfer.setData(DRAG_MIME, entry.path);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOverItem = useCallback((e: React.DragEvent, entry: FileEntry) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    const src = dragSourceRef.current;
    if (!src) return;
    const targetDir = entry.isDirectory ? entry.path : parentDir(entry.path);
    if (!isValidMove(src, targetDir)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragHover(targetDir);
  }, []);

  const handleDragLeaveItem = useCallback(() => {
    // Don't clear immediately — moving across siblings flickers. The
    // next dragover will set the new target. We clear definitively on
    // dragend / drop.
  }, []);

  const handleDragEndItem = useCallback(() => {
    dragSourceRef.current = null;
    setDragHover(null);
  }, []);

  const handleDropItem = useCallback(async (e: React.DragEvent, entry: FileEntry) => {
    const src = e.dataTransfer.getData(DRAG_MIME) || dragSourceRef.current;
    dragSourceRef.current = null;
    setDragHover(null);
    if (!src) return;
    const targetDir = entry.isDirectory ? entry.path : parentDir(entry.path);
    if (!isValidMove(src, targetDir)) return;
    e.preventDefault();
    e.stopPropagation();
    const newPath = `${targetDir.replace(/\/$/, '')}/${basename(src)}`;
    if (newPath === src) return;
    const ok = await window.api.renameFile(src, newPath);
    if (ok && currentFileRef.current === src) {
      setCurrentFile(newPath);
    }
    setTreeRefresh((n) => n + 1);
  }, []);

  // Drop on the tree's root container (drag a file out of a folder back
  // up to the working-dir root). Only fires when drop didn't bubble from
  // a child item (children call stopPropagation).
  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    const src = dragSourceRef.current;
    if (!src || !isValidMove(src, workingDirectory)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragHover(workingDirectory);
  }, [workingDirectory]);

  const handleRootDrop = useCallback(async (e: React.DragEvent) => {
    const src = e.dataTransfer.getData(DRAG_MIME) || dragSourceRef.current;
    dragSourceRef.current = null;
    setDragHover(null);
    if (!src || !isValidMove(src, workingDirectory)) return;
    e.preventDefault();
    e.stopPropagation();
    const newPath = `${workingDirectory.replace(/\/$/, '')}/${basename(src)}`;
    if (newPath === src) return;
    const ok = await window.api.renameFile(src, newPath);
    if (ok && currentFileRef.current === src) {
      setCurrentFile(newPath);
    }
    setTreeRefresh((n) => n + 1);
  }, [workingDirectory]);
  // Close the context menu on any outside click.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
    };
  }, [ctxMenu]);

  const loadFile = useCallback(async (filePath: string, pushHistory: boolean) => {
    setLoading(true);
    const md = await window.api.readFile(filePath);
    if (md !== null) {
      if (pushHistory && currentFile) {
        setHistory((h) => [...h, currentFile]);
      }
      setCurrentFile(filePath);
      setContent(md);
    }
    setLoading(false);
  }, [currentFile]);

  // Load README on mount
  useEffect(() => {
    window.api.loadReadme(workingDirectory).then((md) => {
      if (md !== null) {
        // Find the actual README path
        const names = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
        for (const name of names) {
          const path = `${workingDirectory}/${name}`;
          setCurrentFile(path);
          break;
        }
        setContent(md);
      }
      setLoading(false);
    });
  }, [workingDirectory]);

  // Focus for keyboard events
  useEffect(() => {
    if (!loading && content && viewerRef.current) {
      viewerRef.current.focus();
    }
  }, [loading, content]);

  // Back navigation
  const goBack = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setCurrentFile(prev);
    setLoading(true);
    window.api.readFile(prev).then((md) => {
      setContent(md);
      setLoading(false);
    });
  }, [history]);

  // Show back button on mouse move, auto-hide after 7s
  const showBack = useCallback(() => {
    if (history.length === 0) return;
    setBackVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setBackVisible(false), 7000);
  }, [history]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // Keyboard: Backspace to go back
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && history.length > 0) {
      e.preventDefault();
      goBack();
    }
    // ⌘= / ⌘+ → zoom in, ⌘- → zoom out, ⌘0 → reset.
    if (e.metaKey || e.ctrlKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setZoom((z) => Math.min(3, z * 1.1));
      } else if (e.key === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(0.5, z / 1.1));
      } else if (e.key === '0') {
        e.preventDefault();
        setZoom(1);
      }
    }
  }, [goBack, history]);

  // Intercept link clicks
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;

    e.preventDefault();
    const href = target.getAttribute('href');
    if (!href) return;

    // External URL — open in browser
    if (href.startsWith('http://') || href.startsWith('https://')) {
      window.api.openUrl(href);
      return;
    }

    // Relative .md link — navigate within viewer
    if (href.endsWith('.md') || href.endsWith('.mdx')) {
      const dir = currentFile.replace(/\/[^/]+$/, '');
      const resolved = `${dir}/${href}`.replace(/\/\.\//g, '/');
      loadFile(resolved, true);
      return;
    }

    // Anchor link (#section) — scroll to it
    if (href.startsWith('#')) {
      const id = href.slice(1).toLowerCase();
      const el = viewerRef.current?.querySelector(`[id="${id}"], [id="${id.replace(/ /g, '-')}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    // Other relative files — try to open as markdown, fall back to external
    if (!href.includes('://')) {
      const dir = currentFile.replace(/\/[^/]+$/, '');
      const resolved = `${dir}/${href}`.replace(/\/\.\//g, '/');
      // Check if it's a readable file
      window.api.readFile(resolved).then((content) => {
        if (content !== null && (resolved.endsWith('.md') || resolved.endsWith('.txt'))) {
          loadFile(resolved, true);
        }
      });
    }
  }, [currentFile, loadFile]);

  const tree = (
    <>
      <ResizeHandle direction="horizontal" onResize={handleTreeResize} />
      <div className="readme-tree-pane file-tree-pane" style={{ width: treeWidth }}>
        <div className="file-tree-header">
          <span>Docs</span>
          <div className="file-tree-actions">
            <button
              className={`file-tree-action-btn ${mode === 'edit' ? 'is-active' : ''}`}
              onClick={toggleMode}
              title={mode === 'edit' ? 'Switch to view mode' : 'Switch to edit mode'}
            >
              {mode === 'edit' ? (
                // Eye icon = "view" (the action when clicked)
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 8s2-5 6.5-5 6.5 5 6.5 5-2 5-6.5 5S1.5 8 1.5 8z" />
                  <circle cx="8" cy="8" r="2" />
                </svg>
              ) : (
                // Pencil icon = "edit" (the action when clicked)
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 1.5l3.5 3.5L5 14.5H1.5V11L11 1.5z" />
                </svg>
              )}
            </button>
            <button
              className="file-tree-action-btn"
              onClick={() => setCreatingIn(workingDirectory)}
              title="New markdown file"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="0.5">
                <path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v3.5H12" fill="none" />
                <path d="M7 8v4m-2-2h4" fill="none" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </div>
        <div
          className="file-tree-list"
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
        >
          {creatingIn === workingDirectory && (
            <NewFileInput
              dir={workingDirectory}
              depth={0}
              onSubmit={handleCreateSubmit}
              onCancel={() => setCreatingIn(null)}
            />
          )}
          {rootEntries.length === 0 && creatingIn !== workingDirectory && (
            <div className="readme-tree-empty">No markdown files</div>
          )}
          {rootEntries.map((entry) => (
            <MdTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              currentFile={currentFile}
              refreshKey={treeRefresh}
              creatingIn={creatingIn}
              dragHover={dragHover}
              onSelect={(p) => loadFile(p, true)}
              onContextMenu={handleContextMenu}
              onCreateSubmit={handleCreateSubmit}
              onCreateCancel={() => setCreatingIn(null)}
              onDragStartItem={handleDragStartItem}
              onDragOverItem={handleDragOverItem}
              onDragLeaveItem={handleDragLeaveItem}
              onDropItem={handleDropItem}
              onDragEndItem={handleDragEndItem}
            />
          ))}
        </div>
      </div>
      {ctxMenu && (
        <div
          className="file-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button
            className="file-ctx-item"
            onClick={() => {
              setCreatingIn(ctxMenu.entry.isDirectory ? ctxMenu.entry.path : workingDirectory);
              setCtxMenu(null);
            }}
          >
            New markdown file{ctxMenu.entry.isDirectory ? ' here' : ''}
          </button>
          <div className="file-ctx-divider" />
          <button
            className="file-ctx-item file-ctx-item-danger"
            onClick={() => {
              setDeleteTarget(ctxMenu.entry);
              setCtxMenu(null);
            }}
          >
            Delete{ctxMenu.entry.isDirectory ? ' folder' : ''}…
          </button>
        </div>
      )}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete {deleteTarget.isDirectory ? 'folder' : 'file'}</h3>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.5 }}>
                Delete <strong>{deleteTarget.name}</strong>?
                {deleteTarget.isDirectory && (
                  <> The folder and everything inside it will be removed.</>
                )}
                {' '}This can&apos;t be undone from inside the app.
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-footer-right">
                <button className="cancel-btn" onClick={() => setDeleteTarget(null)}>Cancel</button>
                <button className="delete-btn" onClick={handleDeleteConfirm}>Delete</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (loading) {
    return (
      <div className="readme-split">
        <div className="readme-viewer">
          <div className="readme-loading">Loading...</div>
        </div>
        {tree}
      </div>
    );
  }

  // Edit mode: render the CodeMirror host. The mount effect attaches a
  // view to it; nothing else lives in this pane. We always render the host
  // when mode === 'edit' (even with no file) so the ref is available when
  // `currentFile` lands.
  if (mode === 'edit') {
    return (
      <div className="readme-split">
        <div className="readme-edit">
          <div className="readme-edit-header">
            <span className="readme-edit-path" title={currentFile}>
              {currentFile.split('/').pop() || 'No file'}
              {modified && <span className="readme-edit-modified">•</span>}
            </span>
            <button
              className="readme-edit-save"
              onClick={() => saveEditor()}
              disabled={!modified || !currentFile}
              title="Save (⌘S)"
            >
              Save
            </button>
          </div>
          <div className="readme-edit-host" ref={editorHostRef} />
          {!currentFile && (
            <div className="readme-empty">Pick a file from the tree, or click the + button to create one</div>
          )}
        </div>
        {tree}
      </div>
    );
  }

  if (!content) {
    return (
      <div className="readme-split">
        <div className="readme-viewer">
          <div className="readme-empty">No README.md found in this project</div>
        </div>
        {tree}
      </div>
    );
  }

  return (
    <div className="readme-split">
      <div
        className="readme-viewer"
        ref={viewerRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onMouseMove={showBack}
        onClick={handleClick}
      >
        {history.length > 0 && (
          <button
            className={`readme-back-btn ${backVisible ? 'readme-back-visible' : ''}`}
            onClick={(e) => { e.stopPropagation(); goBack(); }}
            title="Back (Backspace)"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M7 2L1 8l6 6v-4h6V6H7V2z" />
            </svg>
          </button>
        )}
        <div
          className="readme-content"
          style={{ zoom } as React.CSSProperties}
        >
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >{content}</Markdown>
        </div>
      </div>
      {tree}
    </div>
  );
}
