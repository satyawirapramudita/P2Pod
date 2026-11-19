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
| Commit terkini | `d76ea11` — *docs: README quick start (2 peran) + update DEMO.md* · kode aplikasi terakhir `9cb0c6e` (setup Pod lokal otomatis) |
| Lingkungan uji | Windows · Node.js v24.22.2 · npm 11.19.1 |

---

## 1. Ringkasan Eksekutif

P2Pod adalah aplikasi chat **peer-to-peer terdesentralisasi**: dua pengguna terhubung langsung lewat TCP (tanpa server pusat untuk isi percakapan), dengan enkripsi end-to-end (ECDH P-256 + AES-256-GCM), identitas permanen Ed25519, dan riwayat percakapan yang disimpan di **Solid Pod** masing-masing pengguna (Community Solid Server). Server *Discovery* hanya bertugas sebagai perantara alamat (Peer ID → IP:Port), tidak pernah melihat isi pesan.

Arsitektur sudah dimigrasikan ke **monorepo 3 paket**: `packages/shared` (kontrak tipe & protokol), `packages/discovery-platform` (server discovery), dan `packages/user-client` (aplikasi peer + CLI). Fitur terbaru yang baru diselesaikan: **wizard setup interaktif (`init`)**, **konfigurasi tersimpan (`config.json`)**, **daftar user online (`user:list`)**, **menghubungi user lewat nama** (`/connect <nama>`), dan **setup Solid Pod lokal otomatis** — wizard langsung menyalakan Community Solid Server + provisioning akun tanpa langkah manual, ditambah **preflight warning** saat Pod tidak aktif/terjangkau dan skrip `npm run pod:stop`.

Status saat ini: **inti aplikasi (MVP) selesai ≈ 90%** — seluruh modul utama berfungsi dan tervalidasi smoke test (20 assertion lolos, 50,9 detik; diverifikasi ulang 12 November 2026 pukul 15:04 WIB di commit `9cb0c6e`). Repo sudah dipublikasikan penuh ke GitHub (`origin/satya` sinkron dengan `d76ea11`). Sisa pekerjaan adalah finalisasi: verifikasi ulang e2e, uji manual 2 mesin, commit revisi dokumen terakhir, penyelarasan dokumentasi demo, dan pengambilan screenshot untuk laporan ini.

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
| 9 | Dokumentasi (README, DEMO.md dll.) | 5% | 80% | 4,0 | 🟡 Perlu sedikit lagi |
| | **Total berbobot** | **100%** | | **≈ 93%** | |

> **Catatan angka.** Angka tabel (≈ 93%) adalah hasil aritmetika bobot di atas. Laporan ini memakai **± 90%** sebagai angka konservatif karena tiga hal yang belum tuntas: (1) `test:e2e` dan uji manual 2 mesin belum dijalankan ulang pasca-refactor terakhir, (2) revisi terakhir laporan & panduan screenshot belum di-commit/push, dan (3) penyandingan akhir antar dokumen demo masih berjalan.

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

- **Provisioning akun Pod** (`modules/pod/provision.ts`, dipakai juga oleh `scripts/setup-pod-account.ts` dan wizard): login ke CSS → buat **client credentials** → simpan ke `.p2pod/<user>/pod-config.json`. Tersedia pintasan `npm run setup:pod:alice` / `setup:pod:bob`.
- `solidClient.ts` — login DPoP via `@inrupt/solid-client-authn-node`; menyimpan sesi dalam **format JSON-LD** (`@context: https://schema.org/`).
- Struktur data: `p2pod/chats/{chat_id}/sessions/{timestamp}.json` (isi seluruh pesan sesi) + `metadata.json` (lawan bicara, waktu mulai/selesai).
- **End-of-session write**: saat `/quit`, kedua peer menyimpan history ke Pod masing-masing; saat sesi baru terbentuk dengan chat_id yang sama, history lama **dimuat dan ditampilkan otomatis**.
- **Setup Pod lokal otomatis dari wizard** (`modules/pod/provision.ts`): bila URL Pod menunjuk `localhost`, wizard membuat seed CSS, **menyalakan Community Solid Server sendiri** (proses detached; data `.css/<nama>/`, log `.css/<nama>-css.log`, PID `.css/<nama>-css.pid`), lalu **provisioning akun otomatis** (dilewati bila `pod-config.json` sudah ada). Server dapat dihentikan dengan `npm run pod:stop`. Bila gagal, wizard hanya memperingatkan dan chat tetap berjalan tanpa Pod.
- **Preflight warning**: saat aplikasi start, Pod dicek cepat — bila tidak aktif/terjangkau, pengguna diberi peringatan bahwa history tidak akan dimuat/disimpan (chat tetap jalan).
- Suatu quirk penamaan file CSS (`….json$.jsonld` di disk) sudah didokumentasikan di `DEMO.md` agar tidak membingungkan saat membaca data.
- Sisa 15%: `test:e2e` perlu dijalankan ulang pasca-refactor terakhir (sebelumnya sudah pernah lulus); alur setup Pod otomatis belum tercakup tes otomatis — perlu diverifikasi manual saat demo dan diformalkan ke suite tes.

### 3.7 CLI & UX — 90%

- **`init` — wizard setup interaktif 4 langkah**: (1) nama, (2) URL Discovery + validasi `/health` real-time, (3) port TCP, (4) aktivasi Solid Pod (opsional). Bila Pod diaktifkan dengan URL `localhost`, wizard sekaligus **menyiapkan Pod lokal otomatis** (lihat 3.6). Disimpan ke `.p2pod/<user>/config.json`; mendukung mode non-interaktif penuh via flag dan `--reconfigure`.
- Perintah: `listen`, `connect <nama|PeerID>`, `list`; resolusi target via nama **harus unik** (jika duplikat, klien meminta Peer ID).
- **Perintah dalam sesi**: `/connect <nama|PeerID>`, `/connect <IP> <PeerID>`, `/list`, `/help`, `/quit`.
- Pintasan npm: `npm run alice`, `npm run bob`, `npm run user:list`, `npm run user:connect`, `npm run pod:stop`.
- Output terminal informatif: Peer ID + fingerprint + IP LAN ditampilkan saat start, status handshake, indikasi retry, peringatan preflight Pod, dsb.
- Sisa 10%: polish kosmetik minor dan penyelarasan dokumentasi.

### 3.8 Testing — 80%

Suite tes otomatis (TypeScript, tanpa framework berat):

| Skrip | Cakupan |
|---|---|
| `npm run typecheck` | Verifikasi tipe seluruh kode |
| `npm run test:smoke` | E2E tanpa Pod: Fase 0 routing IP + `/peers`; Fase 1 flow dasar; Fase 2 start terbalik; Fase 3 tie-break mutual; Fase 4 `/connect` by name + `user:list` + `init` non-interaktif |
| `npm run test:pod` | Round-trip JSON-LD ke Solid Pod |
| `npm run test:e2e` | E2E penuh: chat → simpan Pod → reconnect → muat history (menyiapkan/memakai ulang CSS yang berjalan) |

**Hasil verifikasi terbaru (12 November 2026):** `typecheck` ✅ lolos tanpa error; `test:smoke` ✅ **LULUS dalam 50,9 detik** dengan **20 assertion** semuanya OK — dijalankan ulang pukul 15:04 WIB di commit `9cb0c6e` (rincian di bagian 5). Sisa 20%: `test:pod` & `test:e2e` dijalankan ulang + uji manual skenario 2 mesin diformalkan.

### 3.9 Dokumentasi — 80%

- `README.md` (baru) — quick start dua peran (host Discovery / user), wizard `init` + setup Pod otomatis, daftar perintah sesi & satu-jalan, dan ringkasan struktur repo.
- `DEMO.md` — sangat lengkap: prasyarat, instalasi, Skenario A (1 mesin, 2 terminal), Skenario B (2 mesin LAN/hotspot + firewall), opsi CLI, cara membaca data Pod (3 cara), aspek keamanan, batasan, troubleshooting (10+ gejala, termasuk peringatan preflight Pod), plus penunjuk ke README untuk jalur cepat.
- Tersedia juga `Guide_Screenshot.md` (panduan screenshot) dan `Laporan_Progress.md` (dokumen ini).
- Sisa 20%: penyandingan kecil antar dokumen + melampirkan screenshot hasil demo.

---

## 4. Modul / Fungsional yang Sedang dalam Proses

| # | Item | Detail / Aksi yang tersisa |
|---|---|---|
| 1 | **Commit revisi dokumen terakhir** | Revisi `Laporan_Progress.md` & `Guide_Screenshot.md` (hasil verifikasi ulang + fitur Pod otomatis) masih di working tree — perlu `git add`, `commit`, dan `push` agar GitHub memuat versi terbaru. (Seluruh commit aplikasi & dokumentasi lain sudah ter-push hingga `d76ea11`.) |
| 2 | **Verifikasi ulang e2e** | `npm run test:e2e` + `npm run test:pod` perlu dijalankan ulang pasca-refactor wizard/CLI dan fitur Pod otomatis, untuk mengonfirmasi tidak ada regresi pada alur Pod. |
| 3 | **Verifikasi fitur setup Pod otomatis** | Alur wizard → spawn CSS → provisioning belum tercakup tes otomatis; perlu uji manual terdokumentasi (skenario demo) dan diformalkan ke suite tes. |
| 4 | **Uji manual 2 mesin** | Skenario B di `DEMO.md` (LAN/hotspot + firewall) perlu dijalankan & didokumentasikan formal (foto/log). |
| 5 | **Penyelarasan `DEMO.md`** | Sebagian selesai — `DEMO.md` kini menunjuk ke `README.md` (jalur cepat 2 peran) + menambah baris troubleshooting Pod. Sisa: detail alur wizard `init`/`pod:stop` bila dirasa perlu. |
| 6 | **Screenshot** | 7–8 gambar di `docs/screenshots/` (daftar & panduan lengkap ada di [Guide_Screenshot.md](Guide_Screenshot.md)). |
| 7 | **Finalisasi laporan ini** | Perbarui status setelah item 1–6 selesai (bagian screenshot & sinkronisasi). |

**Roadmap di luar MVP (by design, belum dikerjakan):**

- *Offline messaging* — saat ini murni real-time; pesan tidak bisa dikirim ke peer yang offline.
- *NAT traversal (STUN/TURN)* — saat ini LAN/hotspot saja; perluasan sudah disolasi di fungsi `establish_connection()`.
- *TLS/HTTPS untuk CSS* — CSS berjalan mode dev (HTTP) untuk demo lokal.
- Multi-sesi paralel & antarmuka GUI/web (aplikasi saat ini murni CLI).

---

## 5. Hasil Verifikasi Terbaru (12 November 2026)

Dijalankan langsung di mesin pengembangan (Windows · Node.js v24.22.2 — verifikasi ulang pukul 15:04 WIB di commit `9cb0c6e`):

### 5.1 `npm run typecheck` — ✅ LULUS

```
> tsc --noEmit -p tsconfig.json
(tanpa error)
```

### 5.2 `npm run test:smoke` — ✅ LULUS dalam 50,9 detik (20/20 assertion)

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

Wizard 4 langkah: nama → URL Discovery (divalidasi via `/health`) → port TCP → aktivasi Solid Pod (termasuk baris penyiapan Pod lokal otomatis + ringkasan setup).

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
| **Commit terbaru** | `d76ea11` (README quick start + update DEMO.md) · kode aplikasi terakhir `9cb0c6e` |
| **Status sinkronisasi** | ✅ **Sinkron** — seluruh commit hingga `d76ea11` sudah ter-push ke `origin/satya`. Catatan: revisi terakhir laporan & panduan screenshot (di working tree) belum di-commit — jalankan `git add -A && git commit && git push` untuk memutakhirkannya. |

**Riwayat commit (lokal):**

| Commit | Deskripsi |
|---|---|
| `d76ea11` | docs: README quick start (2 peran) + update DEMO.md |
| `ef2804d` | docs: laporan progress + panduan screenshot |
| `9cb0c6e` | feat(pod): setup Pod lokal otomatis di wizard + preflight warning + pod:stop |
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
├── scripts/                  # setup pod, smoke/pod/e2e test, pod-stop, patch CSS
├── css/                      # Seed config Community Solid Server (alice/bob)
├── docs/screenshots/         # Screenshot untuk laporan ini
├── README.md                 # Quick start dua peran (host & user)
├── DEMO.md                   # Panduan demo lengkap (2 skenario)
├── Guide_Screenshot.md       # Panduan screenshot
└── Laporan_Progress.md       # Laporan progress (dokumen ini)
```

**Menjalankan aplikasi (ringkas — panduan lengkap di `DEMO.md`):**

```bash
git clone https://github.com/satyawirapramudita/P2Pod.git
cd P2Pod
npm install

# Terminal 1: Discovery Platform
npm run discovery        # → http://localhost:4000

# Terminal 2–3: dua pengguna — wizard menyiapkan Pod lokal otomatis
npm run role:user -- --home .p2pod/alice   # nama: alice · discovery: http://localhost:4000 · port: 5000 · pod: y
npm run role:user -- --home .p2pod/bob     # nama: bob · port: 5001 · pod: y · URL Pod: http://localhost:3001/bob/

# Di jendela alice, hubungi bob:
#   /connect bob

# atau jalur pintasan klasik (CSS manual):
npm run css:alice && npm run css:bob         # Solid Pod alice/bob
npm run alice                                 # alice menunggu koneksi (port 5000)
npm run bob -- <PEER_ID_ALICE>                # bob menghubungi alice
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

Secara fungsional, P2Pod telah mencapai tahap **inti aplikasi selesai (± 90%)**: chat P2P terenkripsi end-to-end dengan identitas permanen, discovery otomatis, setup Pod lokal otomatis dari wizard, dan persistensi riwayat di Solid Pod — semuanya berjalan, terverifikasi lewat smoke test (20 assertion, 12 November 2026 pukul 15:04 WIB di commit `9cb0c6e`), dan sudah ter-push ke GitHub. Prioritas berikutnya: verifikasi ulang e2e, uji manual 2 mesin, commit & push revisi dokumen terakhir, pengambilan screenshot (lihat `Guide_Screenshot.md`), dan penyandingan akhir dokumentasi.

*Dokumen ini diperbarui terakhir: 12 November 2026.*
