import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MergeResultEditor, type MergeResultEditorHandle } from './MergeResultEditor';
import { MergeEditor } from './MergeEditor';
import { monacoLanguageForFile } from './MonacoFileEditor';
import {
  scanConflicts,
  resolutionLines,
  regionsFromBlocks,
  buildSideView,
  detectNewline,
  splitLines,
  type HunkDecision,
} from '../lib/conflict-parse';

// ── Conflict-resolver overlay (T-025, editable in T-058) ──────────
//
// Renders inside the Git panel body whenever GitChangesPanel has an
// `activeConflictFile`. Phase 1 (T-058) replaced the read-only `<pre>`
// hunk cards with a single EDITABLE Monaco editor seeded from the raw
// conflicted file (markers intact) plus a hunk toolbar. The per-hunk
// "Use ours / theirs / both" buttons splice the chosen text into the
// live buffer; the user can also hand-edit anything. "Conflicts left"
// is just the count of remaining markers in the buffer, so manual
// edits that remove markers count too. Apply writes the buffer and
// stages via the existing `gitStage` IPC — enough to drive the
// merge / rebase / cherry-pick / revert continue flow in-app.

export interface ConflictResolverProps {
  workingDirectory: string;
  filePath: string;
  onClose: () => void;
  /** Fired after the file is rewritten + staged. The panel uses this
   * to bump its reload epoch so the in-progress banner refreshes its
   * conflicted-files list. */
  onResolved: () => void;
}

export function ConflictResolver({ workingDirectory, filePath, onClose, onResolved }: ConflictResolverProps) {
  // Raw file text, captured once per load — seeds the editor.
  const [initialContent, setInitialContent] = useState<string | null>(null);
  // Live editor buffer, mirrored here so the hunk toolbar re-derives.
  const [content, setContent] = useState('');
  const [eol, setEol] = useState<'\n' | '\r\n'>('\n');
  // Git index stages — only needed for the no-markers fallback.
  const [baseStage, setBaseStage] = useState<string | null>(null);
  const [oursStage, setOursStage] = useState<string | null>(null);
  const [theirsStage, setTheirsStage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Labels captured from the first scan, so the legend survives once
  // every hunk has been resolved (and the block list is empty).
  const [labels, setLabels] = useState<{ ours: string; theirs: string }>({ ours: 'ours', theirs: 'theirs' });
  // 'simple' = single editor + hunk toolbar (T-058); 'merge' = 3-pane
  // editor (T-059). Toggled in the header; the live buffer (`content`)
  // is preserved across the switch so edits aren't lost.
  const [view, setView] = useState<'simple' | 'merge'>('simple');
  // Show the common-ancestor (:1) pane in the 3-pane view.
  const [showBase, setShowBase] = useState(false);

  const editorRef = useRef<MergeResultEditorHandle | null>(null);
  // Avoid stale-state writes when the user clicks a file pill, then
  // quickly switches to another file before the first one finishes.
  const requestRef = useRef(0);

  const language = useMemo(() => monacoLanguageForFile(filePath), [filePath]);

  // Build absolute path. `filePath` arrives from git status as a
  // POSIX-relative path from the repo root, so a simple slash join is
  // correct on every platform (Electron `fs` accepts forward slashes
  // on Windows too).
  const absolutePath = useMemo(() => {
    const trimmedDir = workingDirectory.replace(/\/+$/, '');
    const trimmedFile = filePath.replace(/^\/+/, '');
    return `${trimmedDir}/${trimmedFile}`;
  }, [workingDirectory, filePath]);

  useEffect(() => {
    const id = ++requestRef.current;
    setLoading(true);
    setError(null);
    setInitialContent(null);
    setContent('');
    setBaseStage(null);
    setOursStage(null);
    setTheirsStage(null);
    (async () => {
      try {
        const [raw, base, ours, theirs] = await Promise.all([
          window.api.readFile(absolutePath),
          window.api.gitShowStage(workingDirectory, filePath, 1),
          window.api.gitShowStage(workingDirectory, filePath, 2),
          window.api.gitShowStage(workingDirectory, filePath, 3),
        ]);
        if (id !== requestRef.current) return;
        if (raw == null) {
          setError('Unable to read working-copy file.');
          setLoading(false);
          return;
        }
        const blocks = scanConflicts(raw);
        setInitialContent(raw);
        setContent(raw);
        setEol(detectNewline(raw));
        setBaseStage(base ?? '');
        setOursStage(ours ?? '');
        setTheirsStage(theirs ?? '');
        if (blocks.length === 0) {
          setError('No conflict markers found. Resolve via the shell or stage the file directly.');
        } else {
          setLabels({ ours: blocks[0].oursLabel, theirs: blocks[0].theirsLabel });
        }
        setLoading(false);
      } catch (e) {
        if (id !== requestRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to load conflict.');
        setLoading(false);
      }
    })();
  }, [absolutePath, workingDirectory, filePath]);

  // Re-derived from the live buffer on every edit.
  const conflicts = useMemo(() => scanConflicts(content), [content]);
  const regions = useMemo(() => regionsFromBlocks(conflicts), [conflicts]);
  // Reconstructed side files + exact conflict-line ranges, from the
  // ORIGINAL conflicted content (stable as the user resolves).
  const sideViews = useMemo(
    () => (initialContent != null
      ? { ours: buildSideView(initialContent, 'ours'), theirs: buildSideView(initialContent, 'theirs') }
      : null),
    [initialContent],
  );
  const remaining = conflicts.length;
  const hasMarkers = initialContent != null && !loading && !error;

  // Replace one hunk (by its current ordinal) with the chosen side. We
  // re-scan the editor's live value at click time so the splice lands on
  // the right lines even after prior edits.
  const resolveBlock = useCallback((ordinal: number, decision: HunkDecision) => {
    const ed = editorRef.current;
    if (!ed) return;
    const current = ed.getValue();
    const blocks = scanConflicts(current);
    const b = blocks[ordinal];
    if (!b) return;
    const lines = splitLines(current);
    lines.splice(b.startLine - 1, b.endLine - b.startLine + 1, ...resolutionLines(b, decision));
    ed.setValue(lines.join('\n')); // onChange → setContent re-derives conflicts
  }, []);

  // Resolve every remaining hunk to one side. Splice from last to first
  // so earlier line numbers stay valid as we go.
  const resolveAll = useCallback((side: 'ours' | 'theirs') => {
    const ed = editorRef.current;
    if (!ed) return;
    const current = ed.getValue();
    const blocks = scanConflicts(current);
    if (blocks.length === 0) return;
    const lines = splitLines(current);
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      lines.splice(b.startLine - 1, b.endLine - b.startLine + 1, ...(side === 'ours' ? b.ours : b.theirs));
    }
    ed.setValue(lines.join('\n'));
  }, []);

  const handleApply = useCallback(async () => {
    if (busy || !hasMarkers || remaining !== 0) return;
    setBusy(true);
    setError(null);
    try {
      const merged = editorRef.current?.getValue() ?? content;
      const ok = await window.api.saveFile(absolutePath, merged);
      if (!ok) {
        setError('Failed to write resolved file.');
        setBusy(false);
        return;
      }
      const staged = await window.api.gitStage(workingDirectory, filePath);
      if (!staged) {
        setError('File saved but failed to stage. Run `git add` from the shell.');
        setBusy(false);
        return;
      }
      onResolved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed.');
      setBusy(false);
    }
  }, [busy, hasMarkers, remaining, content, absolutePath, workingDirectory, filePath, onResolved, onClose]);

  return (
    <div className="git-conflict-overlay" role="dialog" aria-label={`Resolve conflicts in ${filePath}`}>
      <div className="git-conflict-header">
        <div className="git-conflict-title">
          <span className="git-conflict-title-label">Resolve conflicts</span>
          <code className="git-conflict-title-path">{filePath}</code>
        </div>
        <div className="git-conflict-header-actions">
          {hasMarkers && (
            <div className="git-conflict-viewtoggle" role="group" aria-label="Resolver view">
              <button
                className={view === 'simple' ? 'is-active' : ''}
                onClick={() => setView('simple')}
                title="Single editor with a hunk list"
              >Simple</button>
              <button
                className={view === 'merge' ? 'is-active' : ''}
                onClick={() => setView('merge')}
                title="3-pane merge editor (ours · theirs · result)"
              >3-pane</button>
            </div>
          )}
          {hasMarkers && view === 'merge' && baseStage ? (
            <button
              className={`git-conflict-basetoggle${showBase ? ' is-active' : ''}`}
              onClick={() => setShowBase((b) => !b)}
              title="Show the common-ancestor (base) version"
            >Base</button>
          ) : null}
          {hasMarkers && (
            <span className="git-conflict-progress">
              {remaining === 0 ? 'all resolved' : `${remaining} conflict${remaining === 1 ? '' : 's'} left`}
            </span>
          )}
          <button
            className="git-conflict-apply"
            disabled={!hasMarkers || remaining !== 0 || busy}
            onClick={handleApply}
            title={remaining === 0 ? 'Write resolved file and stage' : 'Resolve every conflict first'}
          >
            {busy ? 'Applying…' : 'Apply & stage'}
          </button>
          <button className="git-conflict-close" onClick={onClose} aria-label="Close conflict resolver" title="Close">×</button>
        </div>
      </div>

      {error && <div className="git-conflict-error">{error}</div>}

      <div className="git-conflict-body">
        {loading ? (
          <div className="git-conflict-loading">Loading conflict…</div>
        ) : !hasMarkers ? (
          <ConflictNoMarkers base={baseStage} ours={oursStage} theirs={theirsStage} />
        ) : view === 'merge' ? (
          <MergeEditor
            ref={editorRef}
            filePath={filePath}
            language={language}
            eol={eol}
            oursStage={sideViews?.ours.text ?? ''}
            theirsStage={sideViews?.theirs.text ?? ''}
            oursHighlight={sideViews?.ours.ranges}
            theirsHighlight={sideViews?.theirs.ranges}
            oursLabel={labels.ours}
            theirsLabel={labels.theirs}
            showBase={showBase}
            baseStage={baseStage ?? ''}
            resultValue={content}
            regions={regions}
            onResultChange={setContent}
            onRegionAction={resolveBlock}
            onSave={handleApply}
          />
        ) : (
          <div className="git-conflict-main">
            <div className="git-conflict-hunklist">
              <div className="git-conflict-hunklist-head">
                <span className="git-conflict-hunklist-title">Hunks</span>
                <div className="git-conflict-hunklist-bulk">
                  <button onClick={() => resolveAll('ours')} disabled={remaining === 0} title="Use ours for every remaining hunk">All ours</button>
                  <button onClick={() => resolveAll('theirs')} disabled={remaining === 0} title="Use theirs for every remaining hunk">All theirs</button>
                </div>
              </div>
              {conflicts.length === 0 ? (
                <div className="git-conflict-allclear">All conflicts resolved ✓<br />Edit freely, then Apply &amp; stage.</div>
              ) : (
                conflicts.map((b, idx) => (
                  <div className="git-conflict-hunkrow" key={`${b.startLine}-${idx}`}>
                    <button
                      className="git-conflict-hunkrow-jump"
                      onClick={() => editorRef.current?.reveal(b.startLine)}
                      title={`Jump to hunk ${idx + 1} (line ${b.startLine})`}
                    >
                      Hunk {idx + 1}
                    </button>
                    <div className="git-conflict-hunkrow-actions">
                      <button onClick={() => resolveBlock(idx, 'ours')} title="Keep ours (HEAD)">Ours</button>
                      <button onClick={() => resolveBlock(idx, 'theirs')} title="Keep theirs (incoming)">Theirs</button>
                      <button onClick={() => resolveBlock(idx, 'both-ot')} title="Both — ours then theirs">Both ↓</button>
                      <button onClick={() => resolveBlock(idx, 'both-to')} title="Both — theirs then ours">Both ↑</button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="git-conflict-editor">
              <MergeResultEditor
                key={`${filePath}:simple`}
                ref={editorRef}
                initialValue={content}
                language={language}
                eol={eol}
                onChange={setContent}
                onSave={handleApply}
              />
            </div>
          </div>
        )}
      </div>

      <div className="git-conflict-footer">
        <div className="git-conflict-footer-legend">
          <span><span className="git-conflict-swatch git-conflict-swatch-ours" /> {labels.ours} (HEAD)</span>
          <span><span className="git-conflict-swatch git-conflict-swatch-theirs" /> {labels.theirs} (incoming)</span>
        </div>
      </div>
    </div>
  );
}

interface NoMarkersProps {
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

function ConflictNoMarkers({ base, ours, theirs }: NoMarkersProps) {
  // Add/add binary or higher-stage-only files don't surface markers in
  // the working tree; the only meaningful action is to pick a side.
  // Stage-3 missing = "deleted by them"; stage-2 missing = "deleted by
  // us". We just show what we have and let the user resolve from the
  // shell — Phase 1 doesn't auto-stage these.
  return (
    <div className="git-conflict-no-markers">
      <p>
        This file has no inline conflict markers — it's likely an add/add
        with a binary side, or one side deleted the file. Resolve from the
        shell with one of:
      </p>
      <pre className="git-conflict-hints">
        <code>git checkout --ours -- {`<file>`}</code>{'\n'}
        <code>git checkout --theirs -- {`<file>`}</code>{'\n'}
        <code>git rm {`<file>`}</code>
      </pre>
      <div className="git-conflict-no-markers-grid">
        {base && (
          <div className="git-conflict-pane git-conflict-pane-base">
            <div className="git-conflict-pane-label">base</div>
            <pre className="git-conflict-pane-body">{base.slice(0, 2000)}</pre>
          </div>
        )}
        {ours && (
          <div className="git-conflict-pane git-conflict-pane-ours">
            <div className="git-conflict-pane-label">ours (HEAD)</div>
            <pre className="git-conflict-pane-body">{ours.slice(0, 2000)}</pre>
          </div>
        )}
        {theirs && (
          <div className="git-conflict-pane git-conflict-pane-theirs">
            <div className="git-conflict-pane-label">theirs (incoming)</div>
            <pre className="git-conflict-pane-body">{theirs.slice(0, 2000)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
