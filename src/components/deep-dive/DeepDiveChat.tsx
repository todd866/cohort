'use client';

import { useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

interface DeepDiveChatProps {
  slug: string;
  title?: string;
}

export function DeepDiveChat({ slug, title }: DeepDiveChatProps) {
  const { status } = useSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setError(null);
    setLoading(true);

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');

    try {
      const response = await fetch(`/api/deep-dive/cards/${slug}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 429) {
          const retryAfter = payload.retryAfterSeconds ? ` Try again in ${payload.retryAfterSeconds}s.` : '';
          throw new Error(`Rate limit reached.${retryAfter}`);
        }
        throw new Error(payload.error || 'Failed to get response');
      }

      const data = await response.json();
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: typeof data.response === 'string' ? data.response : 'No response available.',
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get response');
    } finally {
      setLoading(false);
    }
  };

  const titleText = title ? `Ask about ${title}` : 'Ask about this card';
  const subtitle =
    status === 'authenticated'
      ? 'Short, targeted explanations only. Educational use.'
      : 'Guest limits apply. Sign in for more questions.';

  return (
    <div className="border border-[var(--md-outline-variant)] rounded-xl overflow-hidden">
      <div className="p-4 bg-[var(--md-surface-container)] border-b border-[var(--md-outline-variant)]">
        <div className="font-semibold text-[var(--md-on-surface)]">{titleText}</div>
        <div className="text-sm text-[var(--md-on-surface-variant)]">{subtitle}</div>
      </div>

      <div className="h-64 overflow-y-auto p-4 space-y-3 bg-[var(--md-surface)]">
        {messages.length === 0 && (
          <div className="text-center text-[var(--md-on-surface-variant)] text-sm py-8">
            Ask a specific question about the concept, and the AI will respond using only this deep dive.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] p-3 rounded-xl ${
                m.role === 'user'
                  ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                  : 'bg-[var(--md-surface-container)] text-[var(--md-on-surface)]'
              }`}
            >
              <div className="text-sm whitespace-pre-wrap">{m.content}</div>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-[var(--md-surface-container)] p-3 rounded-xl">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-[var(--md-on-surface-variant)] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-[var(--md-on-surface-variant)] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-[var(--md-on-surface-variant)] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="px-4 py-2 text-sm text-[var(--md-error)] border-t border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]">
          {error}
        </div>
      )}

      <div className="p-3 border-t border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
            placeholder="Ask a question..."
            className="flex-1 px-3 py-2 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface)] focus:outline-none focus:border-[var(--md-primary)]"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}
