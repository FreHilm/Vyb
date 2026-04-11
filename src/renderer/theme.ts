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

// Text entries whose lightness is controlled by the textLightness slider
const TEXT_ENTRIES = new Set(['text', 'subtext0', 'overlay0', 'white']);

// textLightness 0 = white (100%), 100 = black (0%)
function textLight(_defaultL: number, textLightness: number): number {
  return 100 - textLightness;
}

export function applyTheme(
  baseHue: number,
  darkness: number,
  textLightness: number,
  profileFontSize: number,
): void {
  const shift = baseHue >= 360 ? 0 : baseHue - BASE_HUE;
  const root = document.documentElement;

  for (const c of PALETTE) {
    const h = shiftHue(c.h, shift);
    const s = satFor(c.s, baseHue);
    let l = darken(c.l, darkness);
    if (TEXT_ENTRIES.has(c.name)) {
      l = textLight(l > 0 ? l : c.l, textLightness);
    }
    root.style.setProperty(`--c-${c.name}`, `hsl(${h}, ${s}%, ${l}%)`);
  }

  // Selection with alpha
  const s2 = find('surface2');
  const s2h = shiftHue(s2.h, shift);
  root.style.setProperty(
    '--c-selection',
    `hsla(${s2h}, ${satFor(s2.s, baseHue)}%, ${darken(s2.l, darkness)}%, 0.4)`,
  );

  // Red with alpha for delete hover
  const red = find('red');
  const rh = shiftHue(red.h, shift);
  root.style.setProperty(
    '--c-red-dim',
    `hsla(${rh}, ${satFor(red.s, baseHue)}%, ${darken(red.l, darkness)}%, 0.1)`,
  );

  root.style.setProperty('--profile-font-size', `${profileFontSize}px`);
  root.style.setProperty(
    '--profile-font-size-small',
    `${Math.round(profileFontSize * 0.846)}px`,
  );
}

export function getTerminalTheme(baseHue: number, darkness: number) {
  const shift = baseHue >= 360 ? 0 : baseHue - BASE_HUE;

  function hex(name: string): string {
    const c = find(name);
    return hslToHex(
      shiftHue(c.h, shift),
      satFor(c.s, baseHue),
      darken(c.l, darkness),
    );
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

export function hueToPreviewColor(hue: number, darkness: number): string {
  return hslToHex(
    hue >= 360 ? 0 : hue,
    hue >= 360 ? 0 : 21,
    darken(15, darkness),
  );
}
