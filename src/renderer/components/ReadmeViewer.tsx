import { useEffect, useState, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ReadmeViewerProps {
  workingDirectory: string;
}

export function ReadmeViewer({ workingDirectory }: ReadmeViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    window.api.loadReadme(workingDirectory).then((md) => {
      setContent(md);
      setLoading(false);
    });
  }, [workingDirectory]);

  // Focus the viewer so it receives keyboard events for scrolling
  useEffect(() => {
    if (!loading && content && viewerRef.current) {
      viewerRef.current.focus();
    }
  }, [loading, content]);

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
    <div className="readme-viewer" ref={viewerRef} tabIndex={-1}>
      <div className="readme-content">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </div>
  );
}
