import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Catches render-time errors in its children so a single broken
 * component (often markdown / mermaid / rehype-raw on an unexpected
 * file) doesn't unmount the entire React tree and leave the user
 * staring at the bare `<body>` background.
 *
 * Wrap risky regions (Markdown renderers, third-party widgets) with
 * `scope="local"` so the rest of the page keeps working. The App
 * itself wraps everything as a top-level safety net. */
interface Props {
  children: ReactNode;
  /** Shown in place of children when a render error occurs. */
  fallback?: (err: Error, retry: () => void) => ReactNode;
  /** A label used in console.error to make debugging easier. */
  label?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? ' ' + this.props.label : ''}]`, error, info.componentStack);
  }

  retry = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);
    return (
      <div
        style={{
          padding: 16,
          margin: 12,
          borderRadius: 6,
          border: '1px solid var(--c-red, #ef4444)',
          background: 'color-mix(in srgb, var(--c-red, #ef4444) 10%, transparent)',
          color: 'var(--c-text, #cdd6f4)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Something went wrong rendering this view.</div>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, marginBottom: 8, fontSize: 12, opacity: 0.85 }}>
          {error.message || String(error)}
        </pre>
        <button
          onClick={this.retry}
          style={{
            background: 'var(--c-surface0, #313244)',
            color: 'inherit',
            border: '1px solid var(--c-surface1, #45475a)',
            borderRadius: 4,
            padding: '4px 10px',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
