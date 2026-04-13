/**
 * Tiny file icons inspired by VS Code's Seti theme.
 * Each icon is a 16x16 SVG rendered inline.
 */

interface IconDef {
  color: string;
  path: string;
}

// Base file icon (generic document)
const FILE: IconDef = {
  color: '#8b949e',
  path: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v3.5H12',
};

// Folder icons
const FOLDER: IconDef = {
  color: '#8b949e',
  path: 'M1.5 3A1.5 1.5 0 013 1.5h3.3l1.2 1.5H13a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z',
};

const FOLDER_OPEN: IconDef = {
  color: '#c09553',
  path: 'M1.5 3A1.5 1.5 0 013 1.5h3.3l1.2 1.5H13a1.5 1.5 0 011.5 1.5v1H3.5L1 12.5V3zm0 10.5L3.5 7h12L13 13.5H3a1.5 1.5 0 01-1.5-1.5v1z',
};

// Language/file type icons
const ICONS: Record<string, IconDef> = {
  // JavaScript
  js: { color: '#e6cd69', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm4.5 9.5c0 .5.4.8 1 .8s.9-.2.9-.6c0-.9-1.8-.7-1.8-2 0-.6.5-1 1.2-1 .6 0 1.1.3 1.2.8h-.7c0-.3-.2-.4-.5-.4s-.5.2-.5.4c0 .8 1.8.6 1.8 2 0 .7-.5 1.1-1.3 1.1-.8 0-1.3-.4-1.3-1.1zm-2 .1V8.5h.8v3c0 .3.2.5.5.5s.5-.2.5-.6V8.5h.8v3.1c0 .8-.5 1.2-1.3 1.2s-1.3-.4-1.3-1.2z' },
  jsx: { color: '#00d8ff', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm5 4a2 2 0 100 4 2 2 0 000-4zm-3.5 2c0-.3.5-1.2 1.5-1.8-.2-.7-.3-1.3-.2-1.7.2-.7.6-.7.8-.7.4 0 .7.3 1.1 1 .4-.7.7-1 1.1-1 .2 0 .6 0 .8.7.1.4 0 1-.2 1.7 1 .6 1.5 1.5 1.5 1.8s-.5 1.2-1.5 1.8c.2.7.3 1.3.2 1.7-.2.7-.6.7-.8.7-.4 0-.7-.3-1.1-1-.4.7-.7 1-1.1 1-.2 0-.6 0-.8-.7-.1-.4 0-1 .2-1.7-1-.6-1.5-1.5-1.5-1.8z' },
  // TypeScript
  ts: { color: '#3178c6', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm2.5 7v-.7h3v.7H7.3v3.2h-.8V9zm3.3 2.5v.7c.3.2.7.3 1.1.3.5 0 .9-.1 1.1-.4.3-.2.4-.6.4-1v-2.6h-.8v2.5c0 .3 0 .5-.2.6-.1.2-.3.2-.5.2s-.4 0-.5-.1l-.3-.1-.3-.1z' },
  tsx: { color: '#3178c6', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm5 4a2 2 0 100 4 2 2 0 000-4zm-3.5 2c0-.3.5-1.2 1.5-1.8-.2-.7-.3-1.3-.2-1.7.2-.7.6-.7.8-.7.4 0 .7.3 1.1 1 .4-.7.7-1 1.1-1 .2 0 .6 0 .8.7.1.4 0 1-.2 1.7 1 .6 1.5 1.5 1.5 1.8s-.5 1.2-1.5 1.8c.2.7.3 1.3.2 1.7-.2.7-.6.7-.8.7-.4 0-.7-.3-1.1-1-.4.7-.7 1-1.1 1-.2 0-.6 0-.8-.7-.1-.4 0-1 .2-1.7-1-.6-1.5-1.5-1.5-1.8z' },
  // JSON
  json: { color: '#e6cd69', path: 'M5.5 2.5c-1.4 0-2 .8-2 2v1.8c0 .8-.4 1.2-1 1.7.6.5 1 .9 1 1.7v1.8c0 1.2.6 2 2 2m5-11c1.4 0 2 .8 2 2v1.8c0 .8.4 1.2 1 1.7-.6.5-1 .9-1 1.7v1.8c0 1.2-.6 2-2 2' },
  // HTML
  html: { color: '#e34c26', path: 'M3 2l1 11.5L8 15l4-1.5L13 2H3zm8.5 3.5H6l.2 1.5h5.1l-.4 4.5L8 12.5l-2.9-1L4.9 9h1.5l.1 1.2 1.5.5 1.5-.5.2-1.7H5.3L4.8 4h6.4l-.2 1.5z' },
  htm: { color: '#e34c26', path: 'M3 2l1 11.5L8 15l4-1.5L13 2H3zm8.5 3.5H6l.2 1.5h5.1l-.4 4.5L8 12.5l-2.9-1L4.9 9h1.5l.1 1.2 1.5.5 1.5-.5.2-1.7H5.3L4.8 4h6.4l-.2 1.5z' },
  // CSS
  css: { color: '#563d7c', path: 'M3 2l1 11.5L8 15l4-1.5L13 2H3zm8.2 3.5l-.1 1.5H7.2l.1 1.3h3.6l-.3 3.7-2.6.9-2.6-.9-.2-1.8h1.4l.1.9 1.3.4 1.3-.4.1-1.6H5.8L5.5 5.5h5.7z' },
  scss: { color: '#cd6799', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm5 3c-2 0-3.2 1-3 2.3.2 1.5 2.2 1.7 3 2.2.5.3.5.8.3 1.1-.3.3-.9.4-1.5.1-.6-.2-.8-.7-.8-.7l-1.2.6s.3.8 1 1.1c.8.4 2 .4 2.8-.1.8-.5 1-1.5.6-2.3-.4-.7-1.2-1-2-1.3-.6-.2-1.2-.4-1.2-.9 0-.4.5-.7 1.1-.6.5 0 .8.3.9.6l1.1-.5C9 5.6 8.3 5 8 5z' },
  less: { color: '#563d7c', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm2 6.5h2v1H5v-1zm0-2h2v1H5v-1zm4 0h2v1H9v-1zm0 2h2v1H9v-1z' },
  // Python
  py: { color: '#4584b6', path: 'M8 2c-3 0-2.8 1.3-2.8 1.3v1.4H8.3v.4H4c0 0-2 -.2-2 2.8S4 10.7 4 10.7h1.2V9.2s-.1-1.5 1.5-1.5h2.5s1.4 0 1.4-1.4V4.2S10.9 2 8 2zm-1.5 1.2a.5.5 0 110 1 .5.5 0 010-1zM8 14c3 0 2.8-1.3 2.8-1.3v-1.4H7.7v-.4H12s2 .2 2-2.8-2-2.8-2-2.8h-1.2v1.5s.1 1.5-1.5 1.5H6.8s-1.4 0-1.4 1.4v2.1S5.1 14 8 14zm1.5-1.2a.5.5 0 110-1 .5.5 0 010 1z' },
  // Markdown
  md: { color: '#755838', path: 'M2 3.5h12a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H2a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5zM4 10V6l1.5 2L7 6v4h1.5V6.5L10 9l2-2.5v.5h1V6h-1l-2 2.5L8 6H6.5l-1 1.3L4.5 6H3v4h1z' },
  mdx: { color: '#755838', path: 'M2 3.5h12a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H2a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5zM4 10V6l1.5 2L7 6v4h1.5V6.5L10 9l2-2.5v.5h1V6h-1l-2 2.5L8 6H6.5l-1 1.3L4.5 6H3v4h1z' },
  // Config files
  yaml: { color: '#cb171e', path: 'M3 3l2.5 4v5h1V7L9 3h-1L6 6.5 4 3H3zm6 0l2 3.5L13 3h-1l-1 1.8L10 3H9z' },
  yml: { color: '#cb171e', path: 'M3 3l2.5 4v5h1V7L9 3h-1L6 6.5 4 3H3zm6 0l2 3.5L13 3h-1l-1 1.8L10 3H9z' },
  toml: { color: '#8b949e', path: 'M4 3h8v1.5H9V13H7V4.5H4V3z' },
  ini: { color: '#8b949e', path: 'M4 3h8v1.5H9V13H7V4.5H4V3z' },
  env: { color: '#e6cd69', path: 'M4 4h8a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zm1.5 2v1h3V6h-3zm0 2v1h2V8h-2z' },
  // Shell
  sh: { color: '#4eaa25', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm2 3l3 2.5L5 10m4 0h3' },
  bash: { color: '#4eaa25', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm2 3l3 2.5L5 10m4 0h3' },
  zsh: { color: '#4eaa25', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm2 3l3 2.5L5 10m4 0h3' },
  // Images
  png: { color: '#a074c4', path: 'M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm2 6l2-2 1.5 1.5L11 6v5H5V9zm1-3a1 1 0 100 2 1 1 0 000-2z' },
  jpg: { color: '#a074c4', path: 'M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm2 6l2-2 1.5 1.5L11 6v5H5V9zm1-3a1 1 0 100 2 1 1 0 000-2z' },
  jpeg: { color: '#a074c4', path: 'M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm2 6l2-2 1.5 1.5L11 6v5H5V9zm1-3a1 1 0 100 2 1 1 0 000-2z' },
  gif: { color: '#a074c4', path: 'M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm2 6l2-2 1.5 1.5L11 6v5H5V9zm1-3a1 1 0 100 2 1 1 0 000-2z' },
  webp: { color: '#a074c4', path: 'M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm2 6l2-2 1.5 1.5L11 6v5H5V9zm1-3a1 1 0 100 2 1 1 0 000-2z' },
  svg: { color: '#e34c26', path: 'M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm2 6l2-2 1.5 1.5L11 6v5H5V9zm1-3a1 1 0 100 2 1 1 0 000-2z' },
  ico: { color: '#a074c4', path: 'M3 3h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V4a1 1 0 011-1zm2 6l2-2 1.5 1.5L11 6v5H5V9zm1-3a1 1 0 100 2 1 1 0 000-2z' },
  // Git
  gitignore: { color: '#e34c26', path: 'M8 1a7 7 0 100 14A7 7 0 008 1zM4.5 7.5h7v1h-7v-1z' },
  // Package managers
  lock: { color: '#8b949e', path: 'M5.5 7V5a2.5 2.5 0 015 0v2h.5a1 1 0 011 1v5a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1h1.5zm1 0h3V5a1.5 1.5 0 00-3 0v2zM8 10a1 1 0 100 2 1 1 0 000-2z' },
  // Rust
  rs: { color: '#ce422b', path: 'M8 2a6 6 0 100 12A6 6 0 008 2zM6 6.5h1.5V5.5a.5.5 0 011 0v1H10a.5.5 0 010 1H8.5v1H10a.5.5 0 010 1H8.5v1a.5.5 0 01-1 0v-1H6a.5.5 0 010-1h1.5v-1H6a.5.5 0 010-1z' },
  // Go
  go: { color: '#00acd7', path: 'M2.5 7c0-.5.2-.9.5-1l4-2a1 1 0 011 0l4 2c.3.1.5.5.5 1v3c0 .5-.2.9-.5 1l-4 2a1 1 0 01-1 0l-4-2c-.3-.1-.5-.5-.5-1V7z' },
  // Ruby
  rb: { color: '#cc342d', path: 'M3 11l1.5-8h1L7 7l1.5-4h1L11 11h-1.5L8.5 7.5 8 9l-.5-1.5L6.5 11H5l2-5-.5-1.5L4.5 11H3z' },
  // Java / Kotlin
  java: { color: '#e76f00', path: 'M5.8 9.8s-.5.3.3.4c1 .1 1.5.1 2.6-.2 0 0 .3.2.7.3-2.5 1.1-5.6-.1-3.6-.5zm-.3-1.1s-.5.4.3.5c1 .1 2 .1 3.3-.3 0 0 .2.2.5.4-3 .9-6.2 0-4.1-.6zm3.2-3.2c.6.7-.2 1.4-.2 1.4s1.6-.8.9-1.8c-.7-.9-1.2-1.4 1.6-3 0 0-4.4 1.1-2.3 3.4z' },
  kt: { color: '#7f52ff', path: 'M3 3h10v10H3V3zm1.5 1.5v7L8 8l3.5-3.5H4.5zm0 7h7L8 8l-3.5 3.5z' },
  // C / C++
  c: { color: '#005697', path: 'M8 2a6 6 0 100 12A6 6 0 008 2zm1.5 3c1.2 0 2.2.7 2.7 1.7l-1.3.7c-.3-.6-.8-.9-1.4-.9-1 0-1.7.8-1.7 1.8s.7 1.7 1.7 1.7c.6 0 1.1-.3 1.4-.9l1.3.7c-.5 1-1.5 1.7-2.7 1.7-1.8 0-3.2-1.3-3.2-3.2S7.7 5 9.5 5z' },
  cpp: { color: '#005697', path: 'M8 2a6 6 0 100 12A6 6 0 008 2zm.5 3c1 0 1.8.5 2.2 1.3l-1 .6c-.2-.4-.6-.7-1.2-.7-.8 0-1.4.6-1.4 1.5s.6 1.5 1.4 1.5c.5 0 1-.3 1.2-.7l1 .6c-.4.8-1.2 1.3-2.2 1.3-1.5 0-2.6-1.1-2.6-2.7S7 5 8.5 5zm3 2h.7v.7h.6V7h.7v.7h-.7v.7h-.6v-.7H11.5V7z' },
  h: { color: '#005697', path: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm1.5 5v6h1V9.5h3V11h1V6h-1v2.5h-3V6h-1z' },
  // Dockerfile
  dockerfile: { color: '#2496ed', path: 'M1 8.5h2.5V6.5H6V4.5h2.5v2H11v2h2.5a3 3 0 01-1 2.3c-.7.5-1.5.7-2.5.7-2 0-3.8-1-4.8-2.5H1zm3-3h1.5v1.5H4V5.5zm2 0h1.5v1.5H6V5.5zm0-2h1.5V5H6V3.5zm2 2h1.5v1.5H8V5.5zm2 0h1.5v1.5H10V5.5zm-6 2h1.5V9H4V7.5zm2 0h1.5V9H6V7.5zm2 0h1.5V9H8V7.5z' },
  // XML
  xml: { color: '#e34c26', path: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm1 7l2 2-2 2 .7.7L8 10.5l-2.3-2.2L5 9zm6 4l-2-2 2-2-.7-.7L8 10.5l2.3 2.2.7-.7z' },
  // SQL
  sql: { color: '#e6cd69', path: 'M8 2C5 2 3 3 3 4.5v7C3 13 5 14 8 14s5-1 5-2.5v-7C13 3 11 2 8 2zm0 1.5c2.2 0 3.5.6 3.5 1s-1.3 1-3.5 1S4.5 5 4.5 4.5 5.8 3.5 8 3.5z' },
  // PDF
  pdf: { color: '#e34c26', path: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm4.5 0v3.5H12M5 9h1c.6 0 1-.4 1-1s-.4-1-1-1H5v4m3-4h1.2c.5 0 .8.5.8 1v1c0 .5-.3 1-.8 1H8m3-3h1.5M11 9.5h1m-1 1.5h1.5' },
  // Zip
  zip: { color: '#8b949e', path: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm3 1h1v1H7V2zm0 2h1v1H7V4zm0 2h1v1H7V6zm0 2h1v1H7V8zm-.5 2h2v2.5l-1 .5-1-.5V10z' },
  gz: { color: '#8b949e', path: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm3 1h1v1H7V2zm0 2h1v1H7V4zm0 2h1v1H7V6zm0 2h1v1H7V8zm-.5 2h2v2.5l-1 .5-1-.5V10z' },
  tar: { color: '#8b949e', path: 'M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1zm3 1h1v1H7V2zm0 2h1v1H7V4zm0 2h1v1H7V6zm0 2h1v1H7V8zm-.5 2h2v2.5l-1 .5-1-.5V10z' },
};

// Special filename matches (case-insensitive)
const NAME_ICONS: Record<string, IconDef> = {
  'package.json': { color: '#4eaa25', path: 'M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm4.5 9.5c0 .5.4.8 1 .8s.9-.2.9-.6c0-.9-1.8-.7-1.8-2 0-.6.5-1 1.2-1 .6 0 1.1.3 1.2.8h-.7c0-.3-.2-.4-.5-.4s-.5.2-.5.4c0 .8 1.8.6 1.8 2 0 .7-.5 1.1-1.3 1.1-.8 0-1.3-.4-1.3-1.1zm-2 .1V8.5h.8v3c0 .3.2.5.5.5s.5-.2.5-.6V8.5h.8v3.1c0 .8-.5 1.2-1.3 1.2s-1.3-.4-1.3-1.2z' },
  'tsconfig.json': { color: '#3178c6', path: 'M5.5 2.5c-1.4 0-2 .8-2 2v1.8c0 .8-.4 1.2-1 1.7.6.5 1 .9 1 1.7v1.8c0 1.2.6 2 2 2m5-11c1.4 0 2 .8 2 2v1.8c0 .8.4 1.2 1 1.7-.6.5-1 .9-1 1.7v1.8c0 1.2-.6 2-2 2' },
  '.eslintrc.json': { color: '#4b32c3', path: 'M5.5 2.5c-1.4 0-2 .8-2 2v1.8c0 .8-.4 1.2-1 1.7.6.5 1 .9 1 1.7v1.8c0 1.2.6 2 2 2m5-11c1.4 0 2 .8 2 2v1.8c0 .8.4 1.2 1 1.7-.6.5-1 .9-1 1.7v1.8c0 1.2-.6 2-2 2' },
  '.gitignore': ICONS.gitignore,
  'dockerfile': ICONS.dockerfile,
  'license': { color: '#e6cd69', path: 'M8 1a7 7 0 100 14A7 7 0 008 1zm0 2a2 2 0 110 4 2 2 0 010-4zm0 10c-1.7 0-3.2-.8-4-2 .02-1.3 2.7-2 4-2s3.98.7 4 2c-.8 1.2-2.3 2-4 2z' },
  'readme.md': { color: '#3178c6', path: 'M2 3.5h12a.5.5 0 01.5.5v8a.5.5 0 01-.5.5H2a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5zM4 10V6l1.5 2L7 6v4h1.5V6.5L10 9l2-2.5v.5h1V6h-1l-2 2.5L8 6H6.5l-1 1.3L4.5 6H3v4h1z' },
};

function getIconForFile(filename: string): IconDef {
  const lower = filename.toLowerCase();

  // Check exact filename matches
  const nameIcon = NAME_ICONS[lower];
  if (nameIcon) return nameIcon;

  // Check if filename ends with .lock
  if (lower.endsWith('.lock') || lower === 'package-lock.json') return ICONS.lock;

  // Check extension
  const ext = lower.split('.').pop() || '';
  return ICONS[ext] || FILE;
}

export function FileIcon({ filename, isDirectory, isExpanded }: {
  filename: string;
  isDirectory: boolean;
  isExpanded?: boolean;
}) {
  const icon = isDirectory
    ? (isExpanded ? FOLDER_OPEN : FOLDER)
    : getIconForFile(filename);

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill={icon.color}
      style={{ flexShrink: 0, marginRight: 5 }}
    >
      <path d={icon.path} fillRule="evenodd" />
    </svg>
  );
}
