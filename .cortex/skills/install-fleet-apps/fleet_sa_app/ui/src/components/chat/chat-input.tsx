'use client';

import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { useAppStore } from '@/lib/store';
import { viewRegistry } from '@/lib/view-registry';

interface ChatInputProps {
  onSend: (text: string) => void;
  isStreaming: boolean;
  suggestions: string[];
}

export function ChatInput({ onSend, isStreaming, suggestions }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeViewId = useAppStore((s) => s.panel.activeViewId);
  const viewState = useAppStore((s) => s.panel.viewState);
  const viewContextEnabled = useAppStore((s) => s.viewContextEnabled);
  const setViewContextEnabled = useAppStore((s) => s.setViewContextEnabled);

  const viewDef = activeViewId ? viewRegistry.get(activeViewId) : undefined;
  const showChip = !!viewDef && viewContextEnabled;

  // Filters only: `__memo_*` keys are agent-grounding payloads (see
  // lib/agent-memo.ts), not user-set filters. Counting them inflated "N filters
  // active" and leaked memo text into the chip hover, and it also broke the
  // agent instruction in chat/route.ts that tells it to open with "filtered by
  // ..." matching exactly what this chip shows.
  const activeFilterEntries = Object.entries(viewState)
    .filter(([k, v]) => v != null && !k.startsWith('__memo_'));
  const activeFilters = activeFilterEntries
    .map(([k, v]) => `${k.replace('selected', '')}: ${v}`)
    .join(', ');
  const filterCount = activeFilterEntries.length;

  const fullChipText = `${viewDef?.label || ''}${activeFilters ? ` · ${activeFilters}` : ''}`;
  const shortFilters = filterCount > 0 ? ` · ${filterCount} filter${filterCount > 1 ? 's' : ''} active` : '';
  const displayText = `${viewDef?.label || ''}${shortFilters}`;
  const maxChipLen = 50;
  const chipText = displayText.length > maxChipLen ? displayText.slice(0, maxChipLen) + '…' : displayText;

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, isStreaming, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 10 * 24;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  };

  return (
    <div style={{ width: '100%' }}>
      {suggestions.length > 0 && !isStreaming && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
          {suggestions.slice(0, 4).map((s, i) => (
            <button
              key={i}
              onClick={() => onSend(s)}
              style={{
                padding: '6px 14px',
                borderRadius: '16px',
                border: '1px solid var(--border-default, #e5e7eb)',
                backgroundColor: 'var(--surface-primary, #fff)',
                fontSize: '13px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                color: 'var(--text-primary, #111827)',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {showChip && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              borderRadius: '6px',
              backgroundColor: 'var(--surface-secondary, #f3f4f6)',
              border: '1px solid var(--border-default, #e5e7eb)',
              fontSize: '12px',
              color: 'var(--text-secondary, #6b7280)',
            }}
          >
            <span>📊</span>
            <span title={fullChipText}>{chipText}</span>
            <button
              onClick={() => setViewContextEnabled(false)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '0 2px',
                fontSize: '14px',
                color: 'var(--text-tertiary, #9ca3af)',
                lineHeight: 1,
              }}
              title="Remove view context from next message"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {!showChip && viewDef && !viewContextEnabled && (
        <div style={{ marginBottom: '8px' }}>
          <button
            onClick={() => setViewContextEnabled(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              borderRadius: '6px',
              border: '1px dashed var(--border-default, #e5e7eb)',
              backgroundColor: 'transparent',
              fontSize: '12px',
              color: 'var(--text-tertiary, #9ca3af)',
              cursor: 'pointer',
            }}
          >
            <span>+</span> Add view context
          </button>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '8px',
          padding: '8px 12px',
          borderRadius: '16px',
          border: '1px solid var(--border-default, #e5e7eb)',
          backgroundColor: 'var(--surface-primary, #fff)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          aria-label="Chat message input"
          rows={3}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontSize: '14px',
            lineHeight: '24px',
            fontFamily: 'inherit',
            backgroundColor: 'transparent',
            color: 'var(--text-primary, #111827)',
          }}
        />
        {isStreaming ? (
          <button
            onClick={() => useAppStore.getState().abortStreaming()}
            aria-label="Stop generating"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              border: 'none',
              backgroundColor: 'var(--surface-error, #fef2f2)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <div style={{ width: '12px', height: '12px', backgroundColor: 'var(--text-error, #dc2626)', borderRadius: '2px' }} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim()}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              border: 'none',
              backgroundColor: value.trim() ? 'var(--surface-accent-bold, #2563eb)' : 'var(--surface-secondary, #f3f4f6)',
              cursor: value.trim() ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: value.trim() ? '#fff' : 'var(--text-tertiary, #9ca3af)',
              fontSize: '16px',
            }}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
