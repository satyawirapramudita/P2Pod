# Guide Screenshot — P2Pod

Panduan langkah-demi-langkah untuk mengambil screenshot aplikasi P2Pod, yang akan dipakai di bagian **6. Screenshot Sebagian Aplikasi** pada [Laporan_Progress.md](Laporan_Progress.md).

Aplikasi P2Pod berbasis **terminal (CLI)**, jadi semua screenshot berupa tangkapan jendela terminal.

**Ringkasan cepat (TL;DR):**

- Simpan hasil **PNG** di folder `docs/screenshots/` (sudah disiapkan di repo).
- Gunakan **nama file persis** seperti daftar di bagian 4 (mis. `01-wizard-init.png`) agar otomatis muncul di laporan.
- **Solid Pod tidak perlu disiapkan manual** — wizard `init` menyalakan Community Solid Server + provisioning akun secara otomatis. Cukup 1 terminal Discovery + 2 terminal wizard.
- Perintah user: `npm run user:add` (buat user baru + jadikan aktif), `npm run user` (masuk sebagai user aktif), `npm run user:switch` (ganti user aktif). Di panduan ini `npm run role:user -- --reconfigure` (alias lama) tetap dipakai agar **semua pertanyaan wizard tampil ulang** untuk screenshot.
- Jendela terminal: ± **120 kolom × 30 baris**, font **Cascadia Mono 12–14**, tema **gelap** — konsisten untuk semua gambar.
- Ambil screenshot dengan **Win + Shift + S** (Snipping Tool) atau **Alt + PrtScn** (jendela aktif).
- Jangan screenshot file `pod-config.json` atau `identity.json` (berisi kredensial/private key).

---

## 1. Persiapan

1. Buka terminal di root proyek: `C:\Users\Satya\Desktop\P2Pod`.
   - Rekomendasi: **Windows Terminal** (satu jendela, banyak tab) — hasil screenshot lebih rapi. PowerShell biasa juga cukup.
2. Atur tampilan yang konsisten di semua jendela:
   - Font: **Cascadia Mono**, ukuran **12–14**, tema gelap (mis. "Campbell").
   - Ukuran jendela disarankan ± **120 kolom × 30 baris** (PowerShell: klik kanan title bar → *Properties* → tab *Layout*; Windows Terminal: *Settings* → profil → *Appearance*).
3. Prasyarat: `npm install` sudah pernah dijalankan (project sudah ter-setup).
4. Sebelum capture, bersihkan layar dengan `cls` bila perlu; matikan **notifikasi** sementara agar tidak ada popup yang masuk ke gambar.
5. Ukuran font/window boleh berbeda antar screenshot, tapi usahakan seragam supaya laporan rapi.

> 🔒 **Privasi:** jangan pernah men-screenshot file `.p2pod/*/pod-config.json` (berisi `clientSecret`) dan `identity.json` (berisi private key). Peer ID & fingerprint **aman** ditampilkan — keduanya memang identitas publik. IP LAN privat (`192.168.x.x`) boleh tampil.

---

## 2. Cara Mengambil Screenshot di Windows

| Cara | Langkah | Cocok untuk |
|---|---|---|
| **A. Snipping Tool** | Tekan `Win + Shift + S` → pilih mode **Rectangle** atau **Window** → seret/klik area → simpan dari notifikasi (atau `Ctrl + S`) sebagai **PNG** | Jendela tunggal, area spesifik |
| **B. Alt + PrtScn** | Tekan `Alt + PrtScn` (jendela aktif tersalin ke clipboard) → buka **Paint** → `Ctrl + V` → *Save As* → PNG | Cepat, satu jendela penuh |
| **C. Win + PrtScn** | Tekan `Win + PrtScn` → otomatis tersimpan di `Pictures\Screenshots\` | Seluruh layar |

**Tips:**
- Untuk **dua jendela berdampingan** (mis. alice & bob), susun jendela kiri-kanan lalu gunakan mode **Rectangle**.
- Jika hanya ingin satu jendela tanpa desktop sekitarnya, `Alt + PrtScn` atau mode **Window** paling rapi.
- Pastikan baris penting (mis. `Sesi aman terbentuk dengan "bob"`) sudah muncul **sebelum** capture — tunggu sampai prosesnya benar-benar selesai.

---

## 3. Alur Demo untuk Screenshot

Ikuti urutan di bawah. Semua perintah dijalankan dari root proyek `C:\Users\Satya\Desktop\P2Pod`. Panduan ini memakai label terminal **T1–T4**.

> **Tidak perlu menyiapkan CSS/Pod manual.** Wizard di Skenario 1 & 1b otomatis: membuat seed CSS, menyalakan Community Solid Server (port **3000** untuk alice, **3001** untuk bob), lalu provisioning akun Pod ke `.p2pod/<user>/pod-config.json`. Pertama kali dijalankan butuh 10–90 detik (boot CSS).
> *(Mode manual klasik sesuai `DEMO.md` — `npm run css:alice`/`css:bob` + `setup:pod:*` — tetap bisa dipakai; hasil screenshot sama.)*

### Langkah 0 — Discovery Platform (satu-satunya infrastruktur manual)

| Tab | Perintah | Tunggu sampai |
|---|---|---|
| T1 | `npm run discovery` | `[discovery] listening on 0.0.0.0:4000` |

---

### Skenario 1 — Wizard Setup User alice → `01-wizard-init.png`

T2 — jalankan wizard (mode *reconfigure* agar semua pertanyaan tampil kembali):

```bash
npm run role:user -- --home .p2pod/alice --reconfigure
```

Jawab pertanyaan berikut:

| Pertanyaan | Isi |
|---|---|
| `1/4 Nama kamu` | `alice` |
| `2/4 URL Discovery Platform` | `http://localhost:4000` lalu Enter (harus muncul `Discovery Platform OK`) |
| `3/4 Port TCP untuk menerima koneksi` | tekan **Enter** (default `5000`) |
| `4/4 Aktifkan riwayat chat di Solid Pod? (y/N)` | `y` lalu Enter |
| `  URL Pod` | tekan **Enter** (default `http://localhost:3000/alice/`) |

Setelah itu wizard menyiapkan Pod lokal otomatis — tunggu baris:

```
  Menyiapkan Solid Pod lokal (CSS port 3000)...
  Pod siap: http://localhost:3000/alice/
```

lalu blok **`— Setup selesai —`** (nama, Peer ID, Discovery, Port, Pod). **Capture jendela T2** → simpan sebagai:

```
docs/screenshots/01-wizard-init.png
```

> Jika pertanyaan + hasil tidak muat dalam satu layar, ambil dua bagian (pertanyaan & hasil) atau perbesar jendela.
> **Biarkan T2 tetap berjalan** — jendela ini menjadi *alice* yang menunggu koneksi (listen, port 5000).

---

### Skenario 1b — Wizard Setup User bob (langkah pendukung)

T3 — jalankan wizard untuk bob:

```bash
npm run role:user -- --home .p2pod/bob --reconfigure
```

| Pertanyaan | Isi |
|---|---|
| `1/4 Nama kamu` | `bob` |
| `2/4 URL Discovery Platform` | `http://localhost:4000` lalu Enter |
| `3/4 Port TCP untuk menerima koneksi` | `5001` lalu Enter |
| `4/4 Aktifkan riwayat chat di Solid Pod? (y/N)` | `y` lalu Enter |
| `  URL Pod` | **ubah menjadi `http://localhost:3001/bob/`** lalu Enter (jangan pakai default 3000!) |

> ⚠️ **Penting:** URL Pod bob harus di port **3001** agar konsisten dengan skrip pintasan (`npm run bob`) yang dipakai di Skenario 4 nanti.

Tunggu `Pod siap: http://localhost:3001/bob/` dan `[SYSTEM] Menunggu koneksi masuk...`. Tidak perlu screenshot untuk langkah ini.

---

### Skenario 2 — Daftar User Online → `02-user-list.png`

alice (T2) dan bob (T3) sudah online dari wizard di atas.

T4 — tampilkan daftar user online:

```bash
npm run user:list -- --discovery http://localhost:4000
```

Output menampilkan **alice & bob** (nama, fingerprint, Peer ID) — **capture jendela T4** → simpan sebagai:

```
docs/screenshots/02-user-list.png
```

> Bonus: kalau ingin menyertakan log Discovery Platform (T1) yang menunjukkan kedua peer ter-register, susun T1 & T4 berdampingan lalu capture sekaligus. Alternatif lain: setelah Skenario 3 tersambung, ketik `/list` di jendela alice.

---

### Skenario 3 — Sesi Chat Terenkripsi → `03-chat-alice.png` & `03-chat-bob.png`

1. Di **T2 (alice)**, ketik perintah dan kirim sebuah pesan:

   ```
   /connect bob
   ```

   Tunggu sampai muncul `Sesi aman terbentuk dengan "bob"` + `Peer terverifikasi: fingerprint ...` + `chat_id: ...`.

2. Kirim pesan dari alice:

   ```
   Halo bob, ini pesan terenkripsi via P2Pod
   ```

3. Di **T3 (bob)**, pastikan pesan di atas tampil, lalu balas:

   ```
   Halo alice! Diterima dengan aman.
   ```

4. Pastikan balasan tampil di **T2 (alice)** juga, kemudian capture:
   - T2 → `docs/screenshots/03-chat-alice.png`
   - T3 → `docs/screenshots/03-chat-bob.png`

> Baris penting yang sebaiknya terlihat: `Sesi aman terbentuk dengan "..."`, `Peer terverifikasi: fingerprint ...`, `chat_id: ...`, dan pesan-pesan dengan timestamp.

---

### Skenario 4 — History Dimuat dari Solid Pod → `04-history-pod.png`

1. Di **T3 (bob)**, keluar dari sesi:

   ```
   /quit
   ```

2. Perhatikan kedua jendela: muncul `Menyimpan history sesi ke Solid Pod...` lalu `History tersimpan di Pod (...json)`. Tunggu kedua proses benar-benar keluar (prompt kembali ke PowerShell).
   - *(Opsional)* capture momen "History tersimpan" ini sebagai gambar bonus.

3. Setelah kedua proses berhenti, **mulai ulang kedua peer**:
   - T2 (alice): `npm run alice` → tunggu baris `[P2Pod] Peer ID ...` muncul, lalu **salin Peer ID alice**.
   - T3 (bob): `npm run bob -- <PEER_ID_ALICE>` ← tempel Peer ID alice di atas.

4. Saat sesi terbentuk kembali, akan muncul:

   ```
   [SYSTEM] — History sebelumnya dari Solid Pod (N pesan) —
   [SYSTEM] [HH:MM] alice: <pesan lama...>
   [SYSTEM] — Akhir history —
   ```

   **Capture jendela yang menampilkan history tersebut** → simpan sebagai:

   ```
   docs/screenshots/04-history-pod.png
   ```

> Riwayat berhasil dimuat membuktikan siklus lengkap: chat → simpan ke Pod → reconnect → muat kembali.

---

### Skenario 5 — Struktur Data di Solid Pod → `05-pod-structure.png`

Di **T4** (PowerShell), tampilkan isi Pod alice di filesystem:

```powershell
Get-ChildItem -Recurse '.css\alice\alice\p2pod\chats' | Select-Object FullName
```

Bonus — tampilkan isi sesi terbaru:

```powershell
$f = Get-ChildItem '.css\alice\alice\p2pod\chats\*\sessions\*.json' | Sort-Object LastWriteTime | Select-Object -Last 1
Get-Content $f.FullName -Raw
```

**Capture jendela T4** → simpan sebagai:

```
docs/screenshots/05-pod-structure.png
```

> Struktur yang diharapkan: `p2pod/chats/{chat_id}/metadata.json` dan `sessions/{timestamp}.json`.

---

### Skenario 6 — Hasil Smoke Test → `06-smoke-test.png`

1. Sudahi dulu peer yang masih jalan: ketik `/quit` di T2 & T3 (Discovery & Pod boleh tetap berjalan).
2. Di **T4** (atau tab baru), jalankan:

   ```bash
   npm run test:smoke
   ```

3. Tunggu ± 1–2 menit sampai baris terakhir muncul:

   ```
   --- Hasil akhir ---
     OK  discovery bersih setelah semua sesi (peers=0)

   SMOKE TEST LULUS dalam XX.Xs
   ```

4. **Capture bagian akhir output** (Fase 4 + hasil akhir) → simpan sebagai:

```
docs/screenshots/06-smoke-test.png
```

---

### Skenario 7 (Opsional) — Hasil E2E Penuh → `07-e2e-pod.png`

```bash
npm run test:e2e
```

Skrip ini aman dijalankan meski Pod demo masih hidup (CSS yang sudah berjalan akan dipakai ulang). Tunggu baris terakhir:

```
E2E TEST LULUS dalam XX.Xs
```

Capture → simpan sebagai `docs/screenshots/07-e2e-pod.png`.

> Skenario ini membuktikan siklus penuh: chat 2 peer → simpan ke Pod → reconnect → muat history.

---

## 4. Daftar File & Pemetaan ke Laporan

| # | Nama file | Isi | Wajib? |
|---|---|---|---|
| 1 | `01-wizard-init.png` | Wizard setup user (`init` — 4 pertanyaan + penyiapan Pod otomatis + ringkasan) | ✅ |
| 2 | `02-user-list.png` | Output `npm run user:list` (+ log discovery) | ✅ |
| 3 | `03-chat-alice.png` | Sesi chat sisi alice (handshake, fingerprint, chat_id, pesan) | ✅ |
| 4 | `03-chat-bob.png` | Sesi chat sisi bob (idem) | ✅ |
| 5 | `04-history-pod.png` | History lama dimuat dari Solid Pod setelah reconnect | ✅ |
| 6 | `05-pod-structure.png` | Struktur file `p2pod/chats/...` di filesystem pod | ✅ |
| 7 | `06-smoke-test.png` | Output `SMOKE TEST LULUS dalam …s` | ✅ |
| 8 | `07-e2e-pod.png` | Output `E2E TEST LULUS dalam …s` | ⭕ opsional |

Semua file disimpan dengan nama **persis** seperti di atas, di folder:

```
docs/screenshots/
```

---

## 5. Setelah Semua Screenshot Diambil

1. Buka [Laporan_Progress.md](Laporan_Progress.md) — bagian **6. Screenshot Sebagian Aplikasi**. Gambar akan **otomatis muncul** karena file gambar sudah dirujuk dengan path relatif (`docs/screenshots/…`).
2. Jika ingin memeriksa tampilan: buka laporan di GitHub atau *Markdown Preview* (VS Code: `Ctrl + Shift + V`).
3. Ubah label **`⏳ menunggu`** menjadi **`✅`** (atau minta agen memperbarui laporan sekaligus).
4. (Rekomendasi) simpan ke git: `git add -A && git commit -m "docs: screenshot demo + laporan final" && git push`.
5. (Opsional) hentikan Pod lokal yang dinyalakan otomatis oleh wizard:

   ```bash
   npm run pod:stop              # hentikan semua CSS yang dikelola wizard
   npm run pod:stop -- --name alice   # hanya alice (port 3000)
   ```

   CSS yang dijalankan manual (`npm run css:alice` dst.) dihentikan dengan `Ctrl + C` di terminalnya.

**Checklist akhir:**

- [ ] 6 gambar wajib tersedia (01–06) + 1 opsional (07)
- [ ] Nama file & folder persis sesuai tabel bagian 4
- [ ] PNG (bukan JPG hasil kompresi ulang), teks terbaca jelas
- [ ] Tidak ada `clientSecret` / isi `pod-config.json` / private key di gambar
- [ ] Gambar muncul di `Laporan_Progress.md` bagian 6

---

## 6. Troubleshooting Screenshot

| Gejala | Solusi |
|---|---|
| Teks tidak terbaca / buram | Perbesar font jendela (mis. 14), lalu capture ulang |
| Output terpotong | Perbesar jendela atau perkecil zoom; scroll sehingga baris penting di tengah layar |
| `Win + Shift + S` tidak merespons | Buka **Snipping Tool** dari Start Menu, atau gunakan `Alt + PrtScn` |
| Dua terminal sulit di-capture bersamaan | Ambil dua screenshot terpisah (mis. `03-chat-alice.png` & `03-chat-bob.png`) — sudah didukung laporan |
| Baris `Sesi aman terbentuk` belum muncul | Tunggu retry selesai (3 detik/percobaan); pastikan kedua user terdaftar di Discovery (`npm run user:list -- --discovery http://localhost:4000`) |
| Wizard menampilkan `⚠ Setup Pod otomatis gagal` | Lihat log `.css/<nama>-css.log`. Bisa juga jalankan manual `npm run css:alice` lalu ulangi wizard (`--reconfigure`) — wizard akan memakai CSS yang sudah jalan |
| Port 3000/3001 bentrok (`EADDRINUSE`) | Hentikan Pod otomatis lama: `npm run pod:stop` (atau `-- --name <nama>`), lalu ulangi |
| Data pod belum ada di Skenario 5 | Pastikan Pod aktif saat chat (muncul `Pod siap: ...` di wizard, bukan peringatan preflight); fallback manual: `npm run css:alice` + `npm run setup:pod:alice` |
| Port TCP bentrok saat demo | Pastikan alice 5000, bob 5001; hentikan proses lama (`taskkill /PID <pid> /T /F`) lalu ulangi |

---

*Panduan ini melengkapi [Laporan_Progress.md](Laporan_Progress.md) dan mengacu pada alur demo di [DEMO.md](DEMO.md).*
