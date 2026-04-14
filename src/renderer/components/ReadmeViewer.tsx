import { useEffect, useState, useRef, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

interface ReadmeViewerProps {
  workingDirectory: string;
}

export function ReadmeViewer({ workingDirectory }: ReadmeViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [backVisible, setBackVisible] = useState(false);
  const viewerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFile = useCallback(async (filePath: string, pushHistory: boolean) => {
    setLoading(true);
    const md = await window.api.readFile(filePath);
    if (md !== null) {
      if (pushHistory && currentFile) {
        setHistory((h) => [...h, currentFile]);
      }
      setCurrentFile(filePath);
      setContent(md);
    }
    setLoading(false);
  }, [currentFile]);

  // Load README on mount
  useEffect(() => {
    window.api.loadReadme(workingDirectory).then((md) => {
      if (md !== null) {
        // Find the actual README path
        const names = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
        for (const name of names) {
          const path = `${workingDirectory}/${name}`;
          setCurrentFile(path);
          break;
        }
        setContent(md);
      }
      setLoading(false);
    });
  }, [workingDirectory]);

  // Focus for keyboard events
  useEffect(() => {
    if (!loading && content && viewerRef.current) {
      viewerRef.current.focus();
    }
  }, [loading, content]);

  // Back navigation
  const goBack = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setCurrentFile(prev);
    setLoading(true);
    window.api.readFile(prev).then((md) => {
      setContent(md);
      setLoading(false);
    });
  }, [history]);

  // Show back button on mouse move, auto-hide after 7s
  const showBack = useCallback(() => {
    if (history.length === 0) return;
    setBackVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setBackVisible(false), 7000);
  }, [history]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // Keyboard: Backspace to go back
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && history.length > 0) {
      e.preventDefault();
      goBack();
    }
  }, [goBack, history]);

  // Intercept link clicks
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;

    e.preventDefault();
    const href = target.getAttribute('href');
    if (!href) return;

    // External URL — open in browser
    if (href.startsWith('http://') || href.startsWith('https://')) {
      window.api.openUrl(href);
      return;
    }

    // Relative .md link — navigate within viewer
    if (href.endsWith('.md') || href.endsWith('.mdx')) {
      const dir = currentFile.replace(/\/[^/]+$/, '');
      const resolved = `${dir}/${href}`.replace(/\/\.\//g, '/');
      loadFile(resolved, true);
      return;
    }

    // Anchor link (#section) — scroll to it
    if (href.startsWith('#')) {
      const id = href.slice(1).toLowerCase();
      const el = viewerRef.current?.querySelector(`[id="${id}"], [id="${id.replace(/ /g, '-')}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    // Other relative files — try to open as markdown, fall back to external
    if (!href.includes('://')) {
      const dir = currentFile.replace(/\/[^/]+$/, '');
      const resolved = `${dir}/${href}`.replace(/\/\.\//g, '/');
      // Check if it's a readable file
      window.api.readFile(resolved).then((content) => {
        if (content !== null && (resolved.endsWith('.md') || resolved.endsWith('.txt'))) {
          loadFile(resolved, true);
        }
      });
    }
  }, [currentFile, loadFile]);

  if (loading) {
    return (
      <div className="readme-viewer">
        <div className="readme-loading">Loading...</div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="readme-viewer">
        <div className="readme-empty">No README.md found in this project</div>
      </div>
    );
  }

  return (
    <div
      className="readme-viewer"
      ref={viewerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseMove={showBack}
      onClick={handleClick}
    >
      {history.length > 0 && (
        <button
          className={`readme-back-btn ${backVisible ? 'readme-back-visible' : ''}`}
          onClick={(e) => { e.stopPropagation(); goBack(); }}
          title="Back (Backspace)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7 2L1 8l6 6v-4h6V6H7V2z" />
          </svg>
        </button>
      )}
      <div className="readme-content">
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{content}</Markdown>
      </div>
    </div>
  );
}
