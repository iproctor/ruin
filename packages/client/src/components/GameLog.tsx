import { useEffect, useRef } from 'react';

interface GameLogProps {
  entries: string[];
}

export default function GameLog({ entries }: GameLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  return (
    <div
      style={{
        background: '#0f0f1f',
        border: '1px solid #2d2d5e',
        borderRadius: 6,
        padding: '0.5rem',
        flex: '1 1 120px',
        overflowY: 'auto',
        minHeight: 80,
      }}
    >
      <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: '0.25rem', fontWeight: 600 }}>
        Game Log
      </div>
      {entries.length === 0 && (
        <div style={{ color: '#555', fontSize: '0.8rem' }}>No entries yet.</div>
      )}
      {entries.map((entry, i) => (
        <div
          key={i}
          style={{
            fontSize: '0.78rem',
            color: '#ccc',
            padding: '0.15rem 0',
            borderBottom: '1px solid #1e1e3a',
          }}
        >
          {entry}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
