import { useEffect, useState, useCallback, useRef } from 'react';
import { AppSettings } from '../../shared/types';

interface KeyNavProps {
  settings: AppSettings;
  commandBarActions: (() => void)[];
  commandBarLabels: string[];
  onProfileUp: () => void;
  onProfileDown: () => void;
  onPaneLeft: () => void;
  onPaneRight: () => void;
}

export function useKeyNav({
  settings,
  commandBarActions,
  commandBarLabels,
  onProfileUp,
  onProfileDown,
  onPaneLeft,
  onPaneRight,
}: KeyNavProps) {
  const [navActive, setNavActive] = useState(false);

  // The captions only appear after the modifier has been held continuously for
  // SHOW_DELAY_MS. A pending timer lives here so any release/other-key signal
  // can cancel it before it fires (so a quick press shows nothing).
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isModifier = useCallback(
    (e: KeyboardEvent) => {
      return settings.navModifierKey === 'meta' ? e.metaKey : e.altKey;
    },
    [settings.navModifierKey],
  );

  // True when keyboard focus is in a text-editing surface, where arrow keys
  // (with Cmd/Shift) mean caret movement / selection, not app navigation.
  const isEditableTarget = (): boolean => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    // The terminal is NOT a text field for this purpose: xterm renders a
    // hidden <textarea class="xterm-helper-textarea"> for input, but Cmd/Alt
    // +Arrow there means profile/pane navigation (not text selection). Don't
    // let the TEXTAREA check below swallow nav while the terminal is focused.
    if (el.closest('.xterm')) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.closest('.monaco-editor') || el.closest('.cm-editor')) return true;
    return false;
  };

  const SHOW_DELAY_MS = 500;

  useEffect(() => {
    // Cancel a pending show timer and hide the overlay. Used by every path
    // that should abort the captions — modifier release, another modifier
    // joining, a committed non-nav shortcut, blur, etc.
    const cancel = () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      setNavActive(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Modifier held → schedule the captions to appear after the hold delay.
      // Releasing (or pressing anything else) before SHOW_DELAY_MS cancels it,
      // so a brief tap of Cmd never flashes the overlay. Modifier keys don't
      // auto-repeat, so this fires once per press; the guard is belt-and-braces.
      if (
        (settings.navModifierKey === 'meta' && e.key === 'Meta') ||
        (settings.navModifierKey === 'alt' && e.key === 'Alt')
      ) {
        if (!showTimerRef.current) {
          showTimerRef.current = setTimeout(() => {
            showTimerRef.current = null;
            setNavActive(true);
          }, SHOW_DELAY_MS);
        }
        return;
      }

      // If another modifier joins (e.g. user starts Cmd+Shift+4 for a system
      // screenshot), hide immediately — it's not a nav combo and the OS will
      // likely swallow the eventual keyup.
      if (
        e.key === 'Shift' ||
        e.key === 'Control' ||
        (settings.navModifierKey === 'meta' && e.key === 'Alt') ||
        (settings.navModifierKey === 'alt' && e.key === 'Meta')
      ) {
        cancel();
        return;
      }

      if (!isModifier(e)) {
        // Modifier was released without us seeing the keyup — clear overlay.
        cancel();
        return;
      }

      // Number keys 1-9, 0 → actions 0-9
      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        if (idx < commandBarActions.length) {
          e.preventDefault();
          commandBarActions[idx]();
        }
        return;
      }
      if (e.key === '0') {
        const idx = 9;
        if (idx < commandBarActions.length) {
          e.preventDefault();
          commandBarActions[idx]();
        }
        return;
      }

      // Arrow keys → profile / pane navigation. BUT never steal them from a
      // text field: with the Cmd nav-modifier, Cmd+←/→ and Cmd+Shift+←/→ are
      // line navigation / selection, and Monaco/CodeMirror own word nav too.
      // Hijacking those broke text selection in inputs (e.g. the commit
      // subject/description boxes).
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (isEditableTarget()) return;
        e.preventDefault();
        if (e.key === 'ArrowUp') onProfileUp();
        else if (e.key === 'ArrowDown') onProfileDown();
        else if (e.key === 'ArrowLeft') onPaneLeft();
        else onPaneRight();
        return;
      }

      // Any OTHER key pressed while the nav modifier is held means the user
      // is committing to a non-nav shortcut (⌘S, ⌘F, ⌘=, ⌃⌘=, …). The nav
      // captions no longer apply, so hide them. Number/arrow nav keys
      // returned above and deliberately keep the captions up so navigation
      // can be chained while the modifier stays held.
      cancel();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (
        (settings.navModifierKey === 'meta' && e.key === 'Meta') ||
        (settings.navModifierKey === 'alt' && e.key === 'Alt')
      ) {
        cancel();
      }
    };

    // Mouse events carry the live modifier state — if the user moves the
    // mouse and the modifier is no longer held, the keyup was swallowed
    // (e.g. by a screenshot overlay) so clear the badge.
    const handleMouseMove = (e: MouseEvent) => {
      const held = settings.navModifierKey === 'meta' ? e.metaKey : e.altKey;
      if (!held) cancel();
    };

    // Also deactivate on blur (modifier might be released while window is unfocused)
    const handleBlur = () => cancel();
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') cancel();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };
  }, [settings.navModifierKey, isModifier, commandBarActions, onProfileUp, onProfileDown, onPaneLeft, onPaneRight]);

  // Safety auto-hide: if every release/blur signal is swallowed (rare), force
  // the overlay off after 3s of being active.
  useEffect(() => {
    if (!navActive) return;
    const t = setTimeout(() => setNavActive(false), 3000);
    return () => clearTimeout(t);
  }, [navActive]);

  return navActive;
}

// Overlay badge component
export function NavBadge({ label }: { label: string }) {
  return <span className="nav-badge">{label}</span>;
}

// Arrow hint overlay
export function NavArrow({ direction }: { direction: 'up' | 'down' | 'left' | 'right' }) {
  const arrows: Record<string, string> = {
    up: '\u2191',
    down: '\u2193',
    left: '\u2190',
    right: '\u2192',
  };
  return <span className="nav-arrow">{arrows[direction]}</span>;
}
