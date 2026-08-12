// Cmd/Ctrl+click "go to definition" for the Monaco editors, backed by
// ripgrep (the same FILE_SEARCH_IN_FILES IPC the Search panel uses).
//
// Vyb deliberately runs Monaco without per-language service workers
// (see monaco-setup.ts), so there is no semantic engine to ask for
// definitions. Instead a DefinitionProvider is registered for every
// language we highlight: it takes the identifier under the cursor,
// greps the workspace with a per-language "this line defines X"
// regex, and returns the best-ranked hit. Monaco supplies the UX for
// free once a provider exists — cmd-hover underlines the symbol and
// cmd+click jumps.
//
// Same-file targets Monaco navigates in place. Cross-file targets have
// no loaded model, so Monaco consults the registered editor opener,
// which hands the path+line to App.tsx via a window event — reusing the
// exact open-tab-and-reveal flow Find-in-Files results use.
import * as monaco from 'monaco-editor';

/** Workspace root the definition search runs in. The visible
 * FileExplorer keeps this pointed at the active profile's cwd. */
let searchRoot: string | null = null;
export function setDefinitionSearchRoot(cwd: string): void {
  searchRoot = cwd;
}

/** Detail payload for the 'vyb-open-definition' window event. */
export interface OpenDefinitionDetail {
  path: string;
  line: number;
}

interface LangFamily {
  /** rg include globs — keeps the search inside the same language
   * family (fast, and avoids cross-language name collisions). */
  include: string;
  /** Build the definition regex for an (escaped) identifier. Must stay
   * within rust-regex syntax (no lookaround/backreferences). */
  pattern: (w: string) => string;
  caseSensitive?: boolean;
}

// Heuristic definition patterns. They favor precision over recall for
// keyword-introduced definitions (def/class/fn/...) and accept some
// noise from the "name(args) {" method heuristics — ranking below
// prefers same-file/nearby hits, which absorbs most of it.
const FAMILIES: Record<string, LangFamily> = {
  typescript: {
    include: '*.ts,*.tsx,*.js,*.jsx,*.mjs,*.cjs',
    pattern: (w) =>
      `(function\\s+${w}\\b|(class|interface|enum)\\s+${w}\\b|type\\s+${w}\\s*[<=]|` +
      `(const|let|var)\\s+${w}\\s*[=:(]|${w}\\s*=\\s*(async\\s*)?\\(|${w}\\s*\\([^)]*\\)\\s*(:[^{;]+)?\\{)`,
  },
  python: {
    include: '*.py',
    pattern: (w) => `(def|class)\\s+${w}\\b|${w}\\s*=`,
  },
  go: {
    include: '*.go',
    pattern: (w) => `(func\\s+(\\([^)]*\\)\\s*)?${w}\\s*\\(|type\\s+${w}\\b)`,
  },
  rust: {
    include: '*.rs',
    pattern: (w) => `((fn|struct|enum|trait|mod|type|const|static)\\s+${w}\\b|macro_rules!\\s*${w}\\b)`,
  },
  c: {
    include: '*.c,*.h',
    pattern: (w) => `((struct|enum|union)\\s+${w}\\b|#define\\s+${w}\\b|^[A-Za-z_][^=;]*\\b${w}\\s*\\()`,
  },
  cpp: {
    include: '*.cpp,*.cc,*.cxx,*.hpp,*.hh,*.h',
    pattern: (w) => `((class|struct|enum|union)\\s+${w}\\b|#define\\s+${w}\\b|^[A-Za-z_][^=;]*\\b${w}\\s*\\()`,
  },
  java: {
    include: '*.java',
    pattern: (w) => `((class|interface|enum|record)\\s+${w}\\b|[\\w<>\\[\\]]\\s+${w}\\s*\\([^)]*\\)\\s*\\{)`,
  },
  csharp: {
    include: '*.cs',
    pattern: (w) => `((class|interface|enum|struct|record|delegate)\\s+${w}\\b|[\\w<>\\[\\]]\\s+${w}\\s*\\([^)]*\\)\\s*\\{)`,
  },
  php: {
    include: '*.php,*.phtml',
    pattern: (w) => `((function\\s+${w}\\b)|((class|trait|interface)\\s+${w}\\b)|(const\\s+${w}\\b))`,
  },
  ruby: {
    include: '*.rb,Gemfile,Rakefile,*.gemspec,*.rake',
    pattern: (w) => `(def\\s+(self\\.)?${w}\\b|(class|module)\\s+${w}\\b)`,
  },
  swift: {
    include: '*.swift',
    pattern: (w) => `(func|class|struct|enum|protocol|extension|typealias|var|let)\\s+${w}\\b`,
  },
  shell: {
    include: '*.sh,*.bash,*.zsh',
    pattern: (w) => `(function\\s+${w}\\b|${w}\\s*\\(\\)\\s*\\{)`,
  },
  powershell: {
    include: '*.ps1,*.psm1',
    pattern: (w) => `function\\s+(\\w+:)?${w}\\b`,
    caseSensitive: false,
  },
  dart: {
    include: '*.dart',
    pattern: (w) => `((class|enum|mixin|typedef)\\s+${w}\\b|[\\w<>\\[\\]]\\s+${w}\\s*\\([^)]*\\)\\s*(async\\s*)?\\{)`,
  },
  kotlin: {
    include: '*.kt,*.kts',
    pattern: (w) => `(fun|class|object|interface|val|var|typealias)\\s+${w}\\b`,
  },
  lua: {
    include: '*.lua',
    pattern: (w) => `(function\\s+([\\w.:]+[.:])?${w}\\s*\\(|local\\s+(function\\s+)?${w}\\b)`,
  },
  sql: {
    include: '*.sql',
    pattern: (w) => `create\\s+(or\\s+replace\\s+)?(function|procedure|view|table|trigger|index)\\s+\\S*${w}`,
    caseSensitive: false,
  },
};
// javascript shares the typescript family.
FAMILIES.javascript = FAMILIES.typescript;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Document symbols (⌘⇧O "Go to Symbol") ───────────────────────────
// Line-scan patterns per language: each regex has exactly ONE capture
// group — the symbol name. Registered as a DocumentSymbolProvider, which
// lights up Monaco's built-in quick-outline picker.
type SymbolDef = { re: RegExp; kind: monaco.languages.SymbolKind };
const K = () => monaco.languages.SymbolKind;

// Names that look like definitions to the `name(args) {` heuristics but
// are control flow / calls.
const METHOD_BLACKLIST = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try',
  'new', 'typeof', 'await', 'function', 'sizeof', 'foreach', 'lock', 'using',
]);

function symbolDefs(): Record<string, SymbolDef[]> {
  const k = K();
  const tsjs: SymbolDef[] = [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: k.Function },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: k.Class },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: k.Interface },
    { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: k.Enum },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: k.Struct },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: k.Variable },
    { re: /^\s+(?:(?:public|private|protected|static|readonly|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]+)?\{\s*$/, kind: k.Method },
  ];
  const classyMethod: SymbolDef[] = [
    { re: /^\s*(?:[\w.[\]<>,?\s]+\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{\s*$/, kind: k.Method },
  ];
  return {
    typescript: tsjs,
    javascript: tsjs,
    python: [
      { re: /^\s*def\s+(\w+)/, kind: k.Function },
      { re: /^\s*class\s+(\w+)/, kind: k.Class },
    ],
    go: [
      { re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: k.Function },
      { re: /^type\s+(\w+)\s+struct\b/, kind: k.Struct },
      { re: /^type\s+(\w+)\s+interface\b/, kind: k.Interface },
      { re: /^type\s+(\w+)/, kind: k.Struct },
    ],
    rust: [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+(\w+)/, kind: k.Function },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: k.Struct },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: k.Enum },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: k.Interface },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, kind: k.Module },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)/, kind: k.Constant },
    ],
    c: [
      { re: /^#define\s+(\w+)/, kind: k.Constant },
      { re: /^\s*(?:typedef\s+)?(?:struct|enum|union)\s+(\w+)/, kind: k.Struct },
      { re: /^[A-Za-z_][\w*\s]*[\s*]([A-Za-z_]\w*)\s*\([^;]*$/, kind: k.Function },
    ],
    cpp: [
      { re: /^#define\s+(\w+)/, kind: k.Constant },
      { re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|enum|union)\s+(\w+)/, kind: k.Class },
      { re: /^[A-Za-z_][\w:<>,*&\s]*[\s*&]([A-Za-z_]\w*)\s*\([^;]*$/, kind: k.Function },
    ],
    java: [
      { re: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*(?:class|interface|enum|record)\s+(\w+)/, kind: k.Class },
      ...classyMethod,
    ],
    csharp: [
      { re: /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|enum|struct|record)\s+(\w+)/, kind: k.Class },
      ...classyMethod,
    ],
    php: [
      { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)/, kind: k.Function },
      { re: /^\s*(?:abstract\s+|final\s+)?(?:class|trait|interface)\s+(\w+)/, kind: k.Class },
    ],
    ruby: [
      { re: /^\s*def\s+(?:self\.)?(\w+)/, kind: k.Method },
      { re: /^\s*(?:class|module)\s+(\w+)/, kind: k.Class },
    ],
    swift: [
      { re: /^\s*(?:(?:public|private|internal|open|static|final)\s+)*func\s+(\w+)/, kind: k.Function },
      { re: /^\s*(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|enum|protocol|extension)\s+(\w+)/, kind: k.Class },
      { re: /^\s*typealias\s+(\w+)/, kind: k.Struct },
    ],
    shell: [
      { re: /^\s*function\s+(\w+)/, kind: k.Function },
      { re: /^\s*(\w+)\s*\(\)\s*\{/, kind: k.Function },
    ],
    powershell: [
      { re: /^\s*function\s+(?:\w+:)?([\w-]+)/i, kind: k.Function },
    ],
    dart: [
      { re: /^\s*(?:abstract\s+)?(?:class|enum|mixin)\s+(\w+)/, kind: k.Class },
      { re: /^\s*typedef\s+(\w+)/, kind: k.Struct },
      ...classyMethod,
    ],
    kotlin: [
      { re: /^\s*(?:(?:public|private|internal|open|override|suspend)\s+)*fun\s+(?:<[^>]*>\s*)?(\w+)/, kind: k.Function },
      { re: /^\s*(?:(?:public|private|internal|open|sealed|data|abstract)\s+)*(?:class|object|interface)\s+(\w+)/, kind: k.Class },
    ],
    lua: [
      { re: /^\s*(?:local\s+)?function\s+(?:[\w.:]+[.:])?(\w+)/, kind: k.Function },
    ],
    sql: [
      { re: /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure|view|table|trigger|index)\s+(?:if\s+not\s+exists\s+)?["'`[]?([\w.]+)/i, kind: k.Function },
    ],
  };
}

const SYMBOL_SCAN_MAX_LINES = 20000;

function scanDocumentSymbols(model: monaco.editor.ITextModel, defs: SymbolDef[]): monaco.languages.DocumentSymbol[] {
  const out: monaco.languages.DocumentSymbol[] = [];
  const lineCount = Math.min(model.getLineCount(), SYMBOL_SCAN_MAX_LINES);
  for (let ln = 1; ln <= lineCount; ln++) {
    const text = model.getLineContent(ln);
    if (!text || text.length > 500) continue;
    for (const d of defs) {
      const m = d.re.exec(text);
      if (!m || !m[1]) continue;
      const name = m[1];
      if (d.kind === K().Method && METHOD_BLACKLIST.has(name)) continue;
      const col = text.indexOf(name) + 1;
      const range = new monaco.Range(ln, 1, ln, text.length + 1);
      const selectionRange = new monaco.Range(ln, col, ln, col + name.length);
      out.push({
        name,
        detail: '',
        kind: d.kind,
        tags: [],
        range,
        selectionRange,
        children: [],
      });
      break; // one symbol per line is enough
    }
    if (out.length >= 5000) break;
  }
  return out;
}

/** rg pattern for the workspace symbol search (⌘P then '#name'):
 * any definition-introducing keyword followed by an identifier that
 * STARTS WITH the query. Cross-language by design — the picker shows
 * the file, so ambiguity is cheap. */
export function workspaceSymbolPattern(query: string): string {
  const q = escapeRegex(query);
  return `\\b(function|def|fn|func|class|struct|enum|interface|trait|type|module|impl|protocol|object|mixin|record|macro_rules!)\\s+(?:self\\.)?(${q}\\w*)`;
}

// Tiny result cache so cmd-hover (which probes the provider repeatedly
// while the key is held) doesn't launch an rg run per mouse move.
const cache = new Map<string, { ts: number; loc: monaco.languages.Location | null }>();
const CACHE_TTL_MS = 5000;

async function findDefinition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Promise<monaco.languages.Location | null> {
  const root = searchRoot;
  if (!root) return null;
  const family = FAMILIES[model.getLanguageId()];
  if (!family) return null;
  const wordInfo = model.getWordAtPosition(position);
  if (!wordInfo || wordInfo.word.length < 2) return null;
  const word = wordInfo.word;

  const cacheKey = `${root}\0${model.getLanguageId()}\0${word}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.loc;

  const res = await window.api.searchInFiles(root, family.pattern(escapeRegex(word)), {
    regex: true,
    caseSensitive: family.caseSensitive !== false,
    include: family.include,
  });

  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const currentPath = model.uri.path.replace(/\\/g, '/');
  let best: (typeof res.matches)[number] | null = null;
  let bestScore = -1;
  for (const m of res.matches ?? []) {
    const abs = `${rootPosix}/${m.path}`;
    // The definition the cursor is already ON isn't a jump target.
    if (abs === currentPath && m.lineNumber === position.lineNumber) continue;
    // Rank: same file, then same directory, then anywhere.
    const score = abs === currentPath ? 2 : abs.slice(0, abs.lastIndexOf('/')) === currentPath.slice(0, currentPath.lastIndexOf('/')) ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = m;
      if (score === 2) break;
    }
  }
  let loc: monaco.languages.Location | null = null;
  if (best) {
    // Point the range at the identifier itself, not the keyword that
    // introduced it, so the caret lands on the name.
    const col0 = best.line.indexOf(word, best.matchStart);
    const column = (col0 >= 0 ? col0 : best.matchStart) + 1;
    loc = {
      uri: monaco.Uri.file(`${rootPosix}/${best.path}`),
      range: new monaco.Range(best.lineNumber, column, best.lineNumber, column + word.length),
    };
  }
  cache.set(cacheKey, { ts: Date.now(), loc });
  return loc;
}

let registered = false;

/** Idempotent global registration — providers and the opener attach to
 * Monaco itself, so every editor instance (plain, diff, merge) gets
 * cmd+click for free. Imported for side effect by MonacoFileEditor. */
export function ensureDefinitionSupport(): void {
  if (registered) return;
  registered = true;

  for (const languageId of Object.keys(FAMILIES)) {
    monaco.languages.registerDefinitionProvider(languageId, {
      async provideDefinition(model, position) {
        try {
          return await findDefinition(model, position);
        } catch {
          return null;
        }
      },
    });
  }

  // ⌘⇧O "Go to Symbol in file" — a DocumentSymbolProvider makes
  // Monaco's built-in quick-outline picker work.
  const SYMBOLS = symbolDefs();
  for (const [languageId, defs] of Object.entries(SYMBOLS)) {
    monaco.languages.registerDocumentSymbolProvider(languageId, {
      provideDocumentSymbols(model) {
        try {
          return scanDocumentSymbols(model, defs);
        } catch {
          return [];
        }
      },
    });
  }

  // ⇧F12 "Find All References" — rather than fight Monaco's peek widget
  // (it needs loaded models for previews), route the symbol into Vyb's
  // Search panel pre-filled as a whole-word query. App.tsx listens.
  monaco.editor.addEditorAction({
    id: 'vyb.findAllReferences',
    label: 'Find All References',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.6,
    run(ed) {
      const model = ed.getModel();
      const pos = ed.getPosition();
      if (!model || !pos) return;
      const w = model.getWordAtPosition(pos);
      if (!w) return;
      window.dispatchEvent(new CustomEvent('vyb-find-references', { detail: { query: w.word } }));
    },
  });

  // Cross-file targets have no model in the standalone editor, so
  // Monaco delegates to this opener. Route to the host app, which opens
  // the file in a tab and reveals the line (same path as a
  // Find-in-Files result click).
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false;
      let line = 1;
      if (selectionOrPosition) {
        line = 'startLineNumber' in selectionOrPosition
          ? selectionOrPosition.startLineNumber
          : selectionOrPosition.lineNumber;
      }
      const detail: OpenDefinitionDetail = { path: resource.fsPath, line };
      window.dispatchEvent(new CustomEvent('vyb-open-definition', { detail }));
      return true;
    },
  });
}
