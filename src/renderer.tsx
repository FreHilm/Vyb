import { createRoot } from 'react-dom/client';
import { App } from './renderer/App';
import { ErrorBoundary } from './renderer/components/ErrorBoundary';
import './index.css';

const root = createRoot(document.getElementById('root')!);
// Top-level safety net so a render error anywhere (markdown, mermaid,
// excalidraw, third-party widgets) shows an inline panel instead of
// unmounting the whole window to a grey background.
root.render(
  <ErrorBoundary label="root">
    <App />
  </ErrorBoundary>,
);
