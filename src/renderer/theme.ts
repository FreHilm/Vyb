const BASE_HUE = 240;

interface PaletteEntry {
  name: string;
  h: number;
  s: number;
  l: number;
}

const PALETTE: PaletteEntry[] = [
  { name: 'base', h: 240, s: 21, l: 15 },
  { name: 'mantle', h: 240, s: 21, l: 12 },
  { name: 'crust', h: 240, s: 21, l: 9 },
  { name: 'surface0', h: 234, s: 13, l: 23 },
  { name: 'surface1', h: 233, s: 12, l: 31 },
  { name: 'surface2', h: 232, s: 10, l: 39 },
  { name: 'overlay0', h: 231, s: 11, l: 47 },
  { name: 'subtext0', h: 228, s: 24, l: 72 },
  { name: 'text', h: 227, s: 70, l: 88 },
  { name: 'blue', h: 217, s: 92, l: 76 },
  { name: 'sapphire', h: 189, s: 71, l: 73 },
  { name: 'red', h: 343, s: 81, l: 75 },
  { name: 'rosewater', h: 10, s: 56, l: 91 },
  { name: 'green', h: 115, s: 54, l: 76 },
  { name: 'yellow', h: 40, s: 86, l: 83 },
  { name: 'magenta', h: 316, s: 72, l: 86 },
  { name: 'cyan', h: 170, s: 57, l: 73 },
  { name: 'white', h: 227, s: 24, l: 80 },
];

function shiftHue(h: number, shift: number): number {
  return (((h + shift) % 360) + 360) % 360;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function find(name: string): PaletteEntry {
  return PALETTE.find((c) => c.name === name)!;
}

// baseHue 0-359 = chromatic, 360 = grayscale
function satFor(baseSat: number, baseHue: number): number {
  return baseHue >= 360 ? 0 : baseSat;
}

// darkness 0 = default, 100 = near-black. Scales lightness down.
function darken(l: number, darkness: number): number {
  const factor = 1 - darkness / 100;
  return l * factor;
}

// Background tones — these follow the user's `baseHue` setting (so the user
// can tint the whole UI). Their lightness is also affected by the darkness
// slider.
const BG_ENTRIES = new Set([
  'base', 'mantle', 'crust', 'surface0', 'surface1', 'surface2',
]);

// Neutral text/grays — kept on the white-to-black axis (saturation 0) at all
// times, regardless of baseHue, so changing the background tint never colors
// the text. Lightness is driven by the textLightness slider.
const TEXT_ENTRIES = new Set(['text', 'subtext0', 'overlay0', 'white']);

// All other palette names (blue / red / green / yellow / magenta / cyan /
// sapphire / rosewater) are accents — their hue + saturation are pinned to
// the original Catppuccin values regardless of baseHue, so the "selected"
// blue, status colors, syntax highlighting, etc. stay consistent across themes.

// textLightness 0 = white (100%), 100 = black (0%)
function textLight(_defaultL: number, textLightness: number): number {
  return 100 - textLightness;
}

/** Resolve the {h, s, l} for a palette entry given the user's hue/darkness/
 * textLightness settings, applying the per-category rules above. Shared
 * between the renderer CSS variable pass and the xterm.js terminal theme. */
function resolveHSL(
  c: PaletteEntry,
  baseHue: number,
  darkness: number,
  textLightness: number,
): { h: number; s: number; l: number } {
  if (BG_ENTRIES.has(c.name)) {
    const shift = baseHue >= 360 ? 0 : baseHue - BASE_HUE;
    return {
      h: shiftHue(c.h, shift),
      s: satFor(c.s, baseHue),
      l: darken(c.l, darkness),
    };
  }
  if (TEXT_ENTRIES.has(c.name)) {
    return {
      h: 0,
      s: 0,
      l: textLight(c.l, textLightness),
    };
  }
  // Accent — original Catppuccin tone, untouched by baseHue or darkness
  return { h: c.h, s: c.s, l: c.l };
}

export interface FlameSettings {
  intensity: number; // 0-100
  spread: number;    // 0-100
  length: number;    // 0-100
  speed: number;     // 0-100
}

export function applyTheme(
  baseHue: number,
  darkness: number,
  textLightness: number,
  profileFontSize: number,
  flame?: FlameSettings,
): void {
  const root = document.documentElement;

  for (const c of PALETTE) {
    const { h, s, l } = resolveHSL(c, baseHue, darkness, textLightness);
    root.style.setProperty(`--c-${c.name}`, `hsl(${h}, ${s}%, ${l}%)`);
  }

  // Selection with alpha — derived from surface2 (a background entry, so it
  // follows the hue shift like the rest of the chrome).
  const s2 = find('surface2');
  const s2res = resolveHSL(s2, baseHue, darkness, textLightness);
  root.style.setProperty(
    '--c-selection',
    `hsla(${s2res.h}, ${s2res.s}%, ${s2res.l}%, 0.4)`,
  );

  // Red with alpha for delete hover — accent, fixed Catppuccin red.
  const red = find('red');
  const redRes = resolveHSL(red, baseHue, darkness, textLightness);
  root.style.setProperty(
    '--c-red-dim',
    `hsla(${redRes.h}, ${redRes.s}%, ${redRes.l}%, 0.1)`,
  );

  root.style.setProperty('--profile-font-size', `${profileFontSize}px`);
  root.style.setProperty(
    '--profile-font-size-small',
    `${Math.round(profileFontSize * 0.846)}px`,
  );

  // Flame settings — map 0-100 sliders to CSS variable ranges
  if (flame) {
    // intensity 0→0.2, 50→1.0, 100→2.0
    const intensity = 0.2 + (flame.intensity / 100) * 1.8;
    // spread 0→0.2, 50→1.0, 100→2.5
    const spread = 0.2 + (flame.spread / 100) * 2.3;
    // length 0→6px, 50→24px, 100→60px
    const length = Math.round(6 + (flame.length / 100) * 54);
    // speed: 0→slow(3x duration), 50→normal(1x), 100→fast(0.15x)
    // Higher slider = faster, so invert: duration multiplier
    const speed = flame.speed <= 50
      ? 1 + (50 - flame.speed) / 50 * 2      // 50→1.0, 0→3.0
      : 1 - (flame.speed - 50) / 50 * 0.85;  // 50→1.0, 100→0.15
    root.style.setProperty('--flame-intensity', `${intensity}`);
    root.style.setProperty('--flame-spread', `${spread}`);
    root.style.setProperty('--flame-length', `${length}px`);
    root.style.setProperty('--flame-speed', `${speed}`);
  }
}

export function getTerminalTheme(baseHue: number, darkness: number, textLightness: number) {
  function hex(name: string): string {
    const c = find(name);
    const { h, s, l } = resolveHSL(c, baseHue, darkness, textLightness);
    return hslToHex(h, s, l);
  }

  return {
    background: hex('base'),
    foreground: hex('text'),
    cursor: hex('rosewater'),
    selectionBackground: hex('surface2') + '66',
    black: hex('surface1'),
    red: hex('red'),
    green: hex('green'),
    yellow: hex('yellow'),
    blue: hex('blue'),
    magenta: hex('magenta'),
    cyan: hex('cyan'),
    white: hex('white'),
    brightBlack: hex('surface2'),
    brightRed: hex('red'),
    brightGreen: hex('green'),
    brightYellow: hex('yellow'),
    brightBlue: hex('blue'),
    brightMagenta: hex('magenta'),
    brightCyan: hex('cyan'),
    brightWhite: hex('subtext0'),
  };
}

/** Same as `getTerminalTheme` but uses the deeper `crust` tone for the
 * background. Intended for shell terminals (which sit below the agent
 * terminal) so they read as visually nested / lower in the layer stack. */
export function getShellTerminalTheme(baseHue: number, darkness: number, textLightness: number) {
  const base = getTerminalTheme(baseHue, darkness, textLightness);
  const c = find('crust');
  const { h, s, l } = resolveHSL(c, baseHue, darkness, textLightness);
  return { ...base, background: hslToHex(h, s, l) };
}

export function hueToPreviewColor(hue: number, darkness: number): string {
  return hslToHex(
    hue >= 360 ? 0 : hue,
    hue >= 360 ? 0 : 21,
    darken(15, darkness),
  );
}
