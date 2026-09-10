// Tick-IT — SQLite (better-sqlite3), skema + seed.
// DATA_DIR di-mount sebagai persistent storage di Coolify (default /data).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';

const DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : path.resolve('data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new Database(path.join(DATA_DIR, 'tickit.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY, label TEXT NOT NULL, desc TEXT DEFAULT '', scope TEXT NOT NULL DEFAULT 'own',
  perms TEXT NOT NULL DEFAULT '{}', locked INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, nama TEXT NOT NULL, divisi TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(key), password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, tipe TEXT NOT NULL, ket TEXT NOT NULL,
  nama TEXT NOT NULL, divisi TEXT NOT NULL, creator_id INTEGER REFERENCES users(id),
  engineer TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'awaiting', prog INTEGER NOT NULL DEFAULT 0,
  start TEXT NOT NULL, end TEXT NOT NULL,
  created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, at TEXT NOT NULL, actor TEXT DEFAULT '', text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, at);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created);
`);

// ---- default role & hak akses (sama dengan prototype). Pemohon hanya melihat tiket yang dibuatnya.
export const DEFAULT_ROLES = [
  { key: 'pemohon',     label: 'Pemohon',        desc: 'Karyawan divisi lain yang membuka tiket', scope: 'own',  locked: 0, sort: 1,
    perms: { create: true,  assign: false, status: false, close: true,  report: false, jobcard: true,  manageRoles: false } },
  { key: 'engineer',    label: 'Engineer IT',    desc: 'Mengerjakan tiket yang ditugaskan',        scope: 'all',  locked: 0, sort: 2,
    perms: { create: true,  assign: false, status: true,  close: false, report: true,  jobcard: true,  manageRoles: false } },
  { key: 'koordinator', label: 'Koordinator IT', desc: 'Mengatur antrean & beban engineer',        scope: 'all',  locked: 0, sort: 3,
    perms: { create: true,  assign: true,  status: false, close: true,  report: true,  jobcard: true,  manageRoles: false } },
  { key: 'admin',       label: 'Admin',          desc: 'Pengelola aplikasi Tick-IT',               scope: 'all',  locked: 1, sort: 4,
    perms: { create: true,  assign: true,  status: true,  close: true,  report: true,  jobcard: true,  manageRoles: true } },
];

const upsertRole = db.prepare(`INSERT INTO roles (key,label,desc,scope,perms,locked,sort) VALUES (@key,@label,@desc,@scope,@perms,@locked,@sort)
  ON CONFLICT(key) DO UPDATE SET label=excluded.label, desc=excluded.desc, scope=excluded.scope, perms=excluded.perms, locked=excluded.locked, sort=excluded.sort`);
export function resetRoles() {
  const tx = db.transaction(() => { for (const r of DEFAULT_ROLES) upsertRole.run({ ...r, perms: JSON.stringify(r.perms) }); });
  tx();
}
if (db.prepare('SELECT COUNT(*) c FROM roles').get().c === 0) resetRoles();

// ---- admin pertama dari env (wajib ganti password setelah login pertama)
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const email = process.env.ADMIN_EMAIL || 'admin@tick-it.local';
  const password = process.env.ADMIN_PASSWORD || 'changeme';
  db.prepare('INSERT INTO users (email,nama,divisi,role,password_hash) VALUES (?,?,?,?,?)')
    .run(email, process.env.ADMIN_NAME || 'Admin Tick-IT', 'IT', 'admin', hashPassword(password));
  console.log(`[tick-it] admin pertama dibuat: ${email} (password dari ADMIN_PASSWORD${process.env.ADMIN_PASSWORD ? '' : ' — default "changeme", segera ganti!'})`);
}

// ---- data demo opsional (SEED_DEMO=1) — untuk uji coba, bukan produksi
if (process.env.SEED_DEMO === '1' && db.prepare('SELECT COUNT(*) c FROM tickets').get().c === 0) {
  const demoUsers = [
    ['okky@demo.local', 'Okky Pratama', 'IT', 'koordinator'], ['fajar@demo.local', 'Fajar Nugroho', 'IT', 'engineer'],
    ['andi@demo.local', 'Andi Saputra', 'IT', 'engineer'], ['rizal@demo.local', 'Rizal Maulana', 'IT', 'engineer'],
    ['rina@demo.local', 'Rina Hapsari', 'Gudang', 'pemohon'], ['dimas@demo.local', 'Dimas Prasetyo', 'Finance', 'pemohon'],
    ['maya@demo.local', 'Maya Kusuma', 'HR', 'pemohon'],
  ];
  const insU = db.prepare('INSERT OR IGNORE INTO users (email,nama,divisi,role,password_hash) VALUES (?,?,?,?,?)');
  for (const [e, n, d, r] of demoUsers) insU.run(e, n, d, r, hashPassword('demo1234'));
  const day = (n, h = 9, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + n); return d.toISOString(); };
  const iso = (n) => day(n).slice(0, 10);
  const T = [
    ['TK-0001', 'Issue Troubleshooting', 'Printer barcode di Gudang B nggak terdeteksi sejak tadi siang. Sudah coba cabut-pasang USB dan restart PC, tetap "device not found".', 'Rina Hapsari', 'Gudang', '', 'awaiting', 0, 0, 0, day(0, 8, 40), [['created', day(0, 8, 40), 'Rina Hapsari', 'Tiket dibuka oleh Rina Hapsari (Gudang) — masuk antrean divisi IT.']]],
    ['TK-0002', 'Feature Request', 'Minta tambahan kolom HPP di export laporan penjualan harian (format Excel).', 'Dimas Prasetyo', 'Finance', 'Fajar Nugroho', 'assigned', 0, 0, 2, day(0, 8, 5), [['created', day(0, 8, 5), 'Dimas Prasetyo', 'Tiket dibuka oleh Dimas Prasetyo (Finance).'], ['assigned', day(0, 8, 20), 'Okky Pratama', 'Okky Pratama (Koordinator IT) assign ke Fajar Nugroho.']]],
    ['TK-0003', 'Division Support Needs', 'Onboarding 2 karyawan baru Store Ops minggu depan. Butuh setup laptop, akun email, dan akses Voyage.', 'Maya Kusuma', 'HR', 'Andi Saputra', 'on_progress', 55, -1, 2, day(-1, 9, 15), [['created', day(-1, 9, 15), 'Maya Kusuma', 'Tiket dibuka oleh Maya Kusuma (HR).'], ['assigned', day(-1, 10, 2), 'Okky Pratama', 'Okky Pratama (Koordinator IT) assign ke Andi Saputra.'], ['on_progress', day(0, 9, 30), 'Andi Saputra', 'Andi mulai kerjakan — laptop sudah di-image, akun email dibuat.']]],
    ['TK-0004', 'Issue Troubleshooting', 'POS kasir 2 di toko Kelapa Gading freeze tiap kali scan lebih dari 30 item.', 'Rina Hapsari', 'Gudang', 'Fajar Nugroho', 'done', 100, -2, -1, day(-2, 8, 2), [['created', day(-2, 8, 2), 'Rina Hapsari', 'Tiket dibuka oleh Rina Hapsari (Gudang).'], ['assigned', day(-2, 8, 15), 'Okky Pratama', 'Okky Pratama (Koordinator IT) assign ke Fajar Nugroho.'], ['on_progress', day(-2, 9, 0), 'Fajar Nugroho', 'Fajar remote ke POS — memory leak di modul scanner.'], ['done', day(-1, 14, 10), 'Fajar Nugroho', 'Fajar set Done — patch scanner v2.3.1 terpasang, tes 100 item lancar.']]],
  ];
  const insT = db.prepare('INSERT INTO tickets (id,tipe,ket,nama,divisi,creator_id,engineer,status,prog,start,end,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insE = db.prepare('INSERT INTO ticket_events (ticket_id,kind,at,actor,text) VALUES (?,?,?,?,?)');
  const uid = db.prepare('SELECT id FROM users WHERE nama=?');
  db.transaction(() => {
    for (const [id, tipe, ket, nama, divisi, eng, st, prog, s0, s1, created, evs] of T) {
      insT.run(id, tipe, ket, nama, divisi, uid.get(nama)?.id ?? null, eng, st, prog, iso(s0), iso(s1), created, evs[evs.length - 1][1]);
      for (const [k, at, actor, text] of evs) insE.run(id, k, at, actor, text);
    }
  })();
  console.log('[tick-it] data demo dimuat (SEED_DEMO=1). Password semua user demo: demo1234');
}

// ---- helper
export function rowRole(r) { return r ? { ...r, perms: JSON.parse(r.perms), locked: !!r.locked } : null; }
export function getRoles() { return db.prepare('SELECT * FROM roles ORDER BY sort').all().map(rowRole); }
export function getRole(key) { return rowRole(db.prepare('SELECT * FROM roles WHERE key=?').get(key)); }
export function publicUser(u) { if (!u) return null; const { password_hash, ...rest } = u; return { ...rest, active: !!rest.active }; }
export function nextTicketId() {
  const row = db.prepare("SELECT id FROM tickets ORDER BY CAST(substr(id, 4) AS INTEGER) DESC LIMIT 1").get();
  const n = row ? parseInt(row.id.slice(3), 10) + 1 : 1;
  return 'TK-' + String(n).padStart(4, '0');
}
const evStmt = db.prepare('SELECT kind, at, actor, text FROM ticket_events WHERE ticket_id=? ORDER BY at, id');
export function withEvents(t) { return t ? { ...t, events: evStmt.all(t.id) } : null; }
export function addEvent(ticketId, kind, actor, text, at = new Date().toISOString()) {
  db.prepare('INSERT INTO ticket_events (ticket_id,kind,at,actor,text) VALUES (?,?,?,?,?)').run(ticketId, kind, at, actor, text);
  db.prepare('UPDATE tickets SET updated=? WHERE id=?').run(at, ticketId);
}
