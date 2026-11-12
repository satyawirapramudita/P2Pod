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
npm run role:user
```

Wizard 2 langkah (sisanya otomatis):

1. **Nama** (wajib — tampil di daftar user)
2. **URL Discovery Platform** (mis. `http://192.168.1.10:4000`) — divalidasi otomatis

Otomatis: **port TCP 5000** (ubah dengan `--port`) dan **Solid Pod lokal** `http://localhost:3000/<nama>/` yang disiapkan sendiri — CSS dijalankan + akun Pod di-provision. Nonaktifkan Pod dengan `--no-pod`.

Setelah selesai, aplikasi langsung berjalan (listening) dan menampilkan **Peer ID**, **IP LAN**, serta daftar user online.

**Non-interaktif** (semua nilai dari flag):

```bash
npm run role:user -- --name rani --discovery http://192.168.1.10:4000 --port 5000 --pod http://localhost:3000/rani/
# atau tanpa Pod:
npm run role:user -- --name rani --discovery http://192.168.1.10:4000 --port 5000 --no-pod
```

Menjalankan `npm run role:user` lagi otomatis memakai config yang tersimpan (tanpa prompt). Gunakan `--reconfigure` untuk mengubah.

### Perintah di dalam sesi

| Perintah | Fungsi |
|---|---|
| `/connect <nama\|PeerID>` | Hubungi user (nama dari `/list`) |
| `/connect <IP> <PeerID>` | Hubungi langsung tanpa Discovery (TCP langsung) |
| `/list` | Tampilkan user yang sedang online |
| `/help` | Bantuan |
| `/quit` | Akhiri sesi & simpan history (jika Pod aktif) |

### Perintah satu-jalan

```bash
npm run user:list                            # daftar user online
npm run user:connect -- alice                # hubungi user berdasarkan nama
npm run user:connect -- MCowBQYDK2VwAyEA...  # atau berdasarkan Peer ID
```

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

## Pod (opsional)

- Jawab **y** di wizard → Community Solid Server berjalan otomatis:
  - data: `.css/<nama>/` · log: `.css/<nama>-css.log`
- Hentikan Pod lokal: `npm run pod:stop` (atau `npm run pod:stop -- --name <nama>`)
- Riwayat chat tersimpan sebagai JSON-LD di `<podUrl>/p2pod/chats/<chat_id>/...`

## Testing

```bash
npm run typecheck
npm run test:smoke    # 5 fase: discovery, dual-role, /connect by name, user:list, init
npm run test:e2e      # end-to-end dengan Pod (CSS)
npm run test:pod -- --home .p2pod/alice   # round-trip JSON-LD
```

## Mode Demo (alice/bob di 1 mesin)

Lihat [DEMO.md](DEMO.md) untuk skenario demo lengkap (dua user satu mesin, dua mesin via LAN, akses data Pod, troubleshooting).
