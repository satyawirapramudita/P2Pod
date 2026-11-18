// packages/user-client/src/modules/storage/syncManager.ts
// Sinkronisasi dua arah antara penyimpanan disk lokal (Local-First) dan Solid Pod.
// Menerapkan pola:
// 1. Push: Mengunggah berkas sesi lokal yang belum ada / belum tersinkronisasi ke Solid Pod.
// 2. Pull: Mengunduh berkas sesi dari Solid Pod yang belum tersimpan di disk lokal.

import type { SolidClient } from '../pod/solidClient';
import type { LocalStorage, LocalSessionDoc } from './localStorage';

export interface SyncResult {
  status: 'synced' | 'pod_disabled' | 'pod_unreachable' | 'error';
  pushed: number;
  pulled: number;
  error?: string;
}

export class SyncManager {
  private syncing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly localStorage: LocalStorage,
    private readonly pod: SolidClient | null
  ) {}

  /**
   * Menjalankan siklus sinkronisasi untuk chatId tertentu.
   */
  async sync(chatId: string): Promise<SyncResult> {
    if (!this.pod) {
      return { status: 'pod_disabled', pushed: 0, pulled: 0 };
    }

    if (this.syncing) {
      return { status: 'synced', pushed: 0, pulled: 0 };
    }

    this.syncing = true;
    let pushed = 0;
    let pulled = 0;

    try {
      const reachable = await this.pod.ping();
      if (!reachable) {
        return { status: 'pod_unreachable', pushed: 0, pulled: 0 };
      }

      await this.pod.login();

      // 1. PUSH: Unggah sesi lokal yang belum tersinkronisasi
      const unsynced = this.localStorage.listUnsyncedSessions(chatId);
      for (const { fileName, doc } of unsynced) {
        if (doc.messages && doc.messages.length > 0) {
          await this.pod.saveRawSessionDocument(chatId, fileName, doc);
          this.localStorage.markSessionSynced(chatId, fileName);
          pushed++;
        }
      }

      // Perbarui metadata chat di Solid Pod
      const meta = this.localStorage.loadChatMetadata(chatId);
      if (meta) {
        await this.pod.saveChatMetadata(chatId, meta).catch(() => undefined);
      }

      // 2. PULL: Unduh sesi dari Solid Pod yang belum ada di penyimpanan lokal
      const remoteSessions = await this.pod.listChatSessionFiles(chatId).catch(() => []);
      for (const remote of remoteSessions) {
        if (!this.localStorage.hasSession(chatId, remote.fileName)) {
          const doc = (await this.pod.fetchRawJson(remote.url).catch(() => null)) as Partial<LocalSessionDoc> | null;
          if (doc && Array.isArray(doc.messages)) {
            const saved = this.localStorage.saveRemoteSession(chatId, remote.fileName, doc);
            if (saved) {
              pulled++;
            }
          }
        }
      }

      return { status: 'synced', pushed, pulled };
    } catch (err: any) {
      return { status: 'error', pushed, pulled, error: err.message };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Memulai timer berkala di latar belakang untuk sinkronisasi otomatis.
   * Mengembalikan fungsi unregister untuk membatalkan timer.
   */
  startPeriodicSync(chatId: string, intervalMs = 25000, onSync?: (res: SyncResult) => void): () => void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.timer = setInterval(() => {
      this.sync(chatId)
        .then((res) => {
          if (onSync && (res.pushed > 0 || res.pulled > 0)) {
            onSync(res);
          }
        })
        .catch(() => undefined);
    }, intervalMs);

    this.timer.unref();

    return () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  stopPeriodicSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
