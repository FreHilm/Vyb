import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Conflict-resolver overlay (T-025) ─────────────────────────────
//
// Renders inside the Git panel body whenever GitChangesPanel has an
// `activeConflictFile`. The user picks per-hunk resolutions (ours /
// theirs / both / both-reversed), clicks "Apply & stage", and the
// component rewrites the working-tree file with markers removed and
// stages it via the existing `gitStage` IPC. That's enough to drive
// the merge / rebase / cherry-pick / revert continue flow without
// leaving the app.
//
// Manual-edit mode (let the user type into a conflict region directly)
// is deferred to V2 — V1 covers the four canned resolutions which
// match what Fork's conflict picker offers as one-click actions.

export interface ConflictResolverProps {
  workingDirectory: string;
  filePath: string;
  onClose: () => void;
  /** Fired after the file is rewritten + staged. The panel uses this
   * to bump its reload epoch so the in-progress banner refreshes its
   * conflicted-files list. */
  onResolved: () => void;
}

type HunkDecision = 'ours' | 'theirs' | 'both-ot' | 'both-to' | null;

interface ConflictHunk {
  /** Lines before the `<<<<<<<` marker that have already been resolved
   * (or never conflicted) — emitted verbatim in the output. */
  prefix: string[];
  ours: string[];
  /** Diff3-style base section if the file was generated with
   * `merge.conflictStyle = diff3` — otherwise we fetch :1:path
   * separately. Pre-populated only for the matching hunk index when
   * the working-tree file contains the `|||||||` section. */
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

interface ParsedFile {
  hunks: ConflictHunk[];
  /** Tail content after the last hunk's `>>>>>>>` marker. */
  tail: string[];
  /** Detected line ending — preserved on write-back so the file
   * doesn't flip from CRLF to LF (or vice versa) on resolve. */
  newline: '\n' | '\r\n';
}

const CONFLICT_RE = /^<{7}\s*(.*)$/;
const SEPARATOR_RE = /^={7}\s*$/;
const BASE_RE = /^\|{7}\s*(.*)$/;
const END_RE = /^>{7}\s*(.*)$/;

function detectNewline(raw: string): '\n' | '\r\n' {
  // First newline wins. Files with mixed endings keep whichever git
  // wrote first in the conflict region.
  const first = raw.indexOf('\n');
  if (first > 0 && raw[first - 1] === '\r') return '\r\n';
  return '\n';
}

function splitLines(raw: string): string[] {
  // Strip trailing \r so downstream join with the detected newline
  // doesn't double up CRs on Windows-checkout files.
  return raw.split('\n').map((l) => l.endsWith('\r') ? l.slice(0, -1) : l);
}

function parseConflicts(raw: string): ParsedFile {
  const newline = detectNewline(raw);
  const lines = splitLines(raw);
  const hunks: ConflictHunk[] = [];
  let prefix: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const openMatch = line.match(CONFLICT_RE);
    if (!openMatch) {
      prefix.push(line);
      i++;
      continue;
    }
    const oursLabel = openMatch[1].trim() || 'ours';
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let theirsLabel = 'theirs';
    i++;
    // ours section — until ||||||| or =======
    while (i < lines.length && !SEPARATOR_RE.test(lines[i]) && !BASE_RE.test(lines[i])) {
      ours.push(lines[i]);
      i++;
    }
    // optional diff3 base section
    if (i < lines.length && BASE_RE.test(lines[i])) {
      base = [];
      i++;
      while (i < lines.length && !SEPARATOR_RE.test(lines[i])) {
        base.push(lines[i]);
        i++;
      }
    }
    // ======= separator
    if (i < lines.length && SEPARATOR_RE.test(lines[i])) {
      i++;
    }
    // theirs section — until >>>>>>>
    while (i < lines.length && !END_RE.test(lines[i])) {
      theirs.push(lines[i]);
      i++;
    }
    if (i < lines.length) {
      const endMatch = lines[i].match(END_RE);
      if (endMatch) theirsLabel = endMatch[1].trim() || 'theirs';
      i++;
    }
    hunks.push({ prefix, ours, base, theirs, oursLabel, theirsLabel });
    prefix = [];
  }
  return { hunks, tail: prefix, newline };
}

function applyDecision(hunk: ConflictHunk, decision: HunkDecision): string[] {
  if (decision === 'ours') return hunk.ours;
  if (decision === 'theirs') return hunk.theirs;
  if (decision === 'both-ot') return [...hunk.ours, ...hunk.theirs];
  if (decision === 'both-to') return [...hunk.theirs, ...hunk.ours];
  // No decision yet — keep markers so the user can come back. Won't
  // hit this path on Apply, the button is gated until every hunk is
  // decided.
  return [
    `<<<<<<< ${hunk.oursLabel}`,
    ...hunk.ours,
    ...(hunk.base ? [`||||||| base`, ...hunk.base] : []),
    '=======',
    ...hunk.theirs,
    `>>>>>>> ${hunk.theirsLabel}`,
  ];
}

function buildResolved(parsed: ParsedFile, decisions: HunkDecision[]): string {
  const out: string[] = [];
  for (let i = 0; i < parsed.hunks.length; i++) {
    out.push(...parsed.hunks[i].prefix);
    out.push(...applyDecision(parsed.hunks[i], decisions[i]));
  }
  out.push(...parsed.tail);
  return out.join(parsed.newline);
}

export function ConflictResolver({ workingDirectory, filePath, onClose, onResolved }: ConflictResolverProps) {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [decisions, setDecisions] = useState<HunkDecision[]>([]);
  const [baseStage, setBaseStage] = useState<string | null>(null);
  const [oursStage, setOursStage] = useState<string | null>(null);
  const [theirsStage, setTheirsStage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Avoid stale-state writes when the user clicks a file pill, then
  // quickly switches to another file before the first one finishes.
  const requestRef = useRef(0);

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
    setParsed(null);
    setDecisions([]);
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
        const next = parseConflicts(raw);
        setParsed(next);
        setDecisions(next.hunks.map((): HunkDecision => null));
        setBaseStage(base ?? '');
        setOursStage(ours ?? '');
        setTheirsStage(theirs ?? '');
        if (next.hunks.length === 0) {
          // No markers — likely add/add (binary) or already-resolved.
          // Surface that so the user knows the panel can't help here.
          setError('No conflict markers found. Resolve via the shell or stage the file directly.');
        }
        setLoading(false);
      } catch (e) {
        if (id !== requestRef.current) return;
        setError(e instanceof Error ? e.message : 'Failed to load conflict.');
        setLoading(false);
      }
    })();
  }, [absolutePath, workingDirectory, filePath]);

  const setDecision = useCallback((idx: number, value: HunkDecision) => {
    setDecisions((prev) => prev.map((d, i) => (i === idx ? value : d)));
  }, []);

  const allDecided = decisions.length > 0 && decisions.every((d) => d !== null);

  const handleApply = useCallback(async () => {
    if (!parsed || !allDecided || busy) return;
    setBusy(true);
    setError(null);
    try {
      const merged = buildResolved(parsed, decisions);
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
  }, [parsed, decisions, allDecided, busy, absolutePath, workingDirectory, filePath, onResolved, onClose]);

  const remaining = decisions.filter((d) => d === null).length;
  const oursLabel = parsed?.hunks[0]?.oursLabel || 'ours';
  const theirsLabel = parsed?.hunks[0]?.theirsLabel || 'theirs';

  return (
    <div className="git-conflict-overlay" role="dialog" aria-label={`Resolve conflicts in ${filePath}`}>
      <div className="git-conflict-header">
        <div className="git-conflict-title">
          <span className="git-conflict-title-label">Resolve conflicts</span>
          <code className="git-conflict-title-path">{filePath}</code>
        </div>
        <div className="git-conflict-header-actions">
          {parsed && parsed.hunks.length > 0 && (
            <span className="git-conflict-progress">
              {decisions.length - remaining} / {decisions.length} hunks decided
            </span>
          )}
          <button
            className="git-conflict-apply"
            disabled={!allDecided || busy}
            onClick={handleApply}
            title={allDecided ? 'Write resolved file and stage' : 'Pick a resolution for every hunk first'}
          >
            {busy ? 'Applying…' : 'Apply & stage'}
          </button>
          <button className="git-conflict-close" onClick={onClose} aria-label="Close conflict resolver" title="Close">×</button>
        </div>
      </div>

      {error && (
        <div className="git-conflict-error">{error}</div>
      )}

      <div className="git-conflict-body">
        {loading ? (
          <div className="git-conflict-loading">Loading conflict…</div>
        ) : !parsed || parsed.hunks.length === 0 ? (
          <ConflictNoMarkers
            base={baseStage}
            ours={oursStage}
            theirs={theirsStage}
          />
        ) : (
          <div className="git-conflict-hunks">
            {parsed.hunks.map((hunk, idx) => (
              <ConflictHunkCard
                key={idx}
                index={idx}
                hunk={hunk}
                decision={decisions[idx]}
                onChoose={(v) => setDecision(idx, v)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="git-conflict-footer">
        <div className="git-conflict-footer-legend">
          <span><span className="git-conflict-swatch git-conflict-swatch-ours" /> {oursLabel} (HEAD)</span>
          <span><span className="git-conflict-swatch git-conflict-swatch-theirs" /> {theirsLabel} (incoming)</span>
        </div>
      </div>
    </div>
  );
}

interface ConflictHunkCardProps {
  index: number;
  hunk: ConflictHunk;
  decision: HunkDecision;
  onChoose: (value: HunkDecision) => void;
}

function ConflictHunkCard({ index, hunk, decision, onChoose }: ConflictHunkCardProps) {
  return (
    <div className={`git-conflict-hunk${decision ? ' git-conflict-hunk-decided' : ''}`}>
      <div className="git-conflict-hunk-header">
        <span className="git-conflict-hunk-num">Hunk {index + 1}</span>
        <div className="git-conflict-hunk-actions">
          <button
            className={`git-conflict-choice${decision === 'ours' ? ' git-conflict-choice-active' : ''}`}
            onClick={() => onChoose('ours')}
            title="Keep the version from HEAD only"
          >Use ours</button>
          <button
            className={`git-conflict-choice${decision === 'theirs' ? ' git-conflict-choice-active' : ''}`}
            onClick={() => onChoose('theirs')}
            title="Keep the incoming version only"
          >Use theirs</button>
          <button
            className={`git-conflict-choice${decision === 'both-ot' ? ' git-conflict-choice-active' : ''}`}
            onClick={() => onChoose('both-ot')}
            title="Keep both sides; ours first, then theirs"
          >Both (ours→theirs)</button>
          <button
            className={`git-conflict-choice${decision === 'both-to' ? ' git-conflict-choice-active' : ''}`}
            onClick={() => onChoose('both-to')}
            title="Keep both sides; theirs first, then ours"
          >Both (theirs→ours)</button>
        </div>
      </div>
      <div className="git-conflict-hunk-grid">
        <ConflictPane
          side="ours"
          label={`${hunk.oursLabel} (HEAD)`}
          lines={hunk.ours}
          empty="(no content from HEAD)"
        />
        <ConflictPane
          side="theirs"
          label={`${hunk.theirsLabel} (incoming)`}
          lines={hunk.theirs}
          empty="(no incoming content)"
        />
      </div>
      {hunk.base && hunk.base.length > 0 && (
        <details className="git-conflict-base">
          <summary>Show common ancestor ({hunk.base.length} line{hunk.base.length === 1 ? '' : 's'})</summary>
          <ConflictPane
            side="base"
            label="base"
            lines={hunk.base}
            empty="(empty in base)"
          />
        </details>
      )}
    </div>
  );
}

interface ConflictPaneProps {
  side: 'ours' | 'theirs' | 'base';
  label: string;
  lines: string[];
  empty: string;
}

function ConflictPane({ side, label, lines, empty }: ConflictPaneProps) {
  return (
    <div className={`git-conflict-pane git-conflict-pane-${side}`}>
      <div className="git-conflict-pane-label">{label}</div>
      <pre className="git-conflict-pane-body">
        {lines.length === 0 ? <span className="git-conflict-pane-empty">{empty}</span> : lines.join('\n')}
      </pre>
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
  // shell — V1 doesn't auto-stage these.
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
