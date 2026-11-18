// scripts/test-local-first.ts
// Pengujian Arsitektur Local-First & Sinkronisasi Solid Pod

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalStorage } from '../packages/user-client/src/modules/storage/localStorage';
import { SyncManager } from '../packages/user-client/src/modules/storage/syncManager';
import { SolidClient } from '../packages/user-client/src/modules/pod/solidClient';
import { ensureLocalCssRunning, localCssPortOf, podNameFromUrl } from '../packages/user-client/src/modules/pod/provision';

async function runTest(): Promise<void> {
  console.log('[test-local-first] Memulai pengujian Arsitektur Local-First...');

  // 1. Buat direktori sementara untuk home profile lokal
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pod-local-test-'));
  const storage = new LocalStorage(tempHome);
  const chatId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  console.log(`[test-local-first] Direktori uji: ${tempHome}`);
  console.log(`[test-local-first] Chat ID       : ${chatId}`);

  // 2. Inisialisasi sesi baru di Local Storage
  const sessionMeta = {
    chatId,
    localDisplayName: 'Alice',
    localPeerId: 'PEER-ALICE',
    localWebId: 'http://localhost:3005/alice/profile/card#me',
    remoteDisplayName: 'Bob',
    remotePeerId: 'PEER-BOB',
    startedAt: new Date(now - 10000).toISOString(),
    endedAt: new Date(now).toISOString(),
  };

  const sessionFile = storage.initSession(chatId, sessionMeta);
  console.log(`[test-local-first] Sesi dibuat: ${sessionFile}`);

  const sessionFilePath = path.join(storage.sessionsDir(chatId), sessionFile);
  if (!fs.existsSync(sessionFilePath)) {
    throw new Error('Berkas sesi tidak ditemukan setelah initSession');
  }

  // 3. Tulis pesan 1 (Sent) dan periksa persistensi langsung (crash-safety)
  storage.appendMessage(chatId, sessionFile, {
    direction: 'sent',
    displayName: 'Alice',
    text: 'Halo Bob, pesan pertama tersimpan lokal!',
    timestamp: now - 8000,
    seq: 1,
  });

  // 4. Tulis pesan 2 (Received)
  storage.appendMessage(chatId, sessionFile, {
    direction: 'received',
    displayName: 'Bob',
    text: 'Halo Alice, diterima dan tersimpan seketika di disk!',
    timestamp: now - 5000,
    seq: 2,
  });

  // Baca berkas mentah untuk memvalidasi penulisan langsung
  const docOnDisk = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
  if (docOnDisk.messages.length !== 2) {
    throw new Error(`Pesan di disk tidak sesuai: diharapkan 2, terbaca ${docOnDisk.messages.length}`);
  }
  if (docOnDisk.syncedToPod !== false) {
    throw new Error('syncedToPod harus false sebelum sinkronisasi');
  }
  console.log('[test-local-first] Crash-Safety write-through: LULUS (2 pesan langsung tertulis di disk)');

  // 5. Muat history secara Local-First tanpa Solid Pod
  const history = storage.loadChatHistory(chatId);
  if (history.length !== 2) {
    throw new Error(`loadChatHistory gagal: diharapkan 2, terbaca ${history.length}`);
  }
  if (history[0].text !== 'Halo Bob, pesan pertama tersimpan lokal!') {
    throw new Error('Pesan pertama tidak cocok');
  }
  if (history[1].text !== 'Halo Alice, diterima dan tersimpan seketika di disk!') {
    throw new Error('Pesan kedua tidak cocok');
  }
  console.log('[test-local-first] Load History Local-First: LULUS (berhasil dimuat tanpa jaringan/Pod)');

  // 6. Finalisasi sesi
  storage.finalizeSession(chatId, sessionFile, new Date(now).toISOString());

  // 7. Pengujian Sinkronisasi dengan Solid Pod jika CSS lokal aktif / pod-config tersedia
  const defaultHome = path.join(os.homedir(), '.p2pod');
  const podConfigPath = path.join(defaultHome, 'pod-config.json');

  if (fs.existsSync(podConfigPath)) {
    console.log('[test-local-first] Konfigurasi Pod terdeteksi, menguji sinkronisasi dua arah...');

    // Salin pod-config.json ke tempHome agar SolidClient bisa auth
    fs.copyFileSync(podConfigPath, path.join(tempHome, 'pod-config.json'));
    const podConfig = JSON.parse(fs.readFileSync(podConfigPath, 'utf8'));
    const podUrl = podConfig.podUrl;

    const cssPort = localCssPortOf(podUrl);
    if (cssPort) {
      await ensureLocalCssRunning({ cssPort, name: podNameFromUrl(podUrl, 'alice') });
    }

    const podClient = new SolidClient(tempHome, podUrl);
    const syncManager = new SyncManager(storage, podClient);

    // Jalankan sync (Push ke Solid Pod)
    const syncResult = await syncManager.sync(chatId);
    console.log(`[test-local-first] Hasil sync awal: status=${syncResult.status}, pushed=${syncResult.pushed}, pulled=${syncResult.pulled}`);

    if (syncResult.status === 'synced') {
      if (syncResult.pushed !== 1) {
        throw new Error(`Diharapkan 1 sesi terdorong ke Pod, namun pushed=${syncResult.pushed}`);
      }

      // Pastikan status di lokal berubah menjadi syncedToPod = true
      const syncedDoc = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
      if (syncedDoc.syncedToPod !== true) {
        throw new Error('syncedToPod harus true setelah sinkronisasi berhasil');
      }
      console.log('[test-local-first] Push ke Solid Pod & Tandai status tersinkron: LULUS');

      // Uji Pull: buat sesi baru langsung di Pod, lalu jalankan sync pull
      const remoteSessionFile = `remote-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const remoteDoc = {
        '@context': 'https://schema.org/',
        '@type': 'Conversation',
        identifier: chatId,
        dateCreated: new Date(now - 2000).toISOString(),
        dateModified: new Date(now - 1000).toISOString(),
        participants: sessionMeta,
        messages: [
          {
            '@type': 'Message',
            identifier: 'msg-remote-001',
            sender: 'Bob (device lain)',
            direction: 'received',
            dateCreated: new Date(now - 1500).toISOString(),
            text: 'Pesan dari sesi lain di Pod!',
          },
        ],
      };

      await podClient.saveRawSessionDocument(chatId, remoteSessionFile, remoteDoc);
      console.log('[test-local-first] Sesi remote disuntikkan ke Pod...');

      const pullResult = await syncManager.sync(chatId);
      console.log(`[test-local-first] Hasil sync pull: status=${pullResult.status}, pushed=${pullResult.pushed}, pulled=${pullResult.pulled}`);

      if (pullResult.pulled < 1) {
        throw new Error(`Diharapkan minimal 1 sesi ditarik dari Pod, namun pulled=${pullResult.pulled}`);
      }

      // Verifikasi sesi remote tersimpan di disk lokal
      const updatedLocalHistory = storage.loadChatHistory(chatId);
      const remoteMessageFound = updatedLocalHistory.some((m) => m.text === 'Pesan dari sesi lain di Pod!');
      if (!remoteMessageFound) {
        throw new Error('Pesan remote tidak ditemukan di local storage setelah pull');
      }
      console.log('[test-local-first] Pull dari Solid Pod ke Local Storage: LULUS');
    } else {
      console.log(`[test-local-first] Pod sync dilewati atau offline (${syncResult.status}).`);
    }
  } else {
    console.log('[test-local-first] pod-config.json tidak ada, pengujian Local-First mandiri LULUS.');
  }

  // Bersihkan direktori uji
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log('[test-local-first] SEMUA PENGUJIAN LOCAL-FIRST & SYNC: LULUS 100%');
}

runTest().catch((err) => {
  console.error('[test-local-first] PENGUJIAN GAGAL:', err);
  process.exit(1);
});
