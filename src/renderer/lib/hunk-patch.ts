// Build a partial unified-diff patch suitable for `git apply --cached`.
//
// Given the full `git diff` (or `git diff --cached`) output for a single
// file and a `Set<number>` of "selected" line indices, this module emits
// a new patch that includes only the selected `+`/`-` lines. Unselected
// `+` lines are dropped (treated as if the addition didn't happen);
// unselected `-` lines become context (the deletion didn't happen, so
// the line is still there from the index's point of view).
//
// The line indices index into the renderer's flat `DiffLine[]` from
// `parseDiff` in `GitChangesPanel.tsx`. That parser drops the file
// header (diff --git / index / --- / +++) and the `\ No newline at end
// of file` markers, so this builder re-parses the raw diff text instead
// of consuming the renderer's structure. That keeps it independent and
// preserves the file header lines verbatim — which matters for renamed
// files, new files, and mode changes.

export interface BuildPatchOptions {
  /** Original `git diff` (or `git diff --cached`) output for the file.
   * Must be exactly what came from main — don't trim or normalise. */
  rawDiff: string;
  /** Set of 0-based indices into the `DiffLine[]` produced by
   * `parseDiff`. Indices reference `+`/`-` lines only; including a
   * context or hunk-header index is a no-op. */
  selectedLineIdx: Set<number>;
  /** When true, every `+`/`-` line is included (used for "stage
   * hunk" — caller passes the indices of all `+/-` lines in that
   * hunk; this flag would be redundant). Kept off for the selection
   * flow. */
  includeAll?: boolean;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Body lines including their leading char (' ', '+', '-', '\').
   * The `\ No newline at end of file` lines are kept attached to the
   * preceding +/- line they belong to and re-emitted verbatim. */
  body: { char: ' ' | '+' | '-' | '\\'; text: string }[];
  /** Original 0-based DiffLine index for each body entry. Context
   * lines and `\ No newline` markers carry -1 so they're never in the
   * selected set; only the +/- lines have meaningful indices. */
  bodyIdx: number[];
}

interface ParsedFile {
  header: string[];
  hunks: ParsedHunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseRawDiff(raw: string): ParsedFile {
  const allLines = raw.split('\n');
  // Last element is empty when the string ends with \n. Drop it so we
  // don't emit a phantom extra newline; the join at the end re-adds.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

  const header: string[] = [];
  const hunks: ParsedHunk[] = [];
  let i = 0;
  // Header is everything up to the first @@. Includes `diff --git`,
  // `index abc..def`, mode lines, similarity index, rename from/to,
  // `--- a/path` / `+++ b/path` (or `/dev/null` for adds/deletes).
  while (i < allLines.length && !allLines[i].startsWith('@@')) {
    header.push(allLines[i]);
    i++;
  }
  let diffLineCounter = -1; // -1 because parseDiff doesn't index header
  while (i < allLines.length) {
    const line = allLines[i];
    const m = line.match(HUNK_HEADER_RE);
    if (!m) {
      // Defensive: skip stray lines, but in well-formed diffs this is
      // unreachable.
      i++;
      continue;
    }
    diffLineCounter++; // hunk header is itself a DiffLine of type 'hunk'
    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    const body: ParsedHunk['body'] = [];
    const bodyIdx: number[] = [];
    i++;
    while (i < allLines.length && !allLines[i].startsWith('@@')) {
      const raw = allLines[i];
      const ch = raw.length === 0 ? ' ' : raw[0];
      const rest = raw.length === 0 ? '' : raw.slice(1);
      if (ch === '\\') {
        // `\ No newline at end of file` — attach with -1 idx, won't be
        // selectable but follows its preceding +/- in output.
        body.push({ char: '\\', text: rest });
        bodyIdx.push(-1);
      } else if (ch === '+') {
        diffLineCounter++;
        body.push({ char: '+', text: rest });
        bodyIdx.push(diffLineCounter);
      } else if (ch === '-') {
        diffLineCounter++;
        body.push({ char: '-', text: rest });
        bodyIdx.push(diffLineCounter);
      } else if (ch === ' ') {
        diffLineCounter++;
        body.push({ char: ' ', text: rest });
        bodyIdx.push(-1);
      } else {
        // Unknown leading char — bail, leave as-is.
        i++;
        continue;
      }
      i++;
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, body, bodyIdx });
  }
  return { header, hunks };
}

function emitHunk(hunk: ParsedHunk, selected: Set<number>, includeAll: boolean): { lines: string[]; newOldCount: number; newNewCount: number } {
  const out: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let hasChange = false;
  for (let i = 0; i < hunk.body.length; i++) {
    const entry = hunk.body[i];
    const idx = hunk.bodyIdx[i];
    if (entry.char === '\\') {
      // Re-emit `\ No newline at end of file` if its associated +/-
      // line survived to the output. Look at the immediately preceding
      // emitted line: if we just emitted a +/-/' ' that came from the
      // same side, keep it; otherwise drop it (the side this marker
      // belonged to was filtered out, so the no-newline note doesn't
      // apply).
      if (out.length > 0 && (out[out.length - 1].startsWith('+') || out[out.length - 1].startsWith('-') || out[out.length - 1].startsWith(' '))) {
        out.push('\\' + entry.text);
      }
      continue;
    }
    if (entry.char === ' ') {
      out.push(' ' + entry.text);
      oldCount++;
      newCount++;
      continue;
    }
    const include = includeAll || selected.has(idx);
    if (entry.char === '+') {
      if (include) {
        out.push('+' + entry.text);
        newCount++;
        hasChange = true;
      }
      // else: drop the addition entirely — neither side counts it
      continue;
    }
    if (entry.char === '-') {
      if (include) {
        out.push('-' + entry.text);
        oldCount++;
        hasChange = true;
      } else {
        // Demote unselected deletion to context: the line stays in
        // both sides, since we're not staging its removal.
        out.push(' ' + entry.text);
        oldCount++;
        newCount++;
      }
    }
  }
  if (!hasChange) {
    return { lines: [], newOldCount: 0, newNewCount: 0 };
  }
  return { lines: out, newOldCount: oldCount, newNewCount: newCount };
}

export function buildPartialPatch({ rawDiff, selectedLineIdx, includeAll = false }: BuildPatchOptions): string | null {
  const parsed = parseRawDiff(rawDiff);
  const outLines: string[] = [];
  // Re-emit the header verbatim. Trailing blank lines stripped earlier
  // by parseRawDiff are restored implicitly by the final join('\n')
  // plus the trailing '\n' we append at the bottom.
  for (const h of parsed.header) outLines.push(h);
  let any = false;
  for (const hunk of parsed.hunks) {
    const { lines, newOldCount, newNewCount } = emitHunk(hunk, selectedLineIdx, includeAll);
    if (lines.length === 0) continue;
    any = true;
    const oldRange = newOldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${newOldCount}`;
    const newRange = newNewCount === 1 ? `${hunk.newStart}` : `${hunk.newStart},${newNewCount}`;
    outLines.push(`@@ -${oldRange} +${newRange} @@`);
    for (const l of lines) outLines.push(l);
  }
  if (!any) return null;
  return outLines.join('\n') + '\n';
}

/** Convenience: collect every +/− DiffLine index inside a single hunk
 * (selected by hunkIndex among the file's hunk-type entries). Used by
 * the "Stage hunk" button — we just feed `includeAll: true` and pass
 * the rawDiff filtered to a single hunk... or simpler, we pass the
 * full diff and selectedLineIdx covering only that hunk's +/− lines.
 * This helper produces that set from the renderer's parsed DiffLine[]. */
export function indicesForHunk(lines: { type: string }[], hunkIndex: number): Set<number> {
  const result = new Set<number>();
  let currentHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === 'hunk') {
      currentHunk++;
      continue;
    }
    if (currentHunk !== hunkIndex) continue;
    if (lines[i].type === 'add' || lines[i].type === 'del') result.add(i);
  }
  return result;
}
