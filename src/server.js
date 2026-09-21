// Tick-IT — Helpdesk divisi IT. Express + SQLite, single-file frontend di /public.
// Jalankan: npm start  ·  env: PORT, DATA_DIR, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO
// SSO Voyage: VOYAGE_WHOAMI_URL, VOYAGE_WHOAMI_HOST, VOYAGE_PUBLIC_BASE_URL, TICKIT_SSO_PREFIX,
//             TICKIT_VOYAGE_SERVICE_KEY (rahasia — lihat sso.js dan .env.example)
import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, getRole, publicUser } from './db.js';
import { attachUser, verifyPassword, hashPassword, requireLogin, provisionFromVoyage } from './auth.js';
import { whoami, loginUrl, readCookie, roster, BASE, VOYAGE_PUBLIC_BASE } from './sso.js';
import tickets from './routes/tickets.js';
import { roles, users, report } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

// ── PREFIX SUB-PATH (hukum RP armada — fix Farhan, commit 551f731) ──────────────────────────
// Tick-IT dipasang di https://voyage.samudracommerce.com/tick-it, dan Traefik (Coolify)
// MEMOTONG prefiks itu sebelum meneruskan: app menerima "/login", bukan "/tick-it/login".
// Yang tak ikut terpotong adalah URL yang APP INI BUAT SENDIRI — redirect dan fetch. Tanpa
// prefiks, `res.redirect('/login')` melempar orang ke /login milik VOYAGE, dan
// `fetch('/api/login')` menembak API Voyage (404) — jadi tombol Masuk tak pernah bekerja.
// Dibaca dari env, TANPA cabang "kalau produksi": prefiks kosong = perilaku lama persis
// (dev lokal di root tak berubah sama sekali). BASE di-import dari sso.js (satu sumber kebenaran
// buat kedua modul — lihat normalizeBase() di sana) supaya next= yg dikirim ke Voyage & prefiks
// yg dipakai di sini utk redirect/link selalu konsisten, tak pernah drift.
const PROD = process.env.NODE_ENV === 'production';
if (PROD && !process.env.SESSION_SECRET) console.warn('[tick-it] PERINGATAN: SESSION_SECRET belum di-set — semua sesi logout tiap restart.');

const app = express();
app.set('trust proxy', 1); // di belakang Traefik (Coolify) + Cloudflare
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(cookieSession({
  name: 'tickit.sid',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  maxAge: Number(process.env.SESSION_TTL_HOURS || 24) * 3600 * 1000,
  sameSite: 'lax', httpOnly: true, secure: PROD,
}));
app.use(attachUser(db, getRole));

// ---- SSO bridge Voyage — TickIT jalan di voyage.samudracommerce.com/tick-it (satu origin dgn
// Voyage), jadi cookie lapor_session Voyage otomatis ikut kalau user sudah login di Voyage. Kalau
// sesi lokal TickIT belum ada tapi cookie itu ada & valid (whoami sukses), provision/sinkron user
// lokal dan anggap request ini sudah login — tanpa perlu user klik apa pun (SSO beneran, sekali klik
// di Voyage cukup utk semua app fleet). Gagal verifikasi (tak ada cookie, Voyage down, dsb.) ->
// diam-diam lanjut sebagai belum-login; jalur lama (redirect ke /login) tetap jadi fallback.
app.use(async (req, res, next) => {
  if (req.user) return next(); // sesi lokal TickIT sudah valid, tak perlu apa-apa lagi
  const token = readCookie(req, 'lapor_session');
  if (!token) return next();
  try {
    const who = await whoami(token);
    if (who) {
      const u = provisionFromVoyage(db, who);
      if (u.active) {
        req.session.uid = u.id;
        req.user = u;
        req.role = getRole(u.role);
      }
    }
  } catch (e) {
    console.error('[tick-it/sso] bridge error:', e);
  }
  next();
});

// ---- health (Coolify healthcheck) — SENGAJA tidak diprefiks: dipanggil dari DALAM container
// (curl localhost:3000), tak lewat proxy.
app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, ts: new Date().toISOString() }); });

// ---- auth
// Titik masuk SSO: arahkan browser ke halaman login Voyage, minta balik ke path TickIT semula.
app.get('/login/voyage', (req, res) => res.redirect(loginUrl(req.query.next || '/')));
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(email || '').trim().toLowerCase());
  if (!u || !verifyPassword(password, u.password_hash)) return res.status(401).json({ error: 'invalid_credentials', message: 'Email atau password salah.' });
  req.session.uid = u.id;
  res.json({ user: publicUser(u), role: getRole(u.role) });
});
app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/me', requireLogin, (req, res) => res.json({ user: publicUser(req.user), role: req.role }));
app.post('/api/me/password', requireLogin, (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(current, req.user.password_hash)) return res.status(400).json({ error: 'wrong_password', message: 'Password lama salah.' });
  if (!(next?.length >= 8)) return res.status(400).json({ error: 'weak', message: 'Password baru minimal 8 karakter.' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

// ---- API
// Daftar pemohon utk form tiket — nama & divisi dari roster Voyage (identity_export).
// Email SENGAJA tidak ikut keluar: dipakai hanya di sini, utk mengenali baris milik orang yang
// sedang login supaya form bisa terisi otomatis. Roster gagal/kosong bukan error — frontend
// otomatis jatuh ke isian ketik-manual (lihat openForm() di public/index.html).
app.get('/api/people', requireLogin, async (req, res) => {
  const rows = await roster();
  const email = String(req.user.email || '').trim().toLowerCase();
  const mine = rows.find(r => r.email && r.email === email) || null;
  // whoami Voyage tidak memulangkan departemen, jadi users.divisi milik user SSO lahir kosong.
  // Roster tahu jawabannya — sembuhkan sekali di sini supaya tidak kosong selamanya.
  if (mine?.divisi && !req.user.divisi) {
    db.prepare('UPDATE users SET divisi=? WHERE id=?').run(mine.divisi, req.user.id);
    req.user.divisi = mine.divisi;
  }
  res.json({
    me: mine ? { nama: mine.nama, divisi: mine.divisi } : null,
    people: rows.map(r => ({ nama: r.nama, divisi: r.divisi })),
  });
});

app.use('/api/tickets', tickets);
app.use('/api/roles', roles);
app.use('/api/users', users);
app.use('/api/report', report);
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// ---- frontend
// Halaman disajikan lewat page(): satu <script> disuntikkan sebelum </head> yang membawa
// prefiks ke sisi klien (window.__BASE__) dan membungkus fetch(). Tanpa pembungkus itu tiap
// `fetch('/api/…')` di public/*.html harus ditulis ulang satu per satu — dan yang berikutnya lupa
// lagi. location.href / <a href> tak bisa dibungkus (properti, bukan fungsi) — ditulis eksplisit
// pakai window.__BASE__ di public/*.html (lihat commit 551f731 utk index.html, dan login.html
// utk tombol SSO).
const SHIM = (base, voyage) => `<script>window.__BASE__=${JSON.stringify(base)};`
  + `window.__VOYAGE__=${JSON.stringify(voyage)};`
  + `(function(b){if(!b)return;var f=window.fetch.bind(window);`
  + `window.fetch=function(u,o){if(typeof u==="string"&&u.charAt(0)==="/"&&u.indexOf(b+"/")!==0)u=b+u;return f(u,o);};})(window.__BASE__);`
  + `</script>`;
const pages = new Map();
function page(nama) {
  if (!pages.has(nama) || !PROD) {          // dev: baca ulang tiap permintaan
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', nama), 'utf8');
    pages.set(nama, html.includes('</head>') ? html.replace('</head>', SHIM(BASE, VOYAGE_PUBLIC_BASE) + '</head>')
                                             : SHIM(BASE, VOYAGE_PUBLIC_BASE) + html);
  }
  return pages.get(nama);
}
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: PROD ? '1h' : 0 }));
app.get('/login', (_req, res) => res.type('html').send(page('login.html')));
app.get('*', (req, res) => {
  if (req.user) return res.type('html').send(page('index.html'));

  // TAK ADA cookie Voyage sama sekali -> orangnya memang belum login. Lempar ke Voyage; ini
  // BERHENTI, karena di sana dia disambut form login. loginUrl() sudah menambahkan BASE ke next=
  // supaya sesudah login dia balik ke path TickIT yang benar.
  if (!readCookie(req, 'lapor_session')) return res.redirect(loginUrl(req.originalUrl));

  // ADA cookie Voyage, tapi bridge SSO di atas gagal membuat sesi — whoami ditolak, orangnya
  // belum di-grant akses ke TickIT di /manage/apps, atau Voyage sedang tak bisa dihubungi.
  //
  // JANGAN redirect ke Voyage di cabang ini. Voyage akan melihat sesi yang sah, melempar balik
  // ke sini, bridge gagal lagi, lempar lagi — REDIRECT LOOP tak berujung yang di browser cuma
  // tampak sebagai "halaman gagal dimuat", tanpa satu pun petunjuk kenapa. Itu persis gejala
  // yang kita kejar seharian. Jadi: berhenti di sini dan katakan apa adanya, pola yang sama
  // dipakai Hands. 403 (bukan 200) supaya monitoring & log tetap jujur.
  res.status(403).type('html').send(page('gate.html'));
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`[tick-it] listening on :${PORT} (${PROD ? 'production' : 'development'})${BASE ? ` di bawah prefiks ${BASE}` : ''}`));
