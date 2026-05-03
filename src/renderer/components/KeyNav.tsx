import { useEffect, useState, useCallback } from 'react';
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

  const isModifier = useCallback(
    (e: KeyboardEvent) => {
      return settings.navModifierKey === 'meta' ? e.metaKey : e.altKey;
    },
    [settings.navModifierKey],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Activate nav overlay when modifier is held
      if (
        (settings.navModifierKey === 'meta' && e.key === 'Meta') ||
        (settings.navModifierKey === 'alt' && e.key === 'Alt')
      ) {
        setNavActive(true);
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
        setNavActive(false);
        return;
      }

      if (!isModifier(e)) {
        // Modifier was released without us seeing the keyup — clear overlay.
        setNavActive(false);
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

      // Arrow keys
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        onProfileUp();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        onProfileDown();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onPaneLeft();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onPaneRight();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (
        (settings.navModifierKey === 'meta' && e.key === 'Meta') ||
        (settings.navModifierKey === 'alt' && e.key === 'Alt')
      ) {
        setNavActive(false);
      }
    };

    // Mouse events carry the live modifier state — if the user moves the
    // mouse and the modifier is no longer held, the keyup was swallowed
    // (e.g. by a screenshot overlay) so clear the badge.
    const handleMouseMove = (e: MouseEvent) => {
      const held = settings.navModifierKey === 'meta' ? e.metaKey : e.altKey;
      if (!held) setNavActive(false);
    };

    // Also deactivate on blur (modifier might be released while window is unfocused)
    const handleBlur = () => setNavActive(false);
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') setNavActive(false);
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
