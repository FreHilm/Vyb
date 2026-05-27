import { useEffect, useState } from 'react';
import { subscribeToasts, dismissToast, type Toast } from '../lib/toast';

/** Renders the active toasts in a fixed stack at the bottom-right.
 * Mounted once near the app root; everything else fires toasts via the
 * `showToast` / `toastError` helpers in lib/toast. */
export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} role="status">
          <span className="toast-icon" aria-hidden="true">
            {t.type === 'error' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 5v4M8 11h.01" />
              </svg>
            ) : t.type === 'success' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5 8.2l2 2 4-4.4" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 7.5v3.5M8 5h.01" />
              </svg>
            )}
          </span>
          <span className="toast-msg">{t.message}</span>
          <button
            className="toast-close"
            onClick={() => dismissToast(t.id)}
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
