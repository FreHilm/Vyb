// Stroke-style 16x16 icons matching the app's outline icon set.
// Each entry is the inner SVG content (paths/lines/etc) — render inside a
// wrapper:
//   <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
//        stroke="currentColor" strokeWidth="1.5"
//        strokeLinecap="round" strokeLinejoin="round" />
// Use dangerouslySetInnerHTML to inject the markup, since icons may contain
// multiple shapes (rect, polyline, circle, …) not just a single path.
export const APP_ICONS: Record<string, string> = {
  vscode:
    '<polyline points="5.5 4.5 2 8 5.5 11.5"/><polyline points="10.5 4.5 14 8 10.5 11.5"/><line x1="9.5" y1="3" x2="6.5" y2="13"/>',
  code:
    '<polyline points="5.5 4.5 2 8 5.5 11.5"/><polyline points="10.5 4.5 14 8 10.5 11.5"/>',
  terminal:
    '<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><polyline points="4.5 7 6.5 9 4.5 11"/><line x1="8" y1="11" x2="11" y2="11"/>',
  gitBranch:
    '<circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4 5v1a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3V5"/><line x1="8" y1="9" x2="8" y2="11"/>',
  folder:
    '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z"/>',
  file:
    '<path d="M9 2H5A1.5 1.5 0 0 0 3.5 3.5v9A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V5.5L9 2Z"/><path d="M9 2v3.5h3.5"/>',
  globe:
    '<circle cx="8" cy="8" r="6.5"/><path d="M8 1.5C5.5 1.5 4 4.5 4 8s1.5 6.5 4 6.5S12 11.5 12 8 10.5 1.5 8 1.5Z"/><line x1="1.5" y1="8" x2="14.5" y2="8"/>',
  database:
    '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v5C2.5 9.6 4.9 10.5 8 10.5s5.5-.9 5.5-2v-5"/><path d="M2.5 8.5v4C2.5 13.6 4.9 14.5 8 14.5s5.5-.9 5.5-2v-4"/>',
  box:
    '<path d="M8 1.5 1.5 4.5v7L8 14.5l6.5-3v-7L8 1.5Z"/><path d="M1.5 4.5 8 7.5l6.5-3"/><line x1="8" y1="7.5" x2="8" y2="14.5"/>',
  settings:
    '<circle cx="8" cy="8" r="2.25"/><path d="M12.5 9.6a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 1 1-1.7 1.7l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6 1V13.5a1.2 1.2 0 0 1-2.4 0V13.4a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 1 1-1.7-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-1-.6H2.5a1.2 1.2 0 0 1 0-2.4H2.6a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 1 1 1.7-1.7l.1.1a1 1 0 0 0 1.1.2H6.4a1 1 0 0 0 .6-1V2.5a1.2 1.2 0 0 1 2.4 0V2.6a1 1 0 0 0 .6 1 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 1 1 1.7 1.7l-.1.1a1 1 0 0 0-.2 1.1V6.4a1 1 0 0 0 1 .6h.1a1.2 1.2 0 0 1 0 2.4H13.5a1 1 0 0 0-.9.6Z"/>',
  rocket:
    '<path d="M5.5 13.5 3.7 12c-.5-1.5-.2-3.2.8-4.5L8 3c1.5-2 4-2.5 4-2.5s-.5 2.5-2 4l-4.5 3.5c-1.3 1-3 1.3-4.5.8l-.5-.3"/><circle cx="9" cy="7" r="1"/><path d="M5.5 13.5C4 14 2.5 14 2.5 14s0-1.5.5-3"/>',
  hammer:
    '<path d="m13.8 2.2-3.4 3.4M11 5l-3-3M9.5 3.5 6 7l3 3 3.5-3.5"/><path d="m8 6.5-6 6a1 1 0 0 0 1.4 1.4l6-6"/>',
  play: '<polygon points="4 3 13 8 4 13"/>',
  heart:
    '<path d="M8 13.5s-5.5-3.3-5.5-7c0-2 1.5-3.5 3.5-3.5 1.2 0 2 .8 2 .8s.8-.8 2-.8c2 0 3.5 1.5 3.5 3.5 0 3.7-5.5 7-5.5 7Z"/>',
  star:
    '<polygon points="8 1.5 10 6 14.5 6.7 11.2 9.9 12 14.5 8 12.3 4 14.5 4.8 9.9 1.5 6.7 6 6"/>',
  zap: '<polygon points="9 1.5 3 9 7.5 9 7 14.5 13 7 8.5 7 9 1.5"/>',
  shield:
    '<path d="M8 1.5 2.5 4v4c0 4 2.5 6 5.5 7.5 3-1.5 5.5-3.5 5.5-7.5V4Z"/>',
  monitor:
    '<rect x="1.5" y="2.5" width="13" height="9" rx="1"/><line x1="5.5" y1="14" x2="10.5" y2="14"/><line x1="8" y1="11.5" x2="8" y2="14"/>',
  layers:
    '<polygon points="8 1.5 1.5 5 8 8.5 14.5 5"/><polyline points="1.5 8 8 11.5 14.5 8"/><polyline points="1.5 11 8 14.5 14.5 11"/>',
  compass:
    '<circle cx="8" cy="8" r="6.5"/><polygon points="10.5 5.5 9.3 9.3 5.5 10.5 6.7 6.7"/>',
  cpu:
    '<rect x="3.5" y="3.5" width="9" height="9" rx="1"/><rect x="6" y="6" width="4" height="4"/><line x1="6" y1="1.5" x2="6" y2="3.5"/><line x1="10" y1="1.5" x2="10" y2="3.5"/><line x1="6" y1="12.5" x2="6" y2="14.5"/><line x1="10" y1="12.5" x2="10" y2="14.5"/><line x1="1.5" y1="6" x2="3.5" y2="6"/><line x1="1.5" y1="10" x2="3.5" y2="10"/><line x1="12.5" y1="6" x2="14.5" y2="6"/><line x1="12.5" y1="10" x2="14.5" y2="10"/>',
  cloud:
    '<path d="M4.5 13.5h7a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6 1.5 3 3 0 0 0 2.3 5.5Z"/>',
  music:
    '<path d="M5 13V4l8-2v9"/><circle cx="3.5" cy="13" r="1.5"/><circle cx="11.5" cy="11" r="1.5"/>',
};

// Map icon name to display label
export const APP_ICON_LABELS: Record<string, string> = {
  vscode: 'VS Code',
  code: 'Code',
  terminal: 'Terminal',
  gitBranch: 'Git Branch',
  folder: 'Folder',
  file: 'File',
  globe: 'Globe',
  database: 'Database',
  box: 'Box',
  settings: 'Settings',
  rocket: 'Rocket',
  hammer: 'Hammer',
  play: 'Play',
  heart: 'Heart',
  star: 'Star',
  zap: 'Zap',
  shield: 'Shield',
  monitor: 'Monitor',
  layers: 'Layers',
  compass: 'Compass',
  cpu: 'CPU',
  cloud: 'Cloud',
  music: 'Music',
};
