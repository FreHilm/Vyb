import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ReadmeViewerProps {
  workingDirectory: string;
}

export function ReadmeViewer({ workingDirectory }: ReadmeViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    window.api.loadReadme(workingDirectory).then((md) => {
      setContent(md);
      setLoading(false);
    });
  }, [workingDirectory]);

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
    <div className="readme-viewer">
      <div className="readme-content">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </div>
  );
}
