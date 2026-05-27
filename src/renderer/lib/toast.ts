// Tiny module-level toast store. Deliberately not a React context so
// any code — deeply nested components, IPC callbacks, even non-render
// paths — can fire a toast with a plain function call and no prop
// drilling. A single <ToastContainer /> mounted near the app root
// subscribes and renders.

export type ToastType = 'error' | 'success' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  for (const l of listeners) l(toasts);
}

/** Subscribe to the toast list. Calls back immediately with the
 * current list and on every change. Returns an unsubscribe fn. */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => { listeners.delete(listener); };
}

export function dismissToast(id: number): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/** Show a toast. `durationMs <= 0` keeps it until manually dismissed.
 * Errors linger longer than successes since they need to be read. */
export function showToast(message: string, type: ToastType = 'error', durationMs?: number): number {
  const id = nextId++;
  const ms = durationMs ?? (type === 'error' ? 8000 : type === 'success' ? 3500 : 5000);
  toasts = [...toasts, { id, type, message }];
  emit();
  if (ms > 0) {
    setTimeout(() => dismissToast(id), ms);
  }
  return id;
}

export const toastError = (message: string): number => showToast(message, 'error');
export const toastSuccess = (message: string): number => showToast(message, 'success');
export const toastInfo = (message: string): number => showToast(message, 'info');

/** Normalise an unknown thrown value into a readable string for a toast. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
