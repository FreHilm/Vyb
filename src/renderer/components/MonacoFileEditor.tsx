import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import '../lib/monaco-setup'; // side effect: wire workers before any editor is created
import type { GitBlameLine } from '../../shared/types';
import { buildBlameDecorations } from '../lib/monaco-blame';

interface Props {
  /** Absolute path — used as the model URI so each file gets its own
   * undo history + language. */
  path: string;
  /** Initial file contents. Subsequent prop changes are ignored; the
   * editor owns the buffer after mount (same contract as the
   * CodeMirror host). */
  initialContent: string;
  /** The last-saved-to-disk content, used as the dirty baseline. The
   * parent updates this after a successful save so the tab's modified
   * mark clears correctly (and re-dirties only on the next real edit). */
  savedContent: string;
  /** Monaco language id (e.g. 'typescript', 'json'). */
  language: string;
  fontSize: number;
  /** Fired on every edit with the current text + whether it differs
   * from `initialContent` (the saved baseline). Lets the parent drive
   * its modified-tab tracking. */
  onChange: (content: string, isDirty: boolean) => void;
  /** Cmd/Ctrl+S inside the editor. */
  onSave: () => void;
  /** Per-line git blame to render as a left column. Omit / empty for no
   * blame. Applied live without remounting. */
  blame?: GitBlameLine[];
  /** Clicking a committed blame row calls this with the line's SHA so the
   * host can open that commit. */
  onBlameSelect?: (sha: string) => void;
}

/**
 * Self-contained Monaco editor for the plain (non-diff, non-markdown)
 * file path. Deliberately minimal: it manages its own model + view and
 * reports content/dirty/save up to FileExplorer, which keeps owning
 * tab state, the modified set, and the actual disk write. This is the
 * spike surface — diff, blame, and markdown editing stay on CodeMirror.
 */
export function MonacoFileEditor({
  path, initialContent, savedContent, language, fontSize, onChange, onSave, blame, onBlameSelect,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Keep the latest callbacks in refs so the once-on-mount editor +
  // its disposables always call through to current handlers without
  // re-creating the editor on every render.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  // Blame decorations live in their own collection so they can be
  // refreshed independently of the editor lifecycle. A line→SHA map
  // resolves clicks on the injected blame column back to a commit.
  const blameCollectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const blameByLineRef = useRef<Map<number, string>>(new Map());
  const onBlameSelectRef = useRef(onBlameSelect);
  onBlameSelectRef.current = onBlameSelect;
  // Latest blame snapshot, read by the mount effect so a remount
  // (path/language change) re-seeds decorations without waiting for the
  // [blame] effect to fire.
  const blameRef = useRef(blame);
  blameRef.current = blame;
  // Dirty baseline = last saved content. Tracked in a ref and synced
  // from the `savedContent` prop so a save (which updates the prop)
  // re-baselines without remounting the editor.
  const baselineRef = useRef(savedContent);

  // Mount once. The model URI is the file path so undo history is
  // per-file and re-opening the same file is stable.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const uri = monaco.Uri.file(path);
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(initialContent, language, uri);
    // If a stale model lingered from a previous mount, reset it to the
    // fresh disk content + language.
    if (model.getValue() !== initialContent) model.setValue(initialContent);
    monaco.editor.setModelLanguage(model, language);

    const editor = monaco.editor.create(host, {
      model,
      theme: 'vs-dark',
      fontSize,
      automaticLayout: true,        // tracks container resize
      minimap: { enabled: true },
      stickyScroll: { enabled: true }, // native — replaces lib/sticky-scroll
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
    });
    editorRef.current = editor;

    const changeSub = model.onDidChangeContent(() => {
      const value = model.getValue();
      onChangeRef.current(value, value !== baselineRef.current);
    });

    // Cmd/Ctrl+S → save. Monaco swallows the browser default itself.
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSaveRef.current(),
    );

    // Clipboard now comes from the native Edit-menu roles (focus-aware; see
    // main.ts) — Monaco handles the copy/cut/paste DOM events itself.

    blameCollectionRef.current = editor.createDecorationsCollection();
    // Seed decorations from the current blame (survives remounts).
    {
      const seed = blameRef.current;
      const byLine = new Map<number, string>();
      if (seed && seed.length) {
        for (const entry of seed) byLine.set(entry.lineNumber, entry.sha);
        blameCollectionRef.current.set(buildBlameDecorations(seed));
      }
      blameByLineRef.current = byLine;
    }

    // Click on the injected blame column → open that commit. The column
    // is injected `before` text at column 1; we detect a hit by climbing
    // the DOM to `.monaco-blame-col`, then map the click point back to a
    // line number (the model column for injected text is always 1, so we
    // can't read the SHA from the position directly).
    const dom = editor.getDomNode();
    const onBlameClick = (ev: MouseEvent) => {
      if (blameByLineRef.current.size === 0) return;
      const el = ev.target as HTMLElement | null;
      if (!el || !el.closest('.monaco-blame-col')) return;
      const target = editor.getTargetAtClientPoint(ev.clientX, ev.clientY);
      const line = target?.position?.lineNumber;
      if (line == null) return;
      const sha = blameByLineRef.current.get(line);
      if (sha) { ev.stopPropagation(); onBlameSelectRef.current?.(sha); }
    };
    dom?.addEventListener('mousedown', onBlameClick, true);

    return () => {
      changeSub.dispose();
      dom?.removeEventListener('mousedown', onBlameClick, true);
      blameCollectionRef.current?.clear();
      blameCollectionRef.current = null;
      editor.dispose();
      editorRef.current = null;
      // Dispose the model too so re-mounting starts clean (otherwise
      // the cached model keeps the old buffer/undo stack).
      try { model.dispose(); } catch { /* already gone */ }
    };
    // Re-mount when the file or language changes.
  }, [path, language]);

  // Live-apply font size without remounting.
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  // Live-apply blame as injected-text decorations. Rebuilt whenever the
  // blame snapshot changes; cleared when blame is removed.
  useEffect(() => {
    const collection = blameCollectionRef.current;
    if (!collection) return;
    const byLine = new Map<number, string>();
    if (blame && blame.length) {
      for (const entry of blame) byLine.set(entry.lineNumber, entry.sha);
    }
    blameByLineRef.current = byLine;
    collection.set(blame && blame.length ? buildBlameDecorations(blame) : []);
  }, [blame]);

  // Re-baseline dirty tracking when the saved content changes (e.g.
  // after a save or an external reload). Nothing to do to the buffer;
  // just update what "clean" means for the next edit.
  useEffect(() => {
    baselineRef.current = savedContent;
  }, [savedContent]);

  /** Lets the parent reset the dirty baseline after a successful save
   * without remounting (call via ref if needed; currently the parent
   * re-derives dirty from onChange + its own saved content). */

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}

/** Map a filename to a Monaco language id. Mirrors the set the
 * CodeMirror path supports; unknown extensions fall back to
 * plaintext (Monaco still gives a usable editor). */
export function monacoLanguageForFile(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'json': return 'json';
    case 'css': case 'scss': case 'less': return 'css';
    case 'html': case 'htm': case 'xml': case 'svg': return 'html';
    case 'py': return 'python';
    case 'md': case 'mdx': return 'markdown';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'yml': case 'yaml': return 'yaml';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'hpp': return 'cpp';
    default: return 'plaintext';
  }
}
