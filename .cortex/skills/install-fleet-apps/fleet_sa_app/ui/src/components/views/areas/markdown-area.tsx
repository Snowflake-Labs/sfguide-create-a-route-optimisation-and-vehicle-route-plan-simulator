'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useDisplayConfig, interpolateTokens } from '@/lib/display-config';

// Static, config-driven prose area. Renders `config.content` (a markdown string
// authored in app-views.json) using the same react-markdown stack as the chat
// panel. No data query - purely presentational (help / reference / explainer
// pages). Registered as `Markdown` in view-renderer AREA_COMPONENTS.
interface MarkdownAreaProps {
  areaConfig: {
    config?: {
      content?: string;
      // Optional cap on readable line length; defaults to a comfortable measure.
      maxWidth?: number | string;
    };
  };
}

export function MarkdownArea({ areaConfig }: MarkdownAreaProps) {
  const displayConfig = useDisplayConfig();
  const raw = areaConfig.config?.content ?? '';
  const content = interpolateTokens(raw, displayConfig);
  const maxWidth = areaConfig.config?.maxWidth ?? 820;

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div
        className="markdown-body"
        style={{ fontSize: '14px', lineHeight: '1.6', maxWidth, margin: '0 auto' }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
