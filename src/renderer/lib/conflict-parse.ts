// ── Shared git conflict parsing (T-058 / T-059 / T-060) ───────────
//
// One implementation of conflict-marker scanning + resolution, used by
// the conflict resolver, the 3-pane merge editor, and the inline
// CodeLens provider. Operates purely on text; no React, no Monaco.

export type HunkDecision = 'ours' | 'theirs' | 'both-ot' | 'both-to';

export interface ConflictBlock {
  /** 1-based line of the `<<<<<<<` marker. */
  startLine: number;
  /** 1-based line of the `>>>>>>>` marker (or last line if malformed). */
  endLine: number;
  ours: string[];
  /** Diff3-style base section (`|||||||`), or null when absent. */
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

/** A conflict region expressed in 1-based editor line numbers — for
 * decoration + floating-button placement in the merge editor. */
export interface MergeRegion {
  index: number;
  anchorLine: number;
  oursRange: [number, number] | null;
  theirsRange: [number, number] | null;
  baseRange: [number, number] | null;
  markerLines: number[];
}

const CONFLICT_RE = /^<{7}\s*(.*)$/;
const SEPARATOR_RE = /^={7}\s*$/;
const BASE_RE = /^\|{7}\s*(.*)$/;
const END_RE = /^>{7}\s*(.*)$/;

/** Cheap check before doing any real scanning. */
export function hasConflictMarkers(raw: string): boolean {
  return raw.includes('<<<<<<<') && raw.includes('=======') && raw.includes('>>>>>>>');
}

export function detectNewline(raw: string): '\n' | '\r\n' {
  // First newline wins. Files with mixed endings keep whichever git
  // wrote first in the conflict region.
  const first = raw.indexOf('\n');
  if (first > 0 && raw[first - 1] === '\r') return '\r\n';
  return '\n';
}

export function splitLines(raw: string): string[] {
  // Strip trailing \r so downstream join with '\n' (Monaco normalises
  // to the model EOL on save) doesn't double up CRs on Windows files.
  return raw.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Scan text for conflict blocks, recording 1-based line ranges. */
export function scanConflicts(raw: string): ConflictBlock[] {
  const lines = splitLines(raw);
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(CONFLICT_RE);
    if (!open) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const oursLabel = open[1].trim() || 'ours';
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let theirsLabel = 'theirs';
    i++;
    while (i < lines.length && !SEPARATOR_RE.test(lines[i]) && !BASE_RE.test(lines[i])) {
      ours.push(lines[i]);
      i++;
    }
    if (i < lines.length && BASE_RE.test(lines[i])) {
      base = [];
      i++;
      while (i < lines.length && !SEPARATOR_RE.test(lines[i])) {
        base.push(lines[i]);
        i++;
      }
    }
    if (i < lines.length && SEPARATOR_RE.test(lines[i])) i++;
    while (i < lines.length && !END_RE.test(lines[i])) {
      theirs.push(lines[i]);
      i++;
    }
    let endLine: number;
    if (i < lines.length) {
      const end = lines[i].match(END_RE);
      if (end) theirsLabel = end[1].trim() || 'theirs';
      endLine = i + 1;
      i++;
    } else {
      endLine = lines.length; // malformed (no closing marker)
    }
    blocks.push({ startLine, endLine, ours, base, theirs, oursLabel, theirsLabel });
  }
  return blocks;
}

export function resolutionLines(b: ConflictBlock, decision: HunkDecision): string[] {
  if (decision === 'ours') return b.ours;
  if (decision === 'theirs') return b.theirs;
  if (decision === 'both-ot') return [...b.ours, ...b.theirs];
  return [...b.theirs, ...b.ours]; // both-to
}

/** Reconstruct one side's full file from the conflicted working-tree
 * content: common (non-conflict) lines verbatim, each conflict resolved
 * to `side`. Also returns the 1-based line ranges of each conflict's
 * contributed lines in that reconstruction — so the merge editor can
 * highlight exactly the code that side puts into the result. Equivalent
 * to the git `:2`/`:3` stage for a standard conflict, but self-consistent
 * (derived from the same markers the result shows) so the highlight
 * always lines up. */
export function buildSideView(raw: string, side: 'ours' | 'theirs'): { text: string; ranges: [number, number][] } {
  const lines = splitLines(raw);
  const blocks = scanConflicts(raw);
  const out: string[] = [];
  const ranges: [number, number][] = [];
  let cursor = 0; // 0-based index into `lines`
  for (const b of blocks) {
    // Common lines before the `<<<` marker (b.startLine is 1-based).
    for (let k = cursor; k <= b.startLine - 2; k++) out.push(lines[k]);
    const sideLines = side === 'ours' ? b.ours : b.theirs;
    if (sideLines.length > 0) {
      const start = out.length + 1; // 1-based
      out.push(...sideLines);
      ranges.push([start, out.length]);
    }
    cursor = b.endLine; // 0-based index of the line after the `>>>` marker
  }
  for (let k = cursor; k < lines.length; k++) out.push(lines[k]);
  return { text: out.join('\n'), ranges };
}

/** Map scanned blocks to 1-based region ranges for the merge editor. */
export function regionsFromBlocks(blocks: ConflictBlock[]): MergeRegion[] {
  return blocks.map((b, index) => {
    const oursLen = b.ours.length;
    const theirsLen = b.theirs.length;
    const oursEnd = b.startLine + oursLen; // last ours content line
    const oursRange: [number, number] | null = oursLen > 0 ? [b.startLine + 1, oursEnd] : null;
    const markerLines = [b.startLine, b.endLine];
    let baseRange: [number, number] | null = null;
    let sepLine: number;
    if (b.base) {
      const baseMarkerLine = oursEnd + 1;
      markerLines.push(baseMarkerLine);
      baseRange = b.base.length > 0 ? [baseMarkerLine + 1, baseMarkerLine + b.base.length] : null;
      sepLine = baseMarkerLine + b.base.length + 1;
    } else {
      sepLine = oursEnd + 1;
    }
    markerLines.push(sepLine);
    const theirsRange: [number, number] | null = theirsLen > 0 ? [sepLine + 1, sepLine + theirsLen] : null;
    return { index, anchorLine: b.startLine, oursRange, theirsRange, baseRange, markerLines };
  });
}
