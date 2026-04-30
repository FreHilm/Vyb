/**
 * File icons rendered as colored stroke outlines (single page shape, colored
 * by file type). Folders use a gray folder outline. Inspired by VS Code's
 * "modern outline" look — lighter and less busy than the filled Seti style.
 */

interface ColorDef {
  color: string;
  /** Optional extra path drawn inside the page outline (a tiny content mark). */
  detail?: string;
}

// Default file icon — neutral gray page
const DEFAULT: ColorDef = { color: '#7d8590' };

// Folder color — a slightly warm gray
const FOLDER_COLOR = '#8d9099';

// Page outline (stroke). Contains the page silhouette + corner fold.
const PAGE_OUTLINE = (
  <>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6L9 2Z" />
    <path d="M9 2v3.5h4" />
  </>
);

// Closed folder outline
const FOLDER_OUTLINE = (
  <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" />
);

// Open folder outline (looks slightly different)
const FOLDER_OPEN_OUTLINE = (
  <>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v1H2V4.5Z" />
    <path d="M2 7h12l-1.5 5.5a1.5 1.5 0 0 1-1.5 1H3.5A1.5 1.5 0 0 1 2 12V7Z" />
  </>
);

// Color per file type. Picked to roughly match the VS Code "modern" palette:
// red for markup, blue for TS/JS, yellow for JSON/YAML, green for shell/license,
// purple for images, cyan for stylesheets, etc.
const COLOR_MAP: Record<string, ColorDef> = {
  // TypeScript
  ts: { color: '#3b82f6' },
  tsx: { color: '#3b82f6' },
  // JavaScript
  js: { color: '#facc15' },
  jsx: { color: '#facc15' },
  mjs: { color: '#facc15' },
  cjs: { color: '#facc15' },
  // Web
  html: { color: '#f97316' },
  htm: { color: '#f97316' },
  css: { color: '#06b6d4' },
  scss: { color: '#ec4899' },
  sass: { color: '#ec4899' },
  less: { color: '#0ea5e9' },
  vue: { color: '#22c55e' },
  svelte: { color: '#f97316' },
  // Data / config
  json: { color: '#eab308' },
  yaml: { color: '#eab308' },
  yml: { color: '#eab308' },
  toml: { color: '#a16207' },
  xml: { color: '#fb923c' },
  // Markup
  md: { color: '#ef4444' },
  mdx: { color: '#ef4444' },
  // Languages
  py: { color: '#22c55e' },
  rs: { color: '#fb923c' },
  go: { color: '#06b6d4' },
  java: { color: '#ef4444' },
  rb: { color: '#dc2626' },
  php: { color: '#7c3aed' },
  swift: { color: '#fb923c' },
  c: { color: '#3b82f6' },
  cpp: { color: '#3b82f6' },
  h: { color: '#7c3aed' },
  hpp: { color: '#7c3aed' },
  // Shell
  sh: { color: '#22c55e' },
  zsh: { color: '#22c55e' },
  bash: { color: '#22c55e' },
  fish: { color: '#22c55e' },
  // Images
  png: { color: '#a855f7' },
  jpg: { color: '#a855f7' },
  jpeg: { color: '#a855f7' },
  gif: { color: '#a855f7' },
  svg: { color: '#eab308' },
  webp: { color: '#a855f7' },
  ico: { color: '#a855f7' },
  // Misc
  pdf: { color: '#ef4444' },
  zip: { color: '#a16207' },
  tar: { color: '#a16207' },
  gz: { color: '#a16207' },
  lock: { color: '#7d8590' },
  log: { color: '#7d8590' },
  txt: { color: '#9ca3af' },
  env: { color: '#facc15' },
  gitignore: { color: '#f97316' },
  npmrc: { color: '#dc2626' },
};

// Special filenames
const NAME_COLORS: Record<string, ColorDef> = {
  'package.json': { color: '#dc2626' },
  'package-lock.json': { color: '#7d8590' },
  'tsconfig.json': { color: '#3b82f6' },
  'dockerfile': { color: '#0ea5e9' },
  'readme.md': { color: '#ef4444' },
  'license': { color: '#22c55e' },
  'license.md': { color: '#22c55e' },
  'claude.md': { color: '#ef4444' },
  '.gitignore': { color: '#f97316' },
  '.env': { color: '#facc15' },
  '.env.local': { color: '#facc15' },
  '.env.production': { color: '#facc15' },
  '.npmrc': { color: '#dc2626' },
  '.eslintrc': { color: '#7c3aed' },
  '.eslintrc.js': { color: '#7c3aed' },
  '.eslintrc.json': { color: '#7c3aed' },
  '.prettierrc': { color: '#06b6d4' },
};

function getColorForFile(filename: string): ColorDef {
  const lower = filename.toLowerCase();

  const named = NAME_COLORS[lower];
  if (named) return named;

  if (lower.endsWith('.lock') || lower === 'package-lock.json') return COLOR_MAP.lock;

  const ext = lower.split('.').pop() || '';
  return COLOR_MAP[ext] || DEFAULT;
}

export function FileIcon({ filename, isDirectory, isExpanded }: {
  filename: string;
  isDirectory: boolean;
  isExpanded?: boolean;
}) {
  const color = isDirectory ? FOLDER_COLOR : getColorForFile(filename).color;
  const shape = isDirectory
    ? (isExpanded ? FOLDER_OPEN_OUTLINE : FOLDER_OUTLINE)
    : PAGE_OUTLINE;

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, marginRight: 5 }}
    >
      {shape}
    </svg>
  );
}
