# P2Pod

Chat P2P terdesentralisasi dengan penyimpanan Solid Pod — **modular monorepo**.

Dua peran utama:

| Peran | Deskripsi |
|---|---|
| **Discovery Platform** | Layanan rendezvous (Express) yang memetakan Peer ID → IP:Port. Tidak menyimpan pesan. |
| **User** | Aplikasi chat CLI: identitas Ed25519 permanen, E2EE AES-256-GCM, riwayat di Solid Pod (opsional). |

## Prasyarat

- Node.js 18+ (diuji di Node 24) & npm
- Satu jaringan LAN/hotspot agar user bisa saling terhubung

## Instalasi

```bash
npm install
```

> `postinstall` mem-patch `componentsjs` (mendukung folder ber-spasi) dan membangun paket `shared`.

---

## Cara 1 — Menjalankan Discovery Platform (Host)

```bash
npm run role:discovery            # default port 4000
npm run role:discovery -- 4100    # port lain (opsional)
```

Server akan menampilkan URL LAN untuk dibagikan, mis. `http://192.168.1.10:4000/` — **bagikan URL ini** ke user yang mau gabung. Banner juga mencetak perintah Windows Firewall siap-pakai (jalankan sekali sebagai Administrator bila device lain tidak bisa connect).

---

## Cara 2 — Menjadi User

```bash
npm run user:add      # buat user baru (wizard) → dijadikan AKTIF → langsung listening
```

Wizard 2 langkah (sisanya otomatis):

1. **Nama** (wajib — tampil di daftar user)
2. **URL Discovery Platform** (mis. `http://192.168.1.10:4000`) — divalidasi otomatis

Otomatis: profil dibuat di `.p2pod/<nama>/` (atau `--home <dir>`), **port TCP 5000** (ubah dengan `--port`) dan **Solid Pod lokal** `http://localhost:3000/<nama>/` yang disiapkan sendiri — CSS dijalankan + akun Pod di-provision. Nonaktifkan Pod dengan `--no-pod`.

Setelah selesai, user otomatis menjadi **profil aktif** dan aplikasi langsung berjalan (listening) menampilkan **Peer ID**, **IP LAN**, serta daftar user online.

**Masuk lagi sebagai user aktif** (tanpa pertanyaan):

```bash
npm run user          # mode CLI terminal
npm run user:web      # mode Web UI di browser (http://127.0.0.1:3333)
```

> Untuk menggunakan Web UI pertama kali (atau setelah mengubah kode `packages/web-ui`), jalankan `npm run build:web` terlebih dahulu agar aset statis disajikan otomatis oleh `npm run user:web`. Untuk mode pengembangan frontend live-reload, jalankan `npm run user:web` di satu terminal dan `npm run dev:web` (`http://127.0.0.1:5173`) di terminal lain.

**Ganti / lihat user di device ini:**

```bash
npm run user:switch              # pilih user aktif (interaktif, --home <path>, atau <nama|nomor>)
npm run user:profiles            # daftar user di device ini
```

**Non-interaktif** (semua nilai dari flag):

```bash
npm run user:add -- --name rani --discovery http://192.168.1.10:4000 --port 5000 --pod http://localhost:3000/rani/
# atau tanpa Pod:
npm run user:add -- --name rani --discovery http://192.168.1.10:4000 --port 5000 --no-pod
```

`npm run role:user` tetap tersedia sebagai alias lama (wizard `init`). Menjalankannya lagi memakai config tersimpan (tanpa prompt); gunakan `--reconfigure` untuk mengubah.

### Perintah di dalam sesi

| Perintah | Fungsi |
|---|---|
| `/connect <nama\|PeerID>` | Hubungi user (nama dari `/list`) |
| `/connect <IP> <PeerID>` | Hubungi langsung tanpa Discovery (TCP langsung) |
| `/list` | Tampilkan user yang sedang online |
| `/sync` | Sinkronkan riwayat chat lokal dengan Solid Pod seketika |
| `/history` | Tampilkan statistik riwayat percakapan lokal & status sync |
| `/help` | Bantuan |
| `/quit` | Akhiri sesi & finalisasi history |

### Perintah satu-jalan

```bash
npm run user:list                            # daftar user online
npm run user:connect -- alice                # hubungi user berdasarkan nama
npm run user:connect -- MCowBQYDK2VwAyEA...  # atau berdasarkan Peer ID
```

### Kelola user di device ini

| Perintah | Fungsi |
|---|---|
| `npm run user` | Masuk sebagai **user aktif** (profil terakhir yang dipilih via `user:switch`; fallback `~/.p2pod`) |
| `npm run user:add` | Buat user baru (wizard) → jadikan **aktif** → mulai listening |
| `npm run user:switch` | Pilih user **aktif** (`-- <nama\|nomor>` atau `--home <path>`; interaktif bila kosong) |
| `npm run user:profiles` | Daftar user (profil) yang ada di device ini: nama, Peer ID, discovery, status pod, path |
| `npm run user:edit` | Ubah info user: `--name <baru>`, `--discovery <url>`, `--port <n>`, `--pod <url>` (aktifkan pod), `--no-pod` (nonaktifkan). Tanpa flag → mode terbimbing |
| `npm run user:remove` | Hapus user dari device ini — konfirmasi dengan mengetik nama, atau `--yes` |

```bash
npm run user
npm run user:add -- --name rani --discovery http://localhost:4000
npm run user:switch -- rani
npm run user:profiles
npm run user:edit -- --home .p2pod/alice --name alice-baru
npm run user:edit -- --pod http://localhost:3000/alice/   # aktifkan Pod kembali
npm run user:remove -- --home .p2pod/alice
```

> `--home` opsional: bila tidak diisi dan ada beberapa user, muncul pilihan interaktif (non-interaktif: error yang menyebutkan path — gunakan `--home`).

---

## Informasi yang Dibutuhkan

**Untuk connect ke Discovery Platform** — satu-satunya input manual:

- URL Discovery Platform (mis. `http://192.168.1.10:4000`)
- Sisanya otomatis: Peer ID (di-generate), IP LAN (dideteksi), port TCP (default 5000)

**Untuk chat dengan user lain:**

- **Nama user** (lihat `/list`) atau **Peer ID** (±59 karakter, berawalan `MCowBQYDK2Vw...`)
- Keduanya harus online dan terdaftar di Discovery Platform yang sama

---

## Struktur Repo

```
packages/
├── shared/              # tipe protokol pesan & kontrak API Discovery
├── discovery-platform/  # peran HOST (Express)
└── user-client/         # peran USER (CLI + modules/pod)
scripts/                 # setup pod, tes, utilitas
css/                     # seed demo alice/bob
```

## Arsitektur Penyimpanan: Local-First + Solid Pod Sync

P2Pod menerapkan pola **Local-First with Cloud Vault Sync**:
1. **Crash-Safe Local Persistence:** Setiap pesan yang terkirim atau diterima langsung ditulis (*write-through*) ke disk lokal di folder `~/.p2pod/chats/<chatId>/sessions/<timestamp>.json` dan `metadata.json` dalam format Schema.org JSON-LD. Jika terminal di-close mendadak atau laptop mati, pesan tidak hilang.
2. **Instant History Load:** Riwayat percakapan langsung dimuat seketika dari penyimpanan lokal saat sesi terhubung tanpa menunggu koneksi internet/Pod.
3. **Sinkronisasi Dua Arah (Bidirectional Sync):**
   - **Push ke Pod:** Mengunggah berkas sesi lokal yang belum tersinkronkan ke Solid Pod (baik Community Solid Server lokal maupun cloud `solidcommunity.net`).
   - **Pull dari Pod:** Mengunduh berkas riwayat dari Pod jika ada sesi yang dibuat dari perangkat lain.
   - **Auto-Sync:** Berjalan otomatis di latar belakang tiap 25 detik dan saat sesi berakhir (`/quit`).
4. **Linking WebID Kriptografis:** Dokumen klaim bertanda tangan digital Ed25519 disimpan di `<podUrl>/p2pod/identity-link.json` yang mengikat identitas peer dengan WebID Solid Pod pengguna.

---

## 🚀 Panduan Demo Step-by-Step

Berikut adalah panduan langkah demi langkah untuk mendemonstrasikan P2Pod dalam berbagai skenario:

### Skema 1 — Demo di 1 Device (Multi-Terminal)
> **Penyimpanan:** Menggunakan **Solid Pod Lokal (Community Solid Server)** port 3000 (Alice) dan port 3001 (Bob) + disk lokal (Local-First).

Buka **3 jendela terminal** (PowerShell / Command Prompt) di folder proyek:

1. **Terminal 1 (Host Discovery Platform):**
   ```bash
   npm run role:discovery
   ```
   *Biarkan terminal ini tetap berjalan (listening di port 4000).*

2. **Terminal 2 (User 1 — Alice):**
   ```bash
   npm run alice
   ```
   *Alice otomatis mendengarkan di port TCP 5000, menjalankan Solid Pod lokal (CSS port 3000 di `http://localhost:3000/alice/`), dan mendaftar ke Discovery.*

3. **Terminal 3 (User 2 — Bob):**
   ```bash
   npm run bob -- alice
   ```
   *Bob otomatis mendengarkan di port TCP 5001, menjalankan Solid Pod lokal (CSS port 3001 di `http://localhost:3001/bob/`), mencari Alice via Discovery, dan membentuk sesi aman E2EE.*

4. **Uji Coba Sesi Chat & Fitur:**
   - Ketik pesan bolak-balik antara Terminal 2 dan Terminal 3.
   - Ketik `/history` untuk melihat pesan yang tersimpan di disk lokal.
   - Ketik `/sync` untuk memicu sinkronisasi ke Solid Pod lokal masing-masing.
   - Ketik `/quit` di salah satu terminal.
   - Jalankan ulang Terminal 2 dan 3: riwayat percakapan sebelumnya langsung termuat (*instant local history* dan sinkron dengan Pod).

---

### Skema 2 — Demo 2 Device Berbeda (Satu Jaringan LAN / Wi-Fi / Hotspot)
> **Penyimpanan:** Masing-masing laptop **otomatis disiapkan Solid Pod Lokal (CSS bawaan)** di localhost laptop masing-masing (tanpa perlu setup manual), ATAU otomatis memakai Solid Community Cloud Pod jika laptop tersebut sebelumnya sudah login via `npm run pod:login`.

#### Langkah 1: Hubungkan ke Jaringan yang Sama
Pastikan Laptop A dan Laptop B terhubung ke SSID Wi-Fi atau hotspot ponsel yang sama.

#### Langkah 2: Konfigurasi Firewall di Laptop A (Host)
Buka PowerShell **sebagai Administrator** di Laptop A, jalankan perintah berikut sekali saja untuk membuka port Discovery (4000) dan P2P (5000):
```powershell
New-NetFirewallRule -DisplayName "P2Pod Discovery 4000" -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow
New-NetFirewallRule -DisplayName "P2Pod P2P 5000" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow
```

#### Langkah 3: Jalankan Discovery Platform di Laptop A
Di Laptop A (Terminal 1):
```bash
npm run role:discovery
```
*Catat alamat LAN yang tampil pada banner terminal, misalnya `http://192.168.1.15:4000/`.*

#### Langkah 4: Jalankan User di Laptop A (Alice)
Di Laptop A (Terminal 2):
```bash
npm run role:user
```
* Masukkan Nama: `alice`
* Masukkan URL Discovery: `http://localhost:4000` (atau tekan Enter jika default sesuai).
* *Wizard otomatis menyiapkan Solid Pod lokal Alice di Laptop A (di `http://localhost:3000/alice/` atau port 3005) dan menyimpannya di `.css/alice`.*

#### Langkah 5: Jalankan User di Laptop B (Bob)
Di Laptop B (Terminal Laptop Teman):
```bash
npm run role:user
```
* Masukkan Nama: `bob`
* Masukkan URL Discovery: Masukkan URL LAN Laptop A yang tadi dicatat (misal: `http://192.168.1.15:4000`).
* *Wizard di Laptop B juga otomatis menyiapkan Solid Pod lokal Bob di Laptop B (di `http://localhost:3000/bob/`) dan menyimpannya di `.css/bob` laptop teman.*

#### Langkah 6: Hubungkan & Mulai Percakapan
Di terminal Laptop B (atau Laptop A):
```text
/list
/connect alice
```
* Sesi P2P terenkripsi (ECDH + AES-256-GCM) terbentuk langsung antar kedua laptop.
* Kirim pesan obrolan. Setiap pesan tersimpan aman di disk lokal masing-masing laptop dan disinkronkan ke Solid Pod masing-masing!

---

### Skema 3 — Demo dengan Solid Community Cloud Pod (`solidcommunity.net`)
> Skenario menggunakan Solid Pod publik di internet sebagai brankas data pribadi (Personal Data Vault) dan menautkan WebID resmi.
>
> `pod:login`/`pod:link` menautkan kredensial ke **profil aktif** — pastikan sudah ada user (`npm run user:add`) atau pilih aktif dengan `npm run user:switch`.

1. **Autentikasi Solid-OIDC:**
   ```bash
   npm run pod:login
   ```
   Pilih opsi **Browser**:
   - Browser akan otomatis terbuka ke `https://solidcommunity.net`.
   - Login dengan akun Anda dan klik **Authorize**.
   - Terminal akan menangkap token dan menampilkan WebID Anda (misal `https://crispyrinux.solidcommunity.net/profile/card#me`).

2. **Tautkan Identitas Ed25519 ke WebID (Cryptographic Link):**
   ```bash
   npm run pod:link
   ```
   *Aplikasi membuat klaim kriptografis bertanda tangan Ed25519 dan mengunggahnya ke `<podUrl>/p2pod/identity-link.json`.*

3. **Mulai Chat & Sinkronkan ke Cloud:**
   ```bash
   npm run user
   ```
   - Saat terhubung dengan peer, WebID Anda akan tampil saat handshake terverifikasi.
   - Ketik `/sync` di sesi chat untuk memverifikasi riwayat terunggah ke Solid Community di cloud.

---

### Skema 4 — Demo Direct TCP & Pengujian Offline / Crash-Safety
> Skenario membuktikan ketahanan offline dan keamanan data jika proses dihentikan secara paksa.

1. **Koneksi Direct TCP (Tanpa Discovery Platform):**
   - Laptop A: Jalankan `npm start -- --listen --port 5000` (catat IP dan Peer ID Alice).
   - Laptop B: Ketik `/connect <IP_Laptop_A> <PeerID_Alice>` (koneksi TCP langsung tanpa memerlukan server discovery).

2. **Pengujian Crash-Safety (Local-First):**
   - Saat sesi chat aktif, kirim beberapa pesan penting.
   - **Tutup paksa terminal** (klik tombol [X] jendela terminal atau tekan `Ctrl+C` tanpa mengetik `/quit`).
   - Buka kembali aplikasi chat: seluruh pesan yang baru dikirim **tetap tersimpan utuh** di disk lokal dan tidak hilang!
   - Saat Solid Pod kembali aktif, ketik `/sync` untuk menyinkronkan sesi yang tertinggal ke Pod.

---

## Testing

```bash
npm run typecheck          # Verifikasi tipe TypeScript
npm run test:local-first   # Uji persistensi crash-safe & sync dua arah ke Solid Pod
npm run test:pod           # Uji autentikasi Solid, WebID linking & round-trip JSON-LD
npm run test:smoke         # 5 fase: discovery, routing IP, handshake, /connect by name
npm run test:e2e           # End-to-end lengkap dengan CSS
```

> Untuk panduan detail dan troubleshooting tambahan, lihat [DEMO.md](DEMO.md).
