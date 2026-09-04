'use client';

import { useAppStore } from '@/lib/store';
import { MessageList } from './message-list';
import { ChatInput } from './chat-input';
import type { AppConfig } from '../app-shell';
import { flattenSampleQuestions, toSampleQuestionGroups } from '../app-shell';

interface ChatPanelProps {
  appConfig?: AppConfig;
}

export function ChatPanel({ appConfig }: ChatPanelProps) {
  const messages = useAppStore((s) => s.chat.messages);
  const status = useAppStore((s) => s.chat.status);
  const statusMessage = useAppStore((s) => s.chat.statusMessage);
  const suggestions = useAppStore((s) => s.chat.suggestions);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const isActive = status === 'streaming' || status === 'submitted' || status === 'thinking';

  const activeSuggestions =
    messages.length === 0 && flattenSampleQuestions(appConfig?.sampleQuestions).length
      ? flattenSampleQuestions(appConfig?.sampleQuestions)
      : suggestions;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        {messages.length === 0 ? (
          <WelcomeScreen appConfig={appConfig} />
        ) : (
          <MessageList messages={messages} isStreaming={isActive} statusMessage={statusMessage} />
        )}
      </div>
      <div style={{ flexShrink: 0, padding: '0 24px 24px' }}>
        <ChatInput
          onSend={sendMessage}
          isStreaming={isActive}
          suggestions={activeSuggestions}
        />
      </div>
    </div>
  );
}

function WelcomeScreen({ appConfig }: { appConfig?: AppConfig }) {
  const sendMessage = useAppStore((s) => s.sendMessage);
  if (!appConfig) return null;
  const questionGroups = toSampleQuestionGroups(appConfig.sampleQuestions);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '32px 32px 0',
      }}
    >
      <h2 style={{ margin: '0 0 16px', fontSize: '20px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>
        {appConfig?.name || 'How can I help?'}
      </h2>
      {appConfig?.description ? (
        <p style={{ margin: '0 0 20px', fontSize: '14px', lineHeight: 1.6, color: 'var(--text-secondary, #6b7280)' }}>
          {appConfig.description}
        </p>
      ) : (
        <p style={{ margin: '0 0 20px', fontSize: '14px', lineHeight: 1.6, color: 'var(--text-secondary, #6b7280)' }}>
          Ask me anything about your data, or tell me what you&apos;d like to build.
        </p>
      )}
      {appConfig?.targetUsers && appConfig.targetUsers.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Who is this for
          </h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', lineHeight: 1.8, color: 'var(--text-secondary, #6b7280)' }}>
            {appConfig.targetUsers.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </div>
      )}
      {appConfig?.capabilities && appConfig.capabilities.length > 0 && (
        <div>
          <h3 style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            What it can do
          </h3>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', lineHeight: 1.8, color: 'var(--text-secondary, #6b7280)' }}>
            {appConfig.capabilities.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
      {questionGroups.length > 0 && (
        <div style={{ marginTop: '24px' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Start here
          </h3>
          {questionGroups.map((g, gi) => (
            <div key={gi} style={{ marginBottom: '16px' }}>
              {g.group ? (
                <div style={{ margin: '0 0 6px', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {g.group}
                </div>
              ) : null}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' }}>
                {g.questions.map((q, qi) => (
                  <button
                    key={qi}
                    type="button"
                    onClick={() => sendMessage(q)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '3px 0',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: '14px',
                      lineHeight: 1.5,
                      color: 'var(--accent, #2563eb)',
                      fontFamily: 'inherit',
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
