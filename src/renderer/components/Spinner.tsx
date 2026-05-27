/** Shared loading spinner. `label` renders next to the spinner; pass
 * `center` to fill + center within the parent (for whole-panel loading
 * states). Color follows `currentColor` so callers can tint via CSS. */
interface SpinnerProps {
  label?: string;
  size?: number;
  center?: boolean;
}

export function Spinner({ label, size = 18, center = false }: SpinnerProps) {
  const spinner = (
    <span className="spinner-row">
      <svg
        className="spinner-svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {label && <span className="spinner-label">{label}</span>}
    </span>
  );

  if (center) {
    return <div className="spinner-center" role="status" aria-live="polite">{spinner}</div>;
  }
  return <span role="status" aria-live="polite">{spinner}</span>;
}
