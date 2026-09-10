// Tick-IT — Helpdesk divisi IT. Express + SQLite, single-file frontend di /public.
// Jalankan: npm start  ·  env: PORT, DATA_DIR, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, SEED_DEMO
import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, getRole, publicUser } from './db.js';
import { attachUser, verifyPassword, hashPassword, requireLogin } from './auth.js';
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

// ---- health (Coolify healthcheck)
app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, ts: new Date().toISOString() }); });

// ---- auth
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
  if (!req.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'server_error' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`[tick-it] listening on :${PORT} (${PROD ? 'production' : 'development'})`));
