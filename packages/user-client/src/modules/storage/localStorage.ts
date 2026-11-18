// packages/user-client/src/modules/storage/localStorage.ts
// Penyimpanan chat berbasis Local-First di direktori profile pengguna (~/.p2pod/chats).
// Setiap pesan langsung ditulis ke disk (crash-safe) dalam format Schema.org JSON-LD
// yang 100% kompatibel dengan format Solid Pod.

import * as fs from 'fs';
import * as path from 'path';
import type { ChatSessionMeta, HistoryEntry, StoredMessage } from '../pod/solidClient';

export interface LocalMessageItem {
  '@type': 'Message';
  identifier: string;
  sender: string;
  direction: 'sent' | 'received';
  dateCreated: string;
  timestamp: number;
  seq: number;
  text: string;
}

export interface LocalSessionDoc {
  '@context': string;
  '@type': 'Conversation';
  identifier: string;
  sessionId: string;
  dateCreated: string;
  dateModified: string;
  syncedToPod: boolean;
  syncedAt: string | null;
  participants: Array<{
    '@type': 'Person';
    '@id'?: string;
    name: string;
    identifier: string;
  }>;
  messages: LocalMessageItem[];
}

export interface ChatMetadata {
  '@context': string;
  '@type': 'Conversation';
  identifier: string;
  with: string;
  withPeerId: string;
  withWebId?: string;
  ownerWebId?: string;
  lastActivityAt: string;
  totalMessages?: number;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Fallback pada sistem Windows bila terjadi penguncian sementara berkas
    fs.writeFileSync(filePath, content, 'utf8');
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Abaikan jika berkas sementara sudah hilang
    }
  }
}

export class LocalStorage {
  private readonly baseDir: string;
  private readonly activeSessions = new Map<string, LocalSessionDoc>();

  constructor(homeDir: string) {
    this.baseDir = path.join(homeDir, 'chats');
  }

  chatDir(chatId: string): string {
    return path.join(this.baseDir, chatId);
  }

  sessionsDir(chatId: string): string {
    return path.join(this.chatDir(chatId), 'sessions');
  }

  metadataPath(chatId: string): string {
    return path.join(this.chatDir(chatId), 'metadata.json');
  }

  /**
   * Inisialisasi sesi chat baru di disk lokal.
   * Berkas dibuat seketika sehingga sesi tercatat walaupun belum ada pesan.
   */
  initSession(chatId: string, meta: ChatSessionMeta): string {
    const dir = this.sessionsDir(chatId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const sessionFileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const doc: LocalSessionDoc = {
      '@context': 'https://schema.org/',
      '@type': 'Conversation',
      identifier: chatId,
      sessionId: sessionFileName,
      dateCreated: meta.startedAt,
      dateModified: meta.startedAt,
      syncedToPod: false,
      syncedAt: null,
      participants: [
        {
          '@type': 'Person',
          ...(meta.localWebId ? { '@id': meta.localWebId } : {}),
          name: meta.localDisplayName,
          identifier: meta.localPeerId,
        },
        {
          '@type': 'Person',
          ...(meta.remoteWebId ? { '@id': meta.remoteWebId } : {}),
          name: meta.remoteDisplayName,
          identifier: meta.remotePeerId,
        },
      ],
      messages: [],
    };

    const sessionPath = path.join(dir, sessionFileName);
    writeJsonAtomic(sessionPath, doc);
    this.activeSessions.set(`${chatId}:${sessionFileName}`, doc);

    const metadata: ChatMetadata = {
      '@context': 'https://schema.org/',
      '@type': 'Conversation',
      identifier: chatId,
      with: meta.remoteDisplayName,
      withPeerId: meta.remotePeerId,
      ...(meta.remoteWebId ? { withWebId: meta.remoteWebId } : {}),
      ...(meta.localWebId ? { ownerWebId: meta.localWebId } : {}),
      lastActivityAt: meta.startedAt,
    };
    writeJsonAtomic(this.metadataPath(chatId), metadata);

    return sessionFileName;
  }

  /**
   * Tulis pesan langsung ke berkas sesi lokal (write-through / crash-proof).
   */
  appendMessage(chatId: string, sessionFileName: string, entry: HistoryEntry): void {
    const key = `${chatId}:${sessionFileName}`;
    let doc = this.activeSessions.get(key);

    const sessionPath = path.join(this.sessionsDir(chatId), sessionFileName);
    if (!doc) {
      if (fs.existsSync(sessionPath)) {
        try {
          doc = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as LocalSessionDoc;
          this.activeSessions.set(key, doc);
        } catch {
          // ignore parsing error
        }
      }
    }

    if (!doc) return;

    const messageIndex = (doc.messages?.length ?? 0) + 1;
    const msgItem: LocalMessageItem = {
      '@type': 'Message',
      identifier: `msg-${String(messageIndex).padStart(3, '0')}`,
      sender: entry.displayName,
      direction: entry.direction,
      dateCreated: new Date(entry.timestamp).toISOString(),
      timestamp: entry.timestamp,
      seq: entry.seq,
      text: entry.text,
    };

    doc.messages.push(msgItem);
    doc.dateModified = msgItem.dateCreated;
    doc.syncedToPod = false;

    writeJsonAtomic(sessionPath, doc);

    // Perbarui metadata chat
    const meta = this.loadChatMetadata(chatId);
    if (meta) {
      meta.lastActivityAt = msgItem.dateCreated;
      writeJsonAtomic(this.metadataPath(chatId), meta);
    }
  }

  /**
   * Finalisasi sesi saat user /quit atau shutdown.
   * Jika sesi sama sekali tidak memiliki pesan, berkas kosong dihapus agar rapi.
   */
  finalizeSession(chatId: string, sessionFileName: string, endedAt?: string): void {
    const key = `${chatId}:${sessionFileName}`;
    const sessionPath = path.join(this.sessionsDir(chatId), sessionFileName);
    let doc = this.activeSessions.get(key);

    if (!doc && fs.existsSync(sessionPath)) {
      try {
        doc = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as LocalSessionDoc;
      } catch {
        // ignore
      }
    }

    if (!doc) return;

    if (!doc.messages || doc.messages.length === 0) {
      try {
        if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
      } catch {
        // ignore
      }
      this.activeSessions.delete(key);
      return;
    }

    doc.dateModified = endedAt ?? new Date().toISOString();
    writeJsonAtomic(sessionPath, doc);
    this.activeSessions.delete(key);
  }

  /**
   * Muat seluruh riwayat chat untuk chatId secara lokal tanpa ketergantungan internet/Pod.
   */
  loadChatHistory(chatId: string): StoredMessage[] {
    const dir = this.sessionsDir(chatId);
    if (!fs.existsSync(dir)) return [];

    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }

    const messages: StoredMessage[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        const doc = JSON.parse(raw) as Partial<LocalSessionDoc>;
        if (!Array.isArray(doc.messages)) continue;

        for (const m of doc.messages) {
          const timestamp =
            typeof m.timestamp === 'number'
              ? m.timestamp
              : Date.parse(m.dateCreated) || 0;
          const text = String(m.text ?? '');
          const senderName = String(m.sender ?? 'unknown');

          // Dedup key
          const dedupeKey = `${timestamp}:${senderName}:${text}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          messages.push({
            senderName,
            timestamp,
            text,
            direction: m.direction,
            seq: m.seq,
          });
        }
      } catch {
        // lewati berkas rusak
      }
    }

    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages;
  }

  hasSession(chatId: string, sessionFileName: string): boolean {
    return fs.existsSync(path.join(this.sessionsDir(chatId), sessionFileName));
  }

  listUnsyncedSessions(chatId: string): Array<{ fileName: string; doc: LocalSessionDoc }> {
    const dir = this.sessionsDir(chatId);
    if (!fs.existsSync(dir)) return [];

    const result: Array<{ fileName: string; doc: LocalSessionDoc }> = [];
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const doc = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as LocalSessionDoc;
        if (!doc.syncedToPod && doc.messages && doc.messages.length > 0) {
          result.push({ fileName: file, doc });
        }
      }
    } catch {
      // ignore
    }
    return result;
  }

  markSessionSynced(chatId: string, sessionFileName: string, syncedAt?: string): void {
    const sessionPath = path.join(this.sessionsDir(chatId), sessionFileName);
    if (!fs.existsSync(sessionPath)) return;

    try {
      const doc = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as LocalSessionDoc;
      doc.syncedToPod = true;
      doc.syncedAt = syncedAt ?? new Date().toISOString();
      writeJsonAtomic(sessionPath, doc);

      const key = `${chatId}:${sessionFileName}`;
      if (this.activeSessions.has(key)) {
        this.activeSessions.set(key, doc);
      }
    } catch {
      // ignore
    }
  }

  saveRemoteSession(chatId: string, sessionFileName: string, remoteDoc: any): boolean {
    const dir = this.sessionsDir(chatId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const sessionPath = path.join(dir, sessionFileName);
    if (fs.existsSync(sessionPath)) return false;

    const normalizedDoc: LocalSessionDoc = {
      '@context': remoteDoc['@context'] ?? 'https://schema.org/',
      '@type': 'Conversation',
      identifier: chatId,
      sessionId: sessionFileName,
      dateCreated: remoteDoc.dateCreated ?? new Date().toISOString(),
      dateModified: remoteDoc.dateModified ?? new Date().toISOString(),
      syncedToPod: true,
      syncedAt: new Date().toISOString(),
      participants: Array.isArray(remoteDoc.participants) ? remoteDoc.participants : [],
      messages: Array.isArray(remoteDoc.messages)
        ? remoteDoc.messages.map((m: any, idx: number) => ({
            '@type': 'Message' as const,
            identifier: m.identifier ?? `msg-${String(idx + 1).padStart(3, '0')}`,
            sender: m.sender ?? 'unknown',
            direction: m.direction ?? 'received',
            dateCreated: m.dateCreated ?? new Date().toISOString(),
            timestamp: Date.parse(m.dateCreated) || Date.now(),
            seq: m.seq ?? idx + 1,
            text: m.text ?? '',
          }))
        : [],
    };

    writeJsonAtomic(sessionPath, normalizedDoc);
    return true;
  }

  loadChatMetadata(chatId: string): ChatMetadata | null {
    const metaPath = this.metadataPath(chatId);
    if (!fs.existsSync(metaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ChatMetadata;
    } catch {
      return null;
    }
  }

  saveChatMetadata(chatId: string, metadata: ChatMetadata): void {
    writeJsonAtomic(this.metadataPath(chatId), metadata);
  }
}
