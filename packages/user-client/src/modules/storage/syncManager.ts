// packages/user-client/src/modules/storage/syncManager.ts
// Sinkronisasi dua arah antara penyimpanan disk lokal (Local-First) dan Solid Pod.
// 1. Push: Mengunggah berkas sesi lokal yang belum tersinkronisasi ke Solid Pod.
// 2. Pull: Mengunduh berkas sesi & metadata dari Solid Pod yang belum tersimpan di lokal.

import type { SolidClient } from '../pod/solidClient';
import type { ChatMetadata, LocalStorage, LocalSessionDoc } from './localStorage';

export interface SyncResult {
  status: 'synced' | 'pod_disabled' | 'pod_unreachable' | 'error';
  pushed: number;
  pulled: number;
  error?: string;
}

export interface SyncAllResult {
  status: 'synced' | 'pod_disabled' | 'pod_unreachable' | 'error';
  chatsSynced: number;
  pushed: number;
  pulled: number;
  error?: string;
}

export class SyncManager {
  private syncing = false;
  private timer: NodeJS.Timeout | null = null;
  private pod: SolidClient | null;

  constructor(
    private readonly localStorage: LocalStorage,
    pod: SolidClient | null
  ) {
    this.pod = pod;
  }

  setPodClient(pod: SolidClient | null): void {
    this.pod = pod;
  }

  private async syncSingleChatUnlocked(chatId: string): Promise<{ pushed: number; pulled: number }> {
    const pod = this.pod!;
    let pushed = 0;
    let pulled = 0;

    // 1. PUSH: Unggah sesi lokal yang belum tersinkronisasi
    const unsynced = this.localStorage.listUnsyncedSessions(chatId);
    for (const { fileName, doc } of unsynced) {
      if (doc.messages && doc.messages.length > 0) {
        await pod.saveRawSessionDocument(chatId, fileName, doc);
        this.localStorage.markSessionSynced(chatId, fileName);
        pushed++;
      }
    }

    // Perbarui metadata chat di Solid Pod bila ada di lokal
    const localMeta = this.localStorage.loadChatMetadata(chatId);
    if (localMeta) {
      await pod.saveChatMetadata(chatId, localMeta).catch(() => undefined);
    }

    // 2. PULL: Unduh sesi dari Solid Pod yang belum ada di penyimpanan lokal
    const remoteSessions = await pod.listChatSessionFiles(chatId).catch(() => []);
    for (const remote of remoteSessions) {
      if (!this.localStorage.hasSession(chatId, remote.fileName)) {
        const doc = (await pod.fetchRawJson(remote.url).catch(() => null)) as Partial<LocalSessionDoc> | null;
        if (doc && Array.isArray(doc.messages)) {
          const saved = this.localStorage.saveRemoteSession(chatId, remote.fileName, doc);
          if (saved) {
            pulled++;
          }
        }
      }
    }

    // Tarik metadata.json dari Pod bila lokal belum punya (mis. device baru)
    if (!localMeta && remoteSessions.length > 0) {
      const remoteMeta = (await pod.fetchChatMetadata(chatId).catch(() => null)) as ChatMetadata | null;
      if (remoteMeta && remoteMeta.identifier) {
        this.localStorage.saveChatMetadata(chatId, remoteMeta);
      }
    }

    return { pushed, pulled };
  }

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
    try {
      const reachable = await this.pod.ping();
      if (!reachable) {
        return { status: 'pod_unreachable', pushed: 0, pulled: 0 };
      }

      await this.pod.login();
      const { pushed, pulled } = await this.syncSingleChatUnlocked(chatId);
      return { status: 'synced', pushed, pulled };
    } catch (err: any) {
      return { status: 'error', pushed: 0, pulled: 0, error: err.message };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Menyinkronkan seluruh percakapan (lokal & remote di Solid Pod).
   */
  async syncAll(): Promise<SyncAllResult> {
    if (!this.pod) {
      return { status: 'pod_disabled', chatsSynced: 0, pushed: 0, pulled: 0 };
    }

    if (this.syncing) {
      return { status: 'synced', chatsSynced: 0, pushed: 0, pulled: 0 };
    }

    this.syncing = true;
    let totalPushed = 0;
    let totalPulled = 0;
    let chatsSynced = 0;

    try {
      const reachable = await this.pod.ping();
      if (!reachable) {
        return { status: 'pod_unreachable', chatsSynced: 0, pushed: 0, pulled: 0 };
      }

      await this.pod.login();

      const localIds = this.localStorage.listChatIds();
      const remoteIds = await this.pod.listChatIds().catch(() => []);
      const allIds = Array.from(new Set([...localIds, ...remoteIds]));

      for (const chatId of allIds) {
        const { pushed, pulled } = await this.syncSingleChatUnlocked(chatId);
        totalPushed += pushed;
        totalPulled += pulled;
        chatsSynced++;
      }

      return { status: 'synced', chatsSynced, pushed: totalPushed, pulled: totalPulled };
    } catch (err: any) {
      return { status: 'error', chatsSynced, pushed: totalPushed, pulled: totalPulled, error: err.message };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Memulai timer berkala di latar belakang untuk sinkronisasi otomatis.
   */
  startPeriodicSync(chatId: string, intervalMs = 25000, onSync?: (res: SyncResult) => void): () => void {
    this.stopPeriodicSync();

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
      this.stopPeriodicSync();
    };
  }

  stopPeriodicSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
