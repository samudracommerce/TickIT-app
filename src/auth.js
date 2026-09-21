// Tick-IT — autentikasi (email + password, cookie session bertanda tangan) dan otorisasi berbasis role.
// SSO Voyage: lihat sso.js (verifikasi identitas) + provisionFromVoyage di bawah (sinkron user lokal).
// Login email+password TETAP ADA sebagai jalur cadangan (break-glass) kalau Voyage sedang down —
// jangan dihapus, ini bukan sisa migrasi yang lupa dibuang.
import crypto from 'node:crypto';
import { BASE } from './sso.js';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(String(pw), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

// Dipasang setelah cookie-session; menaruh req.user + req.role dari DB (bukan dari cookie, supaya perubahan role langsung berlaku).
export function attachUser(db, getRole) {
  const stmt = db.prepare('SELECT * FROM users WHERE id=? AND active=1');
  return (req, _res, next) => {
    req.user = req.session?.uid ? stmt.get(req.session.uid) : null;
    req.role = req.user ? getRole(req.user.role) : null;
    next();
  };
}

// Sinkronkan/buat user lokal dari identitas Voyage (dipanggil sesudah sso.whoami() sukses).
// `who` bentuknya { person_id, email, name, status, apps: [...] } — lihat sso.js.
//
// Role HANYA di-set saat user dibuat PERTAMA KALI. Sesudah itu role dikelola manual lewat panel
// admin TickIT sendiri (role TickIT — pemohon/engineer/koordinator/admin — tidak selalu 1:1 dengan
// role di Voyage), supaya sinkron berikutnya tidak menimpa promosi/penyesuaian role yang sudah
// dilakukan lokal. nama & status aktif tetap disegarkan tiap kali supaya tidak basi.
export function provisionFromVoyage(db, who) {
  const email = String(who.email).trim().toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (existing) {
    db.prepare('UPDATE users SET nama=?, active=1 WHERE id=?').run(who.name || existing.nama, existing.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  }
  const roleKeys = new Set(['pemohon', 'engineer', 'koordinator', 'admin']);
  const appEntry = Array.isArray(who.apps)
    ? who.apps.find(a => a?.base_path === BASE || String(a?.app || '').toLowerCase().includes('tick'))
    : null;
  const guessedRole = String(appEntry?.role || '').toLowerCase();
  // Default aman kalau role dari Voyage tidak dikenali/kosong: 'pemohon' (hak paling rendah).
  // Admin TickIT bisa naikkan manual lewat panel Users kalau memang perlu.
  const role = roleKeys.has(guessedRole) ? guessedRole : 'pemohon';
  if (appEntry && !roleKeys.has(guessedRole)) {
    console.warn(`[tick-it/sso] role Voyage "${appEntry.role}" utk ${email} tak dikenali TickIT — pakai default 'pemohon'.`);
  }
  // password_hash NOT NULL di skema; user SSO tak pernah pakai password ini (acak, tak pernah ditampilkan).
  const unusablePass = hashPassword(crypto.randomBytes(32).toString('hex'));
  const info = db.prepare('INSERT INTO users (email,nama,divisi,role,password_hash) VALUES (?,?,?,?,?)')
    .run(email, who.name || email, who.divisi || '', role, unusablePass);
  console.log(`[tick-it/sso] user baru dari Voyage: ${email} (role=${role})`);
  return db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
}

export const requireLogin = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'unauthenticated' }));
export const requirePerm = (perm) => (req, res, next) =>
  (req.role?.perms?.[perm] ? next() : res.status(403).json({ error: 'forbidden', perm }));

// Cakupan tiket yang boleh DILIHAT oleh user: own | assigned | all
export function canSee(req, t) {
  const sc = req.role?.scope || 'own';
  if (sc === 'all') return true;
  const mine = t.creator_id === req.user.id || t.nama === req.user.nama;
  if (sc === 'assigned') return mine || t.engineer === req.user.nama;
  return mine;
}
