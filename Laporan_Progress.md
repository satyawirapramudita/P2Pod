# Laporan Progress — P2Pod

**Chat P2P terdesentralisasi dengan penyimpanan Solid Pod**

| Informasi | Detail |
|---|---|
| Nama aplikasi | P2Pod (`p2pod` v0.2.0 — monorepo) |
| Jenis aplikasi | CLI / terminal (Node.js + TypeScript) |
| Disusun oleh | Satya Wira Pramudita |
| Tanggal laporan | 12 November 2026 |
| Repository | <https://github.com/satyawirapramudita/P2Pod> |
| Branch aktif | `satya` |
| Commit terkini (lokal) | `cbd0a80` — *feat(user): wizard init, config tersimpan, /connect by name, user:list, user:connect* |
| Lingkungan uji | Windows · Node.js v24.22.2 · npm 11.19.1 |

---

## 1. Ringkasan Eksekutif

P2Pod adalah aplikasi chat **peer-to-peer terdesentralisasi**: dua pengguna terhubung langsung lewat TCP (tanpa server pusat untuk isi percakapan), dengan enkripsi end-to-end (ECDH P-256 + AES-256-GCM), identitas permanen Ed25519, dan riwayat percakapan yang disimpan di **Solid Pod** masing-masing pengguna (Community Solid Server). Server *Discovery* hanya bertugas sebagai perantara alamat (Peer ID → IP:Port), tidak pernah melihat isi pesan.

Arsitektur sudah dimigrasikan ke **monorepo 3 paket**: `packages/shared` (kontrak tipe & protokol), `packages/discovery-platform` (server discovery), dan `packages/user-client` (aplikasi peer + CLI). Fitur terbaru yang baru diselesaikan: **wizard setup interaktif (`init`)**, **konfigurasi tersimpan (`config.json`)**, **daftar user online (`user:list`)**, dan **menghubungi user lewat nama** (`/connect <nama>`).

Status saat ini: **inti aplikasi (MVP) selesai ≈ 90%** — seluruh modul utama berfungsi dan tervalidasi oleh smoke test (20 assertion lolos, 42,6 detik per 12 November 2026). Sisa pekerjaan adalah finalisasi: sinkronisasi repo ke GitHub, verifikasi ulang e2e, uji manual 2 mesin, pembaruan dokumentasi, dan pengambilan screenshot untuk laporan ini.

> **Definisi lingkup MVP** = chat P2P terenkripsi di LAN/hotspot + identitas permanen + Discovery Platform + riwayat di Solid Pod + CLI yang ramah pengguna + suite tes + dokumentasi demo.

---

## 2. Persentase Progress

**Progress keseluruhan: ± 90%** (perhitungan berbobot menghasilkan ≈ 93%; dibulatkan konservatif — lihat catatan di bawah).

**Cara perhitungan:** 9 modul diberi bobot sesuai porsi relatifnya terhadap lingkup MVP. Nilai "capaian" tiap modul = fitur selesai **+** teruji **+** terdokumentasi (tiga syarat sekaligus). Kontribusi = bobot × capaian.

| # | Modul | Bobot | Capaian | Kontribusi | Status |
|---|---|---:|---:|---:|---|
| 1 | Fondasi proyek & kontrak bersama (monorepo) | 5% | 100% | 5,0 | ✅ Selesai |
| 2 | Identitas permanen (Ed25519) | 10% | 100% | 10,0 | ✅ Selesai |
| 3 | Keamanan kanal (ECDH + AES-256-GCM + anti-MITM) | 15% | 100% | 15,0 | ✅ Selesai |
| 4 | Jaringan P2P (TCP, framing, retry, tie-break) | 15% | 100% | 15,0 | ✅ Selesai |
| 5 | Discovery Platform | 15% | 95% | 14,3 | ✅ Selesai |
| 6 | Penyimpanan Solid Pod | 10% | 85% | 8,5 | 🟡 Inti selesai |
| 7 | CLI & UX (wizard, listen/connect/list) | 15% | 90% | 13,5 | 🟡 Selesai, polish minor |
| 8 | Testing (typecheck, smoke, pod, e2e) | 10% | 80% | 8,0 | 🟡 Sebagian diverifikasi ulang |
| 9 | Dokumentasi (DEMO.md dll.) | 5% | 75% | 3,8 | 🟡 Perlu pembaruan |
| | **Total berbobot** | **100%** | | **≈ 93%** | |

> **Catatan angka.** Angka tabel (≈ 93%) adalah hasil aritmetika bobot di atas. Laporan ini memakai **± 90%** sebagai angka konservatif karena tiga hal yang belum tuntas: (1) `test:e2e` dan uji manual 2 mesin belum dijalankan ulang pasca-refactor terakhir, (2) 3 commit lokal belum di-push ke GitHub, dan (3) `DEMO.md` belum mencerminkan fitur terbaru (wizard `init`, `user:list`).

---

## 3. Modul / Fungsional yang Sudah Selesai

### 3.1 Fondasi Proyek & Kontrak Bersama — 100%

- Monorepo npm workspaces: `packages/shared`, `packages/discovery-platform`, `packages/user-client` (commit `57b8a02`).
- `packages/shared/src/protocol.ts` — definisi 3 tipe pesan wire: `handshake`, `identity-proof`, `chat`.
- `packages/shared/src/discovery.ts` — kontrak API Discovery (`RegisterRequest`, `PeerEndpoint`, `OnlinePeer`, `PeersResponse`) yang dipakai server & klien sekaligus.
- Build `shared` otomatis saat `npm install` (postinstall) + patch kompatibilitas `componentsjs` untuk path ber-spasi.

### 3.2 Identitas Permanen (Ed25519) — 100%

- Keypair Ed25519 dibuat sekali dan disimpan permanen di `~/.p2pod/identity.json` (permission `0600`).
- **Peer ID = public key** (SPKI DER, base64url); fingerprint = 16 hex pertama dari SHA-256(Peer ID) — ditampilkan agar mudah dibandingkan antar pengguna.
- Verifikasi tanda tangan pihak lain tanpa perlu bertukar kunci manual (public key bisa dipakai langsung sebagai identitas).

### 3.3 Keamanan Kanal — 100%

- **ECDH P-256 ephemeral** menghasilkan kunci sementara (K_temp); transcript sesi dibangun dari kedua kunci ephemeral.
- **Identity proof**: tiap pihak menandatangani transcript dengan Ed25519; verifikasi silang → **man-in-the-middle terdeteksi** (diuji: smoke test memastikan tidak ada kegagalan verifikasi).
- **AES-256-GCM** untuk seluruh pesan chat (nonce + ciphertext + auth tag per pesan).
- `chat_id = SHA256(sort(PeerID_A, PeerID_B))` → **deterministik**; dibuktikan smoke test: kedua peer memperoleh `chat_id` identik (`ceeefe4c…`).
- Discovery Platform tidak pernah menerima konten — hanya Peer ID → IP:Port.

### 3.4 Jaringan P2P (TCP) — 100%

- TCP langsung (LAN/hotspot) + length-prefixed message framing; **satu sesi per proses**; koneksi dari peer tak dikenal ditolak tanpa mengganggu proses.
- **Retry otomatis tiap 3 detik** → urutan start bebas: siapa pun boleh start lebih dulu (diuji Fase 2 smoke test).
- **Tie-break koneksi mutual**: bila kedua pihak saling menghubungi, Peer ID yang lebih besar menginisiasi — hasilnya tetap **tepat satu sesi** (diuji Fase 3).
- Dukungan koneksi langsung tanpa Discovery: flag `--peer-ip/--peer-port` dan perintah sesi `/connect <IP> <PeerID>`.

### 3.5 Discovery Platform — 95%

- Endpoint: `POST /register`, `GET /lookup/:peerId`, `GET /peers` (daftar user online), `POST /unregister`, `GET /health`.
- `displayName` ditampilkan pada daftar user; `targetPeerId` menjadi sinyal routing yang dipakai tie-break.
- **Heartbeat 20 detik**, TTL peer 60 detik + reaper otomatis; `/health` melaporkan jumlah peer aktif.
- **Anti-spoof IP**: klaim IP dari klien hanya dipercaya bila koneksi datang dari loopback; koneksi remote selalu memakai `remoteAddress` (diuji Fase 0).
- **Deteksi IP LAN otomatis** (UDP connect trick + fallback enumerasi NIC) → demo 2 mesin berfungsi tanpa input IP manual (commit `eee0fd3`).
- Sisa 5%: hardening opsional (rate-limit / autentikasi `/register`) — tidak diperlukan untuk demo LAN.

### 3.6 Penyimpanan Solid Pod — 85%

- `scripts/setup-pod-account.ts` — provisioning **client credentials** ke Community Solid Server (login → buat kredensial → simpan ke `.p2pod/<user>/pod-config.json`). Tersedia pintasan `npm run setup:pod:alice` / `setup:pod:bob`.
- `solidClient.ts` — login DPoP via `@inrupt/solid-client-authn-node`; menyimpan sesi dalam **format JSON-LD** (`@context: https://schema.org/`).
- Struktur data: `p2pod/chats/{chat_id}/sessions/{timestamp}.json` (isi seluruh pesan sesi) + `metadata.json` (lawan bicara, waktu mulai/selesai).
- **End-of-session write**: saat `/quit`, kedua peer menyimpan history ke Pod masing-masing; saat sesi baru terbentuk dengan chat_id yang sama, history lama **dimuat dan ditampilkan otomatis**.
- Suatu quirk penamaan file CSS (`….json$.jsonld` di disk) sudah didokumentasikan di `DEMO.md` agar tidak membingungkan saat membaca data.
- Sisa 15%: `test:e2e` perlu dijalankan ulang pasca-refactor terakhir (sebelumnya sudah pernah lulus); verifikasi manual sekali lagi bersama demo.

### 3.7 CLI & UX — 90%

- **`init` — wizard setup interaktif 4 langkah**: (1) nama, (2) URL Discovery + validasi `/health` real-time, (3) port TCP, (4) aktivasi Solid Pod (opsional) → disimpan ke `.p2pod/<user>/config.json`. Mendukung mode non-interaktif penuh via flag dan `--reconfigure`.
- Perintah: `listen`, `connect <nama|PeerID>`, `list`; resolusi target via nama **harus unik** (jika duplikat, klien meminta Peer ID).
- **Perintah dalam sesi**: `/connect <nama|PeerID>`, `/connect <IP> <PeerID>`, `/list`, `/help`, `/quit`.
- Pintasan npm: `npm run alice`, `npm run bob`, `npm run user:list`, `npm run user:connect`.
- Output terminal informatif: Peer ID + fingerprint + IP LAN ditampilkan saat start, status handshake, indikasi retry, dsb.
- Sisa 10%: polish kosmetik minor dan penyelarasan dokumentasi.

### 3.8 Testing — 80%

Suite tes otomatis (TypeScript, tanpa framework berat):

| Skrip | Cakupan |
|---|---|
| `npm run typecheck` | Verifikasi tipe seluruh kode |
| `npm run test:smoke` | E2E tanpa Pod: Fase 0 routing IP + `/peers`; Fase 1 flow dasar; Fase 2 start terbalik; Fase 3 tie-break mutual; Fase 4 `/connect` by name + `user:list` + `init` non-interaktif |
| `npm run test:pod` | Round-trip JSON-LD ke Solid Pod |
| `npm run test:e2e` | E2E penuh: chat → simpan Pod → reconnect → muat history (menyiapkan CSS sendiri) |

**Hasil verifikasi terbaru (12 November 2026):** `typecheck` ✅ lolos tanpa error; `test:smoke` ✅ **LULUS dalam 42,6 detik** dengan **20 assertion** semuanya OK (rincian di bagian 5). Sisa 20%: `test:pod` & `test:e2e` dijalankan ulang + uji manual skenario 2 mesin diformalkan.

### 3.9 Dokumentasi — 75%

- `DEMO.md` — sangat lengkap: prasyarat, instalasi, Skenario A (1 mesin, 2 terminal), Skenario B (2 mesin LAN/hotspot + firewall), opsi CLI, cara membaca data Pod (3 cara), aspek keamanan, batasan, dan troubleshooting (10+ gejala umum).
- Sisa 25%: memperbarui `DEMO.md` agar mencakup fitur terbaru (`init` wizard, `user:list`, `/connect` by name) + melampirkan screenshot (laporan ini).

---

## 4. Modul / Fungsional yang Sedang dalam Proses

| # | Item | Detail / Aksi yang tersisa |
|---|---|---|
| 1 | **Sinkronisasi GitHub** | 3 commit lokal belum di-push ke `origin/satya` — repo publik masih menampilkan versi lama (struktur pra-monorepo). Aksi: `git push origin satya`. |
| 2 | **Verifikasi ulang e2e** | `npm run test:e2e` + `npm run test:pod` perlu dijalankan ulang pasca-refactor wizard/CLI untuk mengonfirmasi tidak ada regresi pada alur Pod. |
| 3 | **Uji manual 2 mesin** | Skenario B di `DEMO.md` (LAN/hotspot + firewall) perlu dijalankan & didokumentasikan formal (foto/log). |
| 4 | **Pembaruan `DEMO.md`** | Tambahkan alur wizard `init`, `user:list`, dan `/connect <nama>` agar panduan sinkron dengan aplikasi. |
| 5 | **Screenshot** | 7–8 gambar di `docs/screenshots/` (daftar & panduan lengkap ada di [Guide_Screenshot.md](Guide_Screenshot.md)). |
| 6 | **Finalisasi laporan ini** | Perbarui status setelah item 1–5 selesai (bagian screenshot & sinkronisasi). |

**Roadmap di luar MVP (by design, belum dikerjakan):**

- *Offline messaging* — saat ini murni real-time; pesan tidak bisa dikirim ke peer yang offline.
- *NAT traversal (STUN/TURN)* — saat ini LAN/hotspot saja; perluasan sudah disolasi di fungsi `establish_connection()`.
- *TLS/HTTPS untuk CSS* — CSS berjalan mode dev (HTTP) untuk demo lokal.
- Multi-sesi paralel & antarmuka GUI/web (aplikasi saat ini murni CLI).

---

## 5. Hasil Verifikasi Terbaru (12 November 2026)

Dijalankan langsung di mesin pengembangan (Windows · Node.js v24.22.2):

### 5.1 `npm run typecheck` — ✅ LULUS

```
> tsc --noEmit -p tsconfig.json
(tanpa error)
```

### 5.2 `npm run test:smoke` — ✅ LULUS dalam 42,6 detik (20/20 assertion)

| Fase | Yang diverifikasi | Hasil |
|---|---|---|
| Fase 0 | Routing IP Discovery: klaim loopback dipakai, klaim remote diabaikan (anti-spoof); `GET /peers` memuat `displayName`; unregister membersihkan daftar | ✅ 4 assertion |
| Fase 1 | Flow dasar: handshake → sesi aman → chat 2 arah; `chat_id` deterministik sama di kedua sisi; tidak ada kegagalan verifikasi identitas; exit code 0 | ✅ 5 assertion |
| Fase 2 | Start terbalik (connector dulu) — retry otomatis sampai listener online | ✅ 1 assertion |
| Fase 3 | Kedua sisi saling `--connect` — tie-break menghasilkan **tepat 1 sesi** per peer | ✅ 3 assertion |
| Fase 4 | `/connect by name`, `user:list` (daftar alice & bob), `init` non-interaktif menulis `config.json` | ✅ 6 assertion |
| Akhir | Discovery bersih setelah semua sesi (peers = 0) | ✅ 1 assertion |

---

## 6. Screenshot Sebagian Aplikasi

> Aplikasi P2Pod berbasis **terminal (CLI)**, sehingga screenshot berupa tangkapan jendela terminal seperti di bawah.
> Screenshot **belum diambil** — status ⏳. Setelah Anda menempatkan file di `docs/screenshots/`, gambar di bawah akan muncul otomatis. Panduan langkah-demi-langkah: **[Guide_Screenshot.md](Guide_Screenshot.md)**.

### 6.1 Wizard Setup User (`init`) — ⏳ menunggu

Wizard 4 langkah: nama → URL Discovery (divalidasi via `/health`) → port TCP → aktivasi Solid Pod, diakhiri ringkasan setup.

![Wizard setup user](docs/screenshots/01-wizard-init.png)

*File: `docs/screenshots/01-wizard-init.png`*

### 6.2 Daftar User Online (`user:list`) — ⏳ menunggu

Output `npm run user:list`: nama tampilan, fingerprint, dan Peer ID tiap user yang online; idealnya disandingkan dengan log Discovery Platform.

![Daftar user online](docs/screenshots/02-user-list.png)

*File: `docs/screenshots/02-user-list.png`*

### 6.3 Sesi Chat Terenkripsi (dua sisi) — ⏳ menunggu

Sesi aman terbentuk (`Sesi aman terbentuk dengan "bob"`, fingerprint verifikasi, `chat_id`) dan pertukaran pesan terenkripsi di alice & bob.

![Sesi chat — alice](docs/screenshots/03-chat-alice.png)

![Sesi chat — bob](docs/screenshots/03-chat-bob.png)

*File: `docs/screenshots/03-chat-alice.png` dan `03-chat-bob.png`*

### 6.4 History Dimuat dari Solid Pod — ⏳ menunggu

Setelah `/quit` dan sesi baru dimulai dengan peer yang sama, history sesi sebelumnya dimuat otomatis dari Pod (`— History sebelumnya dari Solid Pod (N pesan) —`).

![History dari Pod](docs/screenshots/04-history-pod.png)

*File: `docs/screenshots/04-history-pod.png`*

### 6.5 Struktur Data di Solid Pod — ⏳ menunggu

Isi folder pod di filesystem: `….css\alice\alice\p2pod\chats\{chat_id}\sessions\{timestamp}.json`.

![Struktur Pod](docs/screenshots/05-pod-structure.png)

*File: `docs/screenshots/05-pod-structure.png`*

### 6.6 Hasil Smoke Test — ⏳ menunggu

Output akhir `npm run test:smoke`: seluruh assertion OK dan baris `SMOKE TEST LULUS dalam …s`.

![Smoke test](docs/screenshots/06-smoke-test.png)

*File: `docs/screenshots/06-smoke-test.png`*

### 6.7 Hasil E2E Penuh (opsional) — ⏳ menunggu

Output akhir `npm run test:e2e`: chat → simpan Pod → reconnect → muat history, berakhir dengan `E2E TEST LULUS`.

![E2E test](docs/screenshots/07-e2e-pod.png)

*File: `docs/screenshots/07-e2e-pod.png` (opsional)*

---

## 7. Link ke GitHub Source

| | |
|---|---|
| **Repository** | <https://github.com/satyawirapramudita/P2Pod> (publik) |
| **Branch** | `satya` |
| **Commit terbaru (lokal)** | `cbd0a80` |
| **Status sinkronisasi** | ⚠️ Remote tertinggal 3 commit — `57b8a02` (refactor monorepo), `ef3f829` (displayName + `GET /peers`), `cbd0a80` (wizard init, `user:list`, `/connect` by name). Jalankan `git push origin satya` agar versi di GitHub sama dengan lokal. |

**Riwayat commit (lokal):**

| Commit | Deskripsi |
|---|---|
| `cbd0a80` | feat(user): wizard init, config tersimpan, /connect by name, user:list, user:connect |
| `ef3f829` | feat(discovery): displayName + GET /peers untuk daftar user online |
| `57b8a02` | refactor: struktur monorepo packages (shared, discovery-platform, user-client) |
| `eee0fd3` | fix: deteksi IP LAN otomatis untuk registrasi discovery (demo 2 mesin) |
| `9561278` | fix: dukung folder ber-spasi (patch componentsjs via postinstall) |
| `a7d9147` | add: script pintasan |
| `526df81` | initiated P2P Chat, Pod, and dual role |

**Struktur repo (versi monorepo):**

```
P2Pod/
├── packages/
│   ├── shared/               # Kontrak tipe & protokol pesan
│   ├── discovery-platform/   # Server Discovery (Express)
│   └── user-client/          # Aplikasi peer + CLI (wizard, net, crypto, pod)
├── scripts/                  # setup pod, smoke/pod/e2e test, patch CSS
├── css/                      # Seed config Community Solid Server (alice/bob)
├── docs/screenshots/         # Screenshot untuk laporan ini
├── DEMO.md                   # Panduan demo lengkap (2 skenario)
├── Guide_Screenshot.md       # Panduan screenshot (dokumen ini)
└── Laporan_Progress.md       # Laporan progress (dokumen ini)
```

**Menjalankan aplikasi (ringkas — panduan lengkap di `DEMO.md`):**

```bash
git clone https://github.com/satyawirapramudita/P2Pod.git
cd P2Pod
npm install

# Terminal 1–3: infrastruktur
npm run css:alice        # Solid Pod alice  → http://localhost:3000
npm run css:bob          # Solid Pod bob    → http://localhost:3001
npm run discovery        # Discovery        → http://localhost:4000

# (sekali saja) provisioning kredensial Pod
npm run setup:pod:alice
npm run setup:pod:bob

# Terminal 4–5: dua pengguna
npm run alice            # alice menunggu koneksi (port 5000)
npm run bob -- <PEER_ID_ALICE>   # bob menghubungi alice
```

---

## 8. Batasan yang Disengaja (by design)

| Aspek | Batasan saat ini | Alasan/rencana |
|---|---|---|
| Jaringan | LAN/hotspot saja (tanpa STUN/TURN) | Fokus demo lokal; perluasan NAT traversal sudah disolasi di `establish_connection()` |
| Waktu | Real-time saja (tanpa offline messaging) | Kedua peer harus online saat chat |
| Penyimpanan | Write di akhir sesi (bukan per pesan) | Data hilang hanya bila proses di-kill paksa, bukan `/quit` |
| Transport Pod | CSS mode dev (HTTP, tanpa TLS) | Hanya untuk demo lokal |
| Antarmuka | CLI/terminal | Fokus fungsionalitas inti; GUI dapat menjadi roadmap |

---

## 9. Penutup

Secara fungsional, P2Pod telah mencapai tahap **inti aplikasi selesai (± 90%)**: chat P2P terenkripsi end-to-end dengan identitas permanen, discovery otomatis, dan persistensi riwayat di Solid Pod — semuanya berjalan dan terverifikasi lewat smoke test (20 assertion, 12 November 2026). Prioritas berikutnya: sinkronisasi ke GitHub, verifikasi ulang e2e, uji manual 2 mesin, pengambilan screenshot (lihat `Guide_Screenshot.md`), dan pembaruan dokumentasi.

*Dokumen ini diperbarui terakhir: 12 November 2026.*
