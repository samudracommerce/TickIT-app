// Tick-IT — autentikasi (email + password, cookie session bertanda tangan) dan otorisasi berbasis role.
// Catatan: saat plug-in Voyage siap, ganti fungsi login dengan verifikasi token/SSO dari Voyage; sisanya tetap.
import crypto from 'node:crypto';

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
