'use client';

import { useEffect, useRef, useMemo, useState, memo } from 'react';
import type { Message, MessagePart } from '@/lib/types';
import { MessagePartRenderer } from './message-part';
import { viewRegistry } from '@/lib/view-registry';

interface MessageListProps {
  messages: Message[];
  isStreaming: boolean;
  statusMessage?: string | null;
}

export function MessageList({ messages, isStreaming, statusMessage }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    const container = containerRef.current?.parentElement;
    if (!container) return;
    function onScroll() {
      const el = container!;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolledUp.current = !atBottom;
      setShowScrollButton(!atBottom);
    }
    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const scrollToBottom = () => {
    userScrolledUp.current = false;
    setShowScrollButton(false);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '800px', margin: '0 auto', position: 'relative' }}>
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {isStreaming && <StreamingIndicator statusMessage={statusMessage} />}
      <div ref={bottomRef} />
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          style={{
            position: 'sticky',
            bottom: '16px',
            alignSelf: 'center',
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            border: '1px solid var(--border-default, #e5e7eb)',
            backgroundColor: 'var(--surface-primary, white)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '16px',
            color: 'var(--text-secondary, #6b7280)',
            zIndex: 10,
          }}
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          ↓
        </button>
      )}
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  const orderedParts = useMemo(() => {
    if (isUser) return message.parts;
    const viewLabels = viewRegistry.list().map((v) => v.label);
    if (viewLabels.length === 0) return message.parts;
    const viewTextParts: MessagePart[] = [];
    const otherParts: MessagePart[] = [];
    for (const part of message.parts) {
      if (part.type === 'text' && viewLabels.some((label) => part.content.includes(label))) {
        viewTextParts.push(part);
      } else {
        otherParts.push(part);
      }
    }
    return [...viewTextParts, ...otherParts];
  }, [message.parts, isUser]);

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        style={{
          maxWidth: isUser ? '70%' : '100%',
          padding: isUser ? '10px 16px' : '0',
          borderRadius: isUser ? '16px 16px 4px 16px' : '0',
          backgroundColor: isUser ? 'var(--surface-accent, #e0edff)' : 'transparent',
          color: 'var(--text-primary, #111827)',
          fontSize: '14px',
          lineHeight: '1.6',
        }}
      >
        {orderedParts.map((part, i) => (
          <MessagePartRenderer key={`${part.type}-${i}`} part={part} />
        ))}
      </div>
    </div>
  );
});

function StreamingIndicator({ statusMessage }: { statusMessage?: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0' }}>
      <div style={{ display: 'flex', gap: '4px' }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: 'var(--text-tertiary, #9ca3af)',
              animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>
      {statusMessage && (
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary, #9ca3af)' }}>
          {statusMessage}
        </span>
      )}
    </div>
  );
}
