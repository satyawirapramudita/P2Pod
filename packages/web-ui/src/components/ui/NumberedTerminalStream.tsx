import React, { useEffect, useRef } from 'react';
import { StoredMessage } from '../../types/bridge';
import { SyntaxTagBadge } from './Primitives';

export interface NumberedTerminalStreamProps {
  messages: StoredMessage[];
  localDisplayName: string;
  emptyHint?: string;
}

function formatHHMMSS(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function NumberedTerminalStream({
  messages,
  localDisplayName,
  emptyHint = 'Belum ada pesan pada sesi ini. Ketik pesan di bawah untuk memulai.',
}: NumberedTerminalStreamProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="terminal-stream" ref={containerRef}>
        <div className="terminal-line">
          <span className="terminal-line__num">01</span>
          <div className="terminal-line__content">
            <SyntaxTagBadge label="IDLE" tone="muted" />
            <span className="terminal-line__time">{emptyHint}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-stream" ref={containerRef} role="log" aria-live="polite">
      {messages.map((msg, idx) => {
        const isSent =
          msg.direction === 'sent' ||
          (!msg.direction && msg.senderName.toLowerCase() === localDisplayName.toLowerCase());
        const lineNum = String(idx + 1).padStart(2, '0');

        return (
          <div
            key={`${msg.timestamp}-${msg.seq ?? idx}-${msg.senderName}`}
            className={isSent ? 'terminal-line terminal-line--sent' : 'terminal-line'}
          >
            <span className="terminal-line__num">{lineNum}</span>
            <div className="terminal-line__content">
              <span className="terminal-line__time">[{formatHHMMSS(msg.timestamp)}]</span>
              <SyntaxTagBadge
                label={isSent ? `>> ${msg.senderName}` : `<< ${msg.senderName}`}
                tone={isSent ? 'magenta' : 'cyan'}
              />
              <span className="terminal-line__text">{msg.text}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
