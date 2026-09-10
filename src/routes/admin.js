// Tick-IT — role & user management (butuh hak manageRoles), plus laporan.
import { Router } from 'express';
import { db, getRoles, getRole, resetRoles, publicUser } from '../db.js';
import { hashPassword, requireLogin, requirePerm } from '../auth.js';

const PERM_KEYS = ['create', 'assign', 'status', 'close', 'report', 'jobcard', 'manageRoles'];
const SCOPES = ['own', 'assigned', 'all'];
export const roles = Router();
export const users = Router();
export const report = Router();

// ---------- roles
roles.use(requireLogin);
roles.get('/', (_req, res) => res.json(getRoles())); // semua user login boleh membaca (UI butuh tahu haknya sendiri)
roles.put('/:key', requirePerm('manageRoles'), (req, res) => {
  const cur = getRole(req.params.key);
  if (!cur) return res.status(404).json({ error: 'not_found' });
  if (cur.locked) return res.status(409).json({ error: 'locked', message: 'Role Admin terkunci.' });
  const { scope, perms } = req.body || {};
  const newScope = SCOPES.includes(scope) ? scope : cur.scope;
  const newPerms = { ...cur.perms };
  if (perms && typeof perms === 'object') for (const k of PERM_KEYS) if (k in perms) newPerms[k] = !!perms[k];
  db.prepare('UPDATE roles SET scope=?, perms=? WHERE key=?').run(newScope, JSON.stringify(newPerms), cur.key);
  res.json(getRole(cur.key));
});
roles.post('/reset', requirePerm('manageRoles'), (_req, res) => { resetRoles(); res.json(getRoles()); });

// ---------- users
users.use(requireLogin);
const listStmt = db.prepare('SELECT * FROM users ORDER BY role, nama');
// daftar user: pengelola lihat semua; role lain hanya daftar engineer (untuk dropdown assign)
users.get('/', (req, res) => {
  const all = listStmt.all().map(publicUser);
  if (req.role.perms.manageRoles) return res.json(all);
  res.json(all.filter((u) => u.active && ['engineer', 'koordinator', 'admin'].includes(u.role)).map(({ id, nama, divisi, role }) => ({ id, nama, divisi, role })));
});
users.post('/', requirePerm('manageRoles'), (req, res) => {
  const { email, nama, divisi, role, password } = req.body || {};
  if (!email?.trim() || !nama?.trim() || !divisi?.trim() || !getRole(role) || !(password?.length >= 8)) return res.status(400).json({ error: 'invalid', message: 'Email, nama, divisi, role, dan password (min. 8 karakter) wajib diisi.' });
  try {
    const info = db.prepare('INSERT INTO users (email,nama,divisi,role,password_hash) VALUES (?,?,?,?,?)').run(email.trim().toLowerCase(), nama.trim(), divisi.trim(), role, hashPassword(password));
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)));
  } catch (e) { res.status(409).json({ error: 'duplicate', message: 'Email sudah terdaftar.' }); }
});
users.patch('/:id', requirePerm('manageRoles'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not_found' });
  const { role, active, password, nama, divisi } = req.body || {};
  if (u.id === req.user.id && ((role && role !== u.role) || active === false)) return res.status(409).json({ error: 'self', message: 'Role / status akun sendiri tidak bisa diubah dari sini.' });
  db.prepare('UPDATE users SET role=?, active=?, nama=?, divisi=?, password_hash=? WHERE id=?').run(
    getRole(role) ? role : u.role, active === undefined ? u.active : (active ? 1 : 0), nama?.trim() || u.nama, divisi?.trim() || u.divisi,
    password?.length >= 8 ? hashPassword(password) : u.password_hash, u.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)));
});

// ---------- laporan: tiket yang masuk ke IT per periode, dipecah Done / Hold / Closed (status saat ini)
report.use(requireLogin, requirePerm('report'));
report.get('/', (req, res) => {
  const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
  const n = period === 'weekly' ? 8 : 6;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = n - 1; i >= 0; i--) {
    let start, end, label, labelLong;
    if (period === 'weekly') {
      const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) - i * 7);
      start = monday; end = new Date(monday); end.setDate(monday.getDate() + 7);
      const fri = new Date(monday); fri.setDate(monday.getDate() + 4);
      label = `${monday.getDate()} ${BULAN[monday.getMonth()]}`;
      labelLong = `${monday.getDate()} ${BULAN[monday.getMonth()]} – ${fri.getDate()} ${BULAN[fri.getMonth()]}${i === 0 ? ' (berjalan)' : ''}`;
    } else {
      start = new Date(now.getFullYear(), now.getMonth() - i, 1); end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      label = BULAN[start.getMonth()]; labelLong = `${BULAN_FULL[start.getMonth()]} ${start.getFullYear()}${i === 0 ? ' (berjalan)' : ''}`;
    }
    const row = db.prepare(`SELECT COUNT(*) total,
        SUM(status='done') done, SUM(status='hold') hold, SUM(status='cancelled') closed,
        SUM(status IN ('awaiting','assigned','on_progress')) open
      FROM tickets WHERE created >= ? AND created < ?`).get(start.toISOString(), end.toISOString());
    buckets.push({ label, labelLong, total: row.total, done: row.done || 0, hold: row.hold || 0, closed: row.closed || 0, open: row.open || 0 });
  }
  res.json({ period, buckets });
});
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const BULAN_FULL = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
