# Tick-IT — Helpdesk Divisi IT

Aplikasi ticketing sederhana untuk Samudra Retail Indonesia. Semua tiket ditujukan ke divisi IT; alur status mengikuti Monitoring Dashboard (BRD/PRD):

```
Menunggu Assign ──► Assigned ──► On Progress ──► Done
                                     │
                                     ├──► Hold ──► On Progress
                                     └──► Closed (ditutup tanpa dikerjakan)
```

Fitur: Grid · Timeline (bar per hari) · Laporan (diagram batang Done/Hold/Closed, weekly/monthly) · Detail tiket + timeline event · Job Card PDF (tiket Done/Closed) · Role & hak akses (default: **Pemohon hanya melihat tiket yang dibuatnya**).

Stack: Node 22 · Express · SQLite (better-sqlite3, WAL) · frontend single-file tanpa build step (`public/index.html`). Sama seperti Monitoring Dashboard, jadi pola deploy-nya identik.

---

## 1. Jalankan lokal

```bash
npm install
cp .env.example .env            # edit ADMIN_EMAIL / ADMIN_PASSWORD / SESSION_SECRET
SEED_DEMO=1 npm run dev         # SEED_DEMO=1 → isi user & tiket contoh (password demo1234)
# buka http://localhost:3000 → login dengan ADMIN_EMAIL / ADMIN_PASSWORD
```

Data tersimpan di `./data/tickit.sqlite` (lokal) atau `DATA_DIR` (produksi: `/data`).

## 2. Push ke GitHub

```bash
git init -b main
git add .
git commit -m "Tick-IT v1.0 — ticketing divisi IT"
git remote add origin git@github.com:<org-samudra>/tick-it.git
git push -u origin main
```

> Jangan commit `.env` dan folder `data/` (sudah ada di `.gitignore`).

## 3. Deploy di Coolify (flow yang sama dengan Monitoring Dashboard)

1. **Coolify → Project → + New Resource → Public/Private Repository (GitHub App)** → pilih repo `tick-it`, branch `main`.
2. **Build Pack: Dockerfile** (file `Dockerfile` di root). Port aplikasi: `3000`.
3. **Environment Variables** (tab *Environment Variables*):

   | Variabel | Nilai |
   |---|---|
   | `NODE_ENV` | `production` |
   | `PORT` | `3000` |
   | `DATA_DIR` | `/data` |
   | `SESSION_SECRET` | string acak panjang (`openssl rand -hex 32`) |
   | `ADMIN_EMAIL` | email admin pertama |
   | `ADMIN_PASSWORD` | password awal admin (ganti setelah login pertama) |
   | `SEED_DEMO` | `0` (produksi) |

4. **Persistent Storage** → *+ Add* → **Volume Mount**: destination `/data`. Tanpa ini database hilang tiap redeploy.
5. **Health Check** (opsional, sudah ada di Dockerfile): path `/healthz`, port `3000`.
6. **Domains**: isi `https://tick-it.samudraretail.co.id` (ganti sesuai domain). Coolify (Traefik) akan mengurus sertifikat Let's Encrypt setelah DNS mengarah.
7. **Deploy**. Aktifkan *Auto Deploy* (webhook GitHub) supaya setiap push ke `main` otomatis redeploy.

## 4. Domain di Cloudflare

Di dashboard Cloudflare → zona `samudraretail.co.id` → **DNS → Records → Add record**:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `A` | `tick-it` | IP publik server Coolify | ☁️ Proxied (oranye) |

Lalu **SSL/TLS → Overview → Full (strict)** (sama seperti aplikasi lain di server Coolify). Kalau sertifikat Let's Encrypt gagal terbit karena proxy, set sementara **DNS only** (abu-abu), tunggu Coolify mendapat sertifikat, lalu kembalikan ke **Proxied** — atau pakai *Origin Certificate* Cloudflare di Coolify.

Setelah DNS propagasi, buka `https://tick-it.samudraretail.co.id/healthz` → harus `{"ok":true}`.

## 5. Setelah deploy pertama

1. Login dengan `ADMIN_EMAIL` / `ADMIN_PASSWORD` → tombol **Ganti password** di header.
2. Tab **Role** → tambahkan user (koordinator IT, engineer, pemohon) dan atur hak akses bila perlu. Default:

   | Role | Lihat tiket | Buka | Assign | Ubah status | Tutup | Laporan | Job Card | Kelola role |
   |---|---|---|---|---|---|---|---|---|
   | Pemohon | hanya yang dibuatnya | ✓ | – | – | ✓ (miliknya) | – | ✓ | – |
   | Engineer IT | semua | ✓ | – | ✓ (yang ditugaskan ke dirinya) | – | ✓ | ✓ | – |
   | Koordinator IT | semua | ✓ | ✓ | – | ✓ | ✓ | ✓ | – |
   | Admin (terkunci) | semua | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

3. Integrasi Voyage (plug-in): saat siap, ganti `POST /api/login` di `src/server.js` dengan verifikasi token/SSO Voyage; tabel `users` tetap dipakai untuk role.

## 6. API ringkas

| Method | Path | Hak |
|---|---|---|
| POST | `/api/login` · `/api/logout` | – |
| GET | `/api/me` · `/api/roles` · `/api/users` | login |
| GET | `/api/tickets` (sesuai cakupan role) · `/api/tickets/:id` | login |
| POST | `/api/tickets` | `create` |
| POST | `/api/tickets/:id/assign` `{engineer,target}` · `/unassign` | `assign` |
| POST | `/api/tickets/:id/status` `{status: on_progress\|hold\|done, prog?, note?}` | `status` |
| POST | `/api/tickets/:id/close` `{reason?}` | `close` |
| GET | `/api/report?period=weekly\|monthly` | `report` |
| PUT | `/api/roles/:key` · POST `/api/roles/reset` | `manageRoles` |
| POST/PATCH | `/api/users` · `/api/users/:id` | `manageRoles` |
| GET | `/healthz` | – |

## 7. Backup

Database = satu file `tickit.sqlite` (+ WAL) di volume `/data`. Backup harian cukup dengan `sqlite3 /data/tickit.sqlite ".backup /backup/tickit-$(date +%F).sqlite"` lewat *Scheduled Backup / cron* di Coolify, atau salin volume-nya.
