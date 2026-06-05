import { useEffect, useMemo, useState } from 'react';

// Progressive hotkey HUD. Holding a primary modifier (⌘/⌃/⌥) reveals the
// hotkeys available with it; adding more modifiers narrows the list to the
// ones that need that exact combination. Shift alone never triggers it (so
// typing capitals doesn't flash the panel).

type Mod = 'meta' | 'ctrl' | 'alt' | 'shift';

interface Hotkey {
  mods: Mod[];
  keys: string;   // the non-modifier key(s), e.g. "S", "= / −", "↑ ↓"
  label: string;
}

const MOD_SYMBOL: Record<Mod, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
// macOS convention orders modifier glyphs ⌃⌥⇧⌘.
const MOD_DISPLAY_ORDER: Mod[] = ['ctrl', 'alt', 'shift', 'meta'];

function sortedMods(mods: Mod[]): Mod[] {
  return MOD_DISPLAY_ORDER.filter((m) => mods.includes(m));
}

interface HotkeyHintsProps {
  /** The configurable profile/pane navigation modifier. */
  navModifierKey: 'meta' | 'alt';
  /** Command-bar action labels, in button order (driven by NavBadge 1–9). */
  commandBarLabels: string[];
}

export function HotkeyHints({ navModifierKey, commandBarLabels }: HotkeyHintsProps) {
  const [held, setHeld] = useState<Set<Mod>>(new Set());
  const [visible, setVisible] = useState(false);

  // Track the live modifier state from any key/mouse event.
  useEffect(() => {
    const fromEvent = (e: KeyboardEvent | MouseEvent) => {
      const s = new Set<Mod>();
      if (e.metaKey) s.add('meta');
      if (e.ctrlKey) s.add('ctrl');
      if (e.altKey) s.add('alt');
      if (e.shiftKey) s.add('shift');
      setHeld((prev) => {
        if (prev.size === s.size && [...s].every((m) => prev.has(m))) return prev;
        return s;
      });
    };
    const clear = () => setHeld(new Set());
    const onVisibility = () => { if (document.visibilityState !== 'visible') clear(); };

    window.addEventListener('keydown', fromEvent, true);
    window.addEventListener('keyup', fromEvent, true);
    window.addEventListener('mousemove', fromEvent);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', fromEvent, true);
      window.removeEventListener('keyup', fromEvent, true);
      window.removeEventListener('mousemove', fromEvent);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Only reveal once a *primary* modifier is held (Shift-only is ignored),
  // and after a short delay so quick shortcuts (⌘C) don't flash the panel.
  const primaryHeld = held.has('meta') || held.has('ctrl') || held.has('alt');
  useEffect(() => {
    if (!primaryHeld) { setVisible(false); return; }
    const t = setTimeout(() => setVisible(true), 350);
    return () => clearTimeout(t);
  }, [primaryHeld]);

  // The full hotkey catalogue. The nav modifier is substituted in so the
  // profile/pane hotkeys show under whichever modifier the user configured.
  const hotkeys = useMemo<Hotkey[]>(() => {
    const nav = navModifierKey;
    const list: Hotkey[] = [
      { mods: [nav], keys: '↑ ↓', label: 'Previous / next profile' },
      { mods: [nav], keys: '← →', label: 'Switch pane' },
      { mods: ['meta'], keys: 'P', label: 'Quick open file' },
      { mods: ['meta'], keys: 'S', label: 'Save' },
      { mods: ['meta', 'shift'], keys: 'S', label: 'Save as' },
      { mods: ['meta'], keys: 'F', label: 'Find in file' },
      { mods: ['meta', 'shift'], keys: 'E', label: 'Reveal file in tree' },
      { mods: ['meta'], keys: '= / −', label: 'Editor font size' },
      { mods: ['meta'], keys: '0', label: 'Reset font size' },
      { mods: ['ctrl', 'meta'], keys: '= / −', label: 'Split / close terminal' },
    ];
    // Command-bar numbered actions (1–9, 0) under the nav modifier.
    commandBarLabels.slice(0, 10).forEach((label, i) => {
      list.push({ mods: [nav], keys: i === 9 ? '0' : String(i + 1), label });
    });
    return list;
  }, [navModifierKey, commandBarLabels]);

  // Show hotkeys whose required modifiers are a SUPERSET of what's held:
  // every held modifier must be one the hotkey needs. Holding ⌘ → all
  // ⌘-hotkeys; adding ⌃ → only the ⌃⌘ ones.
  const matches = useMemo(() => {
    if (!visible) return [];
    return hotkeys.filter((hk) => [...held].every((m) => hk.mods.includes(m)));
  }, [hotkeys, held, visible]);

  if (!visible || matches.length === 0) return null;

  return (
    <div className="hotkey-hints" role="presentation">
      <div className="hotkey-hints-list">
        {matches.map((hk, i) => (
          <div className="hotkey-hint-row" key={`${hk.label}-${i}`}>
            <span className="hotkey-hint-combo">
              {sortedMods(hk.mods).map((m) => (
                <kbd className="hotkey-key" key={m}>{MOD_SYMBOL[m]}</kbd>
              ))}
              <kbd className="hotkey-key">{hk.keys}</kbd>
            </span>
            <span className="hotkey-hint-label">{hk.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
