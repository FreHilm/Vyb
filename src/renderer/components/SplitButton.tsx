import { useEffect, useRef, useState } from 'react';

/** Reusable split button — primary action on the left, chevron on the
 * right that opens a small dropdown menu. Used by the Git panel's Push
 * and Pull buttons (force-push, push-tags, pull-rebase variants).
 *
 * The component is intentionally minimal: a parent supplies the primary
 * label / handler and a list of menu items, and the menu renders
 * absolutely positioned below the chevron. Outside-click and Escape
 * close the menu. The chevron looks disabled when `items` is empty,
 * matching the platform "no secondary actions" feel. */

export interface SplitButtonItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Optional `danger` flag adds the same red styling the file context
   * menu uses for destructive actions. */
  danger?: boolean;
  /** Optional short helper text under the label (e.g. an explanation of
   * what the action does or why it's currently disabled). */
  hint?: string;
}

interface SplitButtonProps {
  /** Primary button label. */
  label: string;
  /** Primary click action. */
  onClick: () => void;
  /** Tooltip on the primary button. */
  title?: string;
  /** Primary disabled. The chevron stays clickable so the user can still
   * see alternative actions even when the default is unavailable. */
  disabled?: boolean;
  /** Visual busy indicator on the primary button. */
  busy?: boolean;
  /** Menu items behind the chevron. Empty array = chevron is hidden. */
  items: SplitButtonItem[];
  /** Optional decoration node rendered before the label (e.g. SVG icon). */
  icon?: React.ReactNode;
  /** Optional pill badge (count, etc.) after the label. */
  badge?: React.ReactNode;
  /** ClassName applied to the outer button group. Pair with existing
   * styling so it matches the surrounding toolbar. */
  className?: string;
}

export function SplitButton({
  label, onClick, title, disabled = false, busy = false,
  items, icon, badge, className = '',
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (groupRef.current && !groupRef.current.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hasMenu = items.length > 0;
  return (
    <div className={`split-button ${className} ${busy ? 'is-busy' : ''}`} ref={groupRef}>
      <button
        type="button"
        className="split-button-primary"
        onClick={onClick}
        disabled={disabled}
        title={title}
      >
        {icon}
        <span>{label}</span>
        {badge}
      </button>
      {hasMenu && (
        <button
          type="button"
          className={`split-button-chevron ${open ? 'is-open' : ''}`}
          onClick={() => setOpen((o) => !o)}
          title="More options"
          aria-expanded={open}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 8 11 13 6" />
          </svg>
        </button>
      )}
      {hasMenu && open && (
        <div className="split-button-menu" onClick={(e) => e.stopPropagation()}>
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              className={`split-button-menu-item ${it.danger ? 'is-danger' : ''}`}
              disabled={it.disabled}
              onClick={() => { setOpen(false); if (!it.disabled) it.onClick(); }}
            >
              <span className="split-button-menu-label">{it.label}</span>
              {it.hint && <span className="split-button-menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
