import { useAppStore } from '@/lib/store';

export function useChat() {
  const messages = useAppStore((s) => s.chat.messages);
  const status = useAppStore((s) => s.chat.status);
  const error = useAppStore((s) => s.chat.error);
  const suggestions = useAppStore((s) => s.chat.suggestions);
  const sendMessage = useAppStore((s) => s.sendMessage);

  return { messages, status, error, suggestions, sendMessage };
}
