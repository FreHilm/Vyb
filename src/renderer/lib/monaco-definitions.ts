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
