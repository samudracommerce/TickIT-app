// Tick-IT — Helpdesk divisi IT. Express + SQLite, single-file frontend di /public.
// Jalankan: npm start  ·  env: PORT, DATA_DIR, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO
// SSO Voyage: VOYAGE_WHOAMI_URL, VOYAGE_WHOAMI_HOST, VOYAGE_PUBLIC_BASE_URL, TICKIT_SSO_PREFIX,
//             TICKIT_VOYAGE_SERVICE_KEY (rahasia — lihat sso.js dan .env.example)
import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, getRole, publicUser } from './db.js';
import { attachUser, verifyPassword, hashPassword, requireLogin, provisionFromVoyage } from './auth.js';
import { whoami, loginUrl, readCookie } from './sso.js';
import tickets from './routes/tickets.js';
import { roles, users, report } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
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

// ---- SSO bridge Voyage — TickIT jalan di voyage.samudracommerce.com/Tick-IT (satu origin dgn
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

// ---- health (Coolify healthcheck)
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
app.use('/api/tickets', tickets);
app.use('/api/roles', roles);
app.use('/api/users', users);
app.use('/api/report', report);
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// ---- frontend
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: PROD ? '1h' : 0 }));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('*', (req, res) => {
  // Belum login & bridge SSO di atas tak berhasil (tak ada cookie Voyage / gagal verifikasi) ->
  // langsung ke Voyage (SSO mulus kalau user sudah login di Voyage). Halaman /login TickIT sendiri
  // (dgn form email+password) tetap bisa diakses manual sebagai jalur cadangan kalau Voyage down.
  if (!req.user) return res.redirect(loginUrl(req.originalUrl));
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`[tick-it] listening on :${PORT} (${PROD ? 'production' : 'development'})`));
