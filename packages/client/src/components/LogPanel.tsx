import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../hooks/useGameStream.js';
import { POWER_COLORS, POWER_LABELS } from '../lib/display.js';
import type { Power } from '@ruin/engine';

interface LogPanelProps {
  eventLog: string[];
  chat: ChatMessage[];
  myPower: Power | null;
  onSendChat: (message: string) => Promise<void>;
  connected: boolean;
}

type FilterMode = 'all' | 'events' | 'chat';

export default function LogPanel({ eventLog, chat, myPower, onSendChat, connected }: LogPanelProps) {
  const [filter, setFilter] = useState<FilterMode>('all');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Merge events and chat into a single timeline
  type Entry = { kind: 'event'; text: string; idx: number } | { kind: 'chat'; msg: ChatMessage };
  const events: Entry[] = eventLog.map((text, idx) => ({ kind: 'event', text, idx }));
  const chats: Entry[]  = chat.map((msg) => ({ kind: 'chat', msg }));
  const merged = [...events, ...chats].sort((a, b) => {
    // events are ordered by index, chat by createdAt — interleave roughly
    const aTime = a.kind === 'event' ? a.idx : new Date(a.msg.createdAt).getTime() / 1000;
    const bTime = b.kind === 'event' ? b.idx : new Date(b.msg.createdAt).getTime() / 1000;
    return aTime - bTime;
  });

  const visible = filter === 'all'    ? merged
                : filter === 'events' ? merged.filter((e) => e.kind === 'event')
                :                       merged.filter((e) => e.kind === 'chat');

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [visible.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    try {
      await onSendChat(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: '#13121f', borderTop: '1px solid #2d2d5e', borderRadius: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-end px-3 py-2 shrink-0">
        {/* Filter tabs */}
        <div className="flex gap-1" style={{ borderBottom: '1px solid #2d2d5e' }}>
          {(['all', 'events', 'chat'] as FilterMode[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                fontSize: '0.65rem',
                padding: '1px 7px',
                borderRadius: 0,
                fontWeight: 700,
                cursor: 'pointer',
                border: 'none',
                background: filter === f ? '#312e81' : 'transparent',
                color: filter === f ? '#c7d2fe' : '#64748b',
                textTransform: 'capitalize',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-y-auto px-2 py-1 min-h-0 space-y-px">
        {visible.length === 0 && (
          <p style={{ color: '#334155', fontSize: '0.75rem', fontStyle: 'italic', padding: '4px 4px' }}>
            {connected ? 'No entries yet.' : 'Connecting…'}
          </p>
        )}
        {visible.map((entry, i) => {
          if (entry.kind === 'event') {
            return (
              <div
                key={`e-${entry.idx}`}
                style={{ fontSize: '0.72rem', lineHeight: 1.4, color: '#64748b', padding: '1px 4px' }}
              >
                {entry.text}
              </div>
            );
          }
          const { msg } = entry;
          const color = msg.power ? (POWER_COLORS[msg.power as Power] ?? '#6366f1') : '#6366f1';
          const label = msg.power ? (POWER_LABELS[msg.power as Power] ?? msg.username) : msg.username;
          return (
            <div
              key={`c-${msg.id}`}
              style={{
                fontSize: '0.75rem',
                lineHeight: 1.4,
                padding: '2px 4px',
                borderRadius: 3,
                background: '#0d1a2d',
              }}
            >
              <span style={{ color, fontWeight: 700 }}>{label}: </span>
              <span style={{ color: '#cbd5e1' }}>{msg.message}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Chat input */}
      <div className="shrink-0 flex gap-1 p-2">
        <input
          type="text"
          placeholder={myPower ? 'Chat…' : 'Spectating — chat disabled'}
          disabled={!myPower || sending}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          style={{
            flex: 1,
            fontSize: '0.75rem',
            background: '#1e1e3a',
            border: '1px solid #2d2d5e',
            borderRadius: '4px 4px 0 0',
            color: '#e2e8f0',
            padding: '4px 8px',
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          disabled={!myPower || !input.trim() || sending}
          style={{
            fontSize: '0.75rem',
            padding: '4px 10px',
            borderRadius: '4px 0 0 0',
            border: 'none',
            background: '#312e81',
            color: '#c7d2fe',
            cursor: 'pointer',
            opacity: !myPower || !input.trim() ? 0.4 : 1,
          }}
        >
          →
        </button>
      </div>
    </div>
  );
}
