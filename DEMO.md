# P2Pod — Panduan Demo

P2Pod adalah chat P2P terdesentralisasi: komunikasi real-time via TCP langsung (ECDH + AES-256-GCM), identitas permanen Ed25519, dan riwayat percakapan tersimpan di Solid Pod masing-masing pengguna (Community Solid Server lokal).

## Prasyarat

- Node.js 18+ (diuji di Node 24)
- npm
- Dua terminal (1 mesin) atau dua device dalam LAN/hotspot yang sama

## Instalasi

```bash
npm install
```

> `postinstall` otomatis menginstall dependency untuk `server/discovery-server`.

---

## Skenario A — Demo 1 Mesin (2 Terminal)

Akun demo dari seed: `alice@example.com` / `bob@example.com`, password `p2pod-demo-123`.

### 1. Jalankan infrastruktur (3 terminal terpisah)

| Terminal | Perintah | Keterangan |
|---|---|---|
| T1 | `npm run css:alice` | Solid Pod server alice (port 3000) |
| T2 | `npm run css:bob` | Solid Pod server bob (port 3001) |
| T3 | `npm run discovery` | Discovery Platform (port 4000) |

Tunggu sampai log masing-masing menunjukkan server siap (CSS: `Listening to server at http://localhost:3000/`).

### 2. Provisioning kredensial Pod (sekali saja)

```bash
npm run setup:pod:alice   # alice → CSS http://localhost:3000/
npm run setup:pod:bob     # bob   → CSS http://localhost:3001/
```

Perintah ini login ke CSS lalu membuat **client credentials** dan menyimpannya di `.p2pod/<user>/pod-config.json`. Jalankan ulang bila file tersebut hilang.

> **Penting (argumen npm)**: bila memakai `npm run setup:pod` manual, sertakan separator `--` sebelum argumen — tanpa itu npm menelan flag seperti `--css` dan script gagal dengan `Argumen tidak dikenal: http://...`:
> ```bash
> npm run setup:pod -- --css http://localhost:3000/ --email alice@example.com --password p2pod-demo-123 --pod alice --home .p2pod/alice
> # atau tanpa npm arg-forwarding:
> npx ts-node scripts/setup-pod-account.ts --css http://localhost:3000/ --email alice@example.com --password p2pod-demo-123 --pod alice --home .p2pod/alice
> ```
> Sintaks `--flag=value` juga didukung (mis. `--css=http://localhost:3000/`).

### 3. Mulai chat (2 terminal baru)

Setiap peer **online dengan cara yang sama** (mendengarkan koneksi + terdaftar di Discovery Platform) — **urutan start bebas**. Sisi yang punya target akan mencoba menghubungi secara berkala sampai target online.

T4 — Alice:

```bash
npm run alice
```

Salin **Peer ID** yang ditampilkan (baris `[P2Pod] Peer ID ...`).

T5 — Bob:

```bash
npm run bob -- <PEER_ID_ALICE>
```

Contoh: `npm run bob -- MCowBQYDK2VwAyEAIZsNFy19s7cDrWFRSrahtHTydPURJM...`

Bob mencari alice lewat Discovery Platform — **tanpa input IP manual**. Setelah sesi terbentuk, keduanya bisa chat terenkripsi.

**Peran bisa ditukar** — siapa pun boleh jadi penghubung:

```bash
npm run bob:listen                      # T5: bob menunggu; salin Peer ID bob
npm run alice:connect -- <PEER_ID_BOB>  # T4: alice yang menghubungi bob
```

Jika kedua sisi saling `--connect` ke satu sama lain, tie-break otomatis: peer dengan **Peer ID lebih besar** yang menginisiasi, yang lain menunggu. Hasilnya tetap **satu sesi**.

### 4. Akhiri sesi & lihat persistensi

Ketik `/quit` di salah satu terminal. Keduanya akan:
1. Menyimpan seluruh history sesi ke Solid Pod masing-masing (`/p2pod/chats/{chat_id}/sessions/{timestamp}.json`, format JSON-LD)
2. Unregister dari Discovery Platform dan keluar dengan bersih

Jalankan langkah 3 lagi — history sesi sebelumnya otomatis dimuat dari Pod dan ditampilkan sebelum chat baru.

---

## Skenario B — Demo 2 Mesin (LAN/Hotspot)

Mesin A (alice) dan Mesin B (bob) di jaringan yang sama. Discovery Platform bisa di Mesin A atau mesin ketiga.

**Mesin A:**
```bash
npm run css:alice
npm run discovery                     # catat IP LAN Mesin A, misal 192.168.1.10
npm run setup:pod:alice
npm start -- --home .p2pod/alice --listen --port 5000 --pod http://localhost:3000/alice/ --discovery http://localhost:4000 --name alice
```

**Mesin B:**
```bash
npm run css:bob
npm run setup:pod:bob
npm start -- --home .p2pod/bob --port 5000 --connect <PEER_ID_ALICE> --pod http://localhost:3001/bob/ --discovery http://192.168.1.10:4000 --name bob
```

Catatan:
- **Urutan start bebas** — jalankan kedua perintah dengan urutan apa pun; sisi `--connect` akan retry tiap 3 detik sampai target online.
- Peran dapat ditukar: Mesin A boleh `--connect` dan Mesin B `--listen`.
- Pod selalu di `localhost` masing-masing device — hanya pemilik yang menulis ke Pod-nya sendiri.
- Izinkan port 4000 (discovery) dan 5000 (P2P) di firewall Mesin A.

---

## Opsi CLI

```
--listen                    online: dengarkan koneksi + daftar discovery, tunggu koneksi masuk
--connect <PeerID>          online: daftar discovery + hubungi target (retry berkala sampai online) — urutan start bebas
--port <n>                  port TCP sendiri (default 5000; di satu mesin setiap peer perlu port berbeda, mis. 5000 & 5001)
--pod <pod-url>             URL Pod, misal http://localhost:3000/alice/
--discovery <url>           URL Discovery Platform (default http://localhost:4000)
--home <dir>                direktori identitas & config (default ~/.p2pod, env: P2POD_HOME)
--name <nama>               display name (disimpan di identity.json)
```

Semua flag juga menerima bentuk `--flag=value` (mis. `--port=5001`); `--help` menampilkan bantuan.

---

## Testing

```bash
npm run test:smoke      # tanpa Pod: flow dasar + retry urutan-bebas + tie-break mutual-connect
npm run test:pod -- --home .p2pod/alice   # round-trip JSON-LD ke Pod
npm run test:e2e        # E2E penuh: chat -> save Pod -> reconnect -> load history
npm run typecheck       # verifikasi TypeScript
```

`test:e2e` menyiapkan segalanya sendiri (menjalankan CSS + provisioning bila perlu).

---

## Struktur Data di Pod

```
http://localhost:3000/alice/
└── p2pod/
    └── chats/
        └── {chat_id}/                        ← SHA256(sort(PeerID_A, PeerID_B))
            ├── metadata.json                 ← info sesi (dengan siapa, aktivitas terakhir)
            └── sessions/
                └── {timestamp}.json          ← seluruh pesan sesi (format JSON-LD)
```

Pesan disimpan dengan `@context: https://schema.org/` — interoperable dengan aplikasi Solid lain.

---

## Mengakses Data di Pod

Solid Pod adalah web server HTTP dengan kontrol akses WAC — membuka URL pod langsung di browser (tanpa klien) **ditolak dengan `401 Unauthorized`** (`WWW-Authenticate: Bearer scope="openid webid"`). Ada tiga cara untuk melihat isi Pod:

### Cara 1 — Lewat filesystem (paling cepat)

CSS dijalankan dengan penyimpanan file (`-f .css/alice`), sehingga pod `/alice/` persis berada di folder `.css/alice/alice/`.

```powershell
# daftar semua chat & sesi
Get-ChildItem -Recurse .css\alice\alice\p2pod\chats

# baca sesi terbaru & tampilkan rapi
$f = Get-ChildItem '.css\alice\alice\p2pod\chats\*\sessions\*.jsonld' |
     Sort-Object LastWriteTime | Select-Object -Last 1
Get-Content $f.FullName -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 10
```

> **Quirk penamaan file CSS**: resource `sessions/2026-11-05T06-06-22-491Z.json` tersimpan di disk sebagai `2026-11-05T06-06-22-491Z.json$.jsonld` — `$` adalah separator ekstensi internal CSS dan `.jsonld` menandakan serialisasi JSON-LD (URL resource tetap `.json`). Di PowerShell gunakan kutip satu (`'...'`) saat menyebut path yang mengandung `$`.

Untuk pod bob, ganti `.css\alice\alice` menjadi `.css\bob\bob`.

### Cara 2 — Lewat API Solid (terprogram)

Akses dilakukan sebagai klien Solid terautentikasi memakai kredensial di `.p2pod/alice/pod-config.json` (hasil `npm run setup:pod`). Contoh skrip Node (`@inrupt/solid-client-authn-node` sudah terinstall):

```js
// read-pod.js — jalankan dari root proyek: node read-pod.js
const fs = require('fs');
const { Session } = require('@inrupt/solid-client-authn-node');

(async () => {
  const cfg = JSON.parse(fs.readFileSync('.p2pod/alice/pod-config.json', 'utf8'));
  const session = new Session({ keepAlive: false });
  await session.login({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, oidcIssuer: cfg.oidcIssuer });

  // daftar chat (JSON-LD)
  const res = await session.fetch(`${cfg.podUrl}p2pod/chats/`, { headers: { accept: 'application/ld+json' } });
  console.log('GET chats:', res.status);
  console.log(await res.text());

  await session.logout();
})();
```

`session.fetch` adalah `fetch` yang otomatis menyertakan token DPoP atas nama WebID pemilik pod. Arahkan ke resource apa pun di pod — misal `` `${cfg.podUrl}p2pod/chats/{chat_id}/sessions/{timestamp}.json` `` — untuk membaca isinya.

### Cara 3 — Lewat browser (halaman akun CSS)

Buka `/.account/` lalu login dengan akun seed:

| Pod | URL | Email | Password |
|---|---|---|---|
| alice | http://localhost:3000/.account/ | alice@example.com | p2pod-demo-123 |
| bob | http://localhost:3001/.account/ | bob@example.com | p2pod-demo-123 |

Halaman ini untuk mengelola akun: pod, login, dan **client credentials** (sumber kredensial yang dipakai `setup:pod`). Isi resource pod (`/alice/...`) tidak bisa dijelajahi dari halaman ini — untuk membaca data gunakan Cara 1 (filesystem) atau Cara 2 (klien Solid terautentikasi).

> **Tip reset demo**: hentikan CSS, hapus folder `.css/alice` / `.css/bob`, lalu jalankan ulang `npm run css:alice` / `npm run css:bob` — seed membuat ulang akun + pod kosong (jalankan `npm run setup:pod` lagi untuk kredensial baru).

---

## Keamanan & Desain

| Aspek | Implementasi |
|---|---|
| Identitas | Keypair Ed25519 permanen di `~/.p2pod/identity.json`; Peer ID = public key |
| Pertukaran kunci | ECDH P-256 ephemeral → K_temp |
| Verifikasi identitas | Kedua peer menandatangani transcript sesi; MITM terdeteksi |
| Enkripsi pesan | AES-256-GCM (K_sym hasil derivasi K_temp + transcript) |
| Penyimpanan | End-of-session write ke Pod masing-masing (bukan per pesan) |
| Discovery | Hanya mapping Peer ID → IP:Port + target intent (routing), TTL 60 detik, tidak menyimpan konten |

## Batasan (by design)

- **LAN/hotspot saja** — tanpa STUN/TURN; ekstensi ke STUN terisolasi di `establish_connection()`.
- **Real-time only** — kedua peer harus online; tidak ada offline messaging.
- **End-of-session write** — data hilang hanya jika proses di-crash paksa (bukan `/quit`).
- **CSS dev mode** — HTTP tanpa TLS, hanya untuk demo lokal.

## Troubleshooting

| Gejala | Solusi |
|---|---|
| `Discovery Platform tidak terjangkau` | Pastikan `npm run discovery` berjalan; cek URL `--discovery` |
| `Argumen tidak dikenal: http://...` saat setup | Flag tertelan npm — pakai `npm run setup:pod:alice` / `setup:pod:bob`, atau sertakan separator `--` sebelum argumen |
| `Menunggu peer online...` terus muncul | Normal bila target belum dibuka — connector retry tiap 3 dtk; pastikan Peer ID benar (bandingkan fingerprint) |
| `Peer tidak ditemukan` | Hanya muncul sebagai pesan tunggu; peer dianggap lewat TTL 60 dtk bila heartbeat berhenti |
| `Konfigurasi Pod tidak ditemukan` | Jalankan `npm run setup:pod:alice` / `npm run setup:pod:bob` sesuai panduan |
| `Login ke Solid Pod gagal` | CSS harus berjalan; jalankan ulang `setup:pod` |
| Port bentrok (`EADDRINUSE`) | Di satu mesin beri `--port` berbeda tiap peer (alice 5000, bob 5001) atau hentikan proses lama (`taskkill /PID <pid> /T /F`) |
