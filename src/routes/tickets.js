// Tick-IT — API tiket. Status mengikuti BRD/PRD Monitoring Dashboard:
// awaiting (Menunggu Assign) → assigned → on_progress → done, cabang hold / cancelled (Closed).
import { Router } from 'express';
import { db, nextTicketId, withEvents, addEvent } from '../db.js';
import { requireLogin, requirePerm, canSee } from '../auth.js';
import { notifyTicketEvent } from '../lark.js';

const creatorEmailOf = (t) => (t.creator_id ? db.prepare('SELECT email FROM users WHERE id=?').get(t.creator_id)?.email : null);

export const TYPES = ['Feature Request', 'Issue Troubleshooting', 'Division Support Needs', 'Others'];
const STATUS = ['awaiting', 'assigned', 'on_progress', 'hold', 'done', 'cancelled'];
const r = Router();
r.use(requireLogin);

const getT = db.prepare('SELECT * FROM tickets WHERE id=?');
const todayISO = () => new Date().toISOString().slice(0, 10);
const isTerminal = (t) => t.status === 'done' || t.status === 'cancelled';
const actor = (req) => `${req.user.nama} (${req.role.label})`;
const HARI = ['Min','Sen','Sel','Rab','Kam','Jum','Sab'], BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
const fmtID = (iso) => { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(y, m - 1, d); return `${HARI[dt.getDay()]} ${d} ${BULAN[m - 1]} ${y}`; };

function load(req, res) {
  const t = getT.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not_found' }), null;
  if (!canSee(req, t)) return res.status(403).json({ error: 'forbidden' }), null;
  return t;
}

// daftar tiket sesuai cakupan role
r.get('/', (req, res) => {
  const all = db.prepare('SELECT * FROM tickets ORDER BY created DESC').all();
  res.json(all.filter((t) => canSee(req, t)).map(withEvents));
});

r.get('/:id', (req, res) => { const t = load(req, res); if (t) res.json(withEvents(t)); });

// buka tiket (Nama · Divisi · Tipe · Keterangan) → Menunggu Assign
r.post('/', requirePerm('create'), (req, res) => {
  let { nama, divisi, tipe, ket } = req.body || {};
  // Peran ber-cakupan 'own' (Pemohon) tak boleh membuka tiket atas nama orang lain. UI memang
  // sudah mengunci kedua field-nya, tapi kunci di UI itu hiasan — yang benar-benar mengikat
  // adalah dua baris ini. Peran IT (cakupan 'assigned'/'all') tetap boleh membukakan tiket
  // untuk orang lain, mis. permintaan yang masuk lewat telepon atau WA.
  if ((req.role?.scope || 'own') === 'own') {
    nama = req.user.nama;
    divisi = req.user.divisi || divisi;
  }
  if (!nama?.trim() || !divisi?.trim() || !TYPES.includes(tipe) || !ket?.trim()) return res.status(400).json({ error: 'invalid', message: 'Nama, divisi, tipe, dan keterangan wajib diisi.' });
  const now = new Date().toISOString(), id = nextTicketId();
  db.transaction(() => {
    db.prepare('INSERT INTO tickets (id,tipe,ket,nama,divisi,creator_id,engineer,status,prog,start,end,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, tipe, ket.trim(), nama.trim(), divisi.trim(), req.user.id, '', 'awaiting', 0, todayISO(), todayISO(), now, now);
    addEvent(id, 'created', req.user.nama, `Tiket dibuka oleh ${nama.trim()} (${divisi.trim()}) — masuk antrean divisi IT.`, now);
  })();
  const created = getT.get(id);
  notifyTicketEvent('created', created);
  res.status(201).json(withEvents(created));
});

// assign engineer + target (koordinator/admin)
r.post('/:id/assign', requirePerm('assign'), (req, res) => {
  const t = load(req, res); if (!t) return;
  const { engineer, target } = req.body || {};
  const eng = db.prepare("SELECT nama, email FROM users WHERE nama=? AND active=1 AND role IN ('engineer','koordinator','admin')").get(engineer);
  if (!eng) return res.status(400).json({ error: 'invalid', message: 'Engineer tidak valid.' });
  if (isTerminal(t)) return res.status(409).json({ error: 'terminal' });
  const end = /^\d{4}-\d{2}-\d{2}$/.test(target || '') ? target : t.end;
  db.transaction(() => {
    db.prepare("UPDATE tickets SET engineer=?, status='assigned', end=? WHERE id=?").run(eng.nama, end, t.id);
    addEvent(t.id, 'assigned', req.user.nama, `${actor(req)} assign ke ${eng.nama}, target ${fmtID(end)}.`);
  })();
  const assigned = getT.get(t.id);
  notifyTicketEvent('assigned', assigned, { engineerEmail: eng.email, creatorEmail: creatorEmailOf(assigned), target: end });
  res.json(withEvents(assigned));
});

// kembalikan ke antrean
r.post('/:id/unassign', requirePerm('assign'), (req, res) => {
  const t = load(req, res); if (!t) return;
  if (isTerminal(t) || t.status === 'awaiting') return res.status(409).json({ error: 'invalid_state' });
  db.transaction(() => {
    db.prepare("UPDATE tickets SET engineer='', status='awaiting', prog=0 WHERE id=?").run(t.id);
    addEvent(t.id, 'created', req.user.nama, `${actor(req)} kembalikan tiket ke antrean — menunggu assign ulang.`);
  })();
  res.json(withEvents(getT.get(t.id)));
});

// ubah status pengerjaan: on_progress | hold | done (+ prog, note). Engineer hanya untuk tiket yang ditugaskan padanya.
r.post('/:id/status', requirePerm('status'), (req, res) => {
  const t = load(req, res); if (!t) return;
  const { status, prog, note } = req.body || {};
  if (!['on_progress', 'hold', 'done'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  if (isTerminal(t) || t.status === 'awaiting') return res.status(409).json({ error: 'invalid_state', message: 'Tiket belum di-assign atau sudah selesai.' });
  if (t.engineer !== req.user.nama && !req.role.perms.assign) return res.status(403).json({ error: 'not_your_ticket' });
  let p = t.prog;
  if (status === 'done') p = 100;
  else if (Number.isFinite(+prog)) p = Math.max(0, Math.min(100, Math.round(+prog)));
  else if (status === 'on_progress' && p === 0) p = 10;
  const defaultText = { on_progress: t.status === 'hold' ? 'lanjutkan pengerjaan.' : (t.status === 'on_progress' ? `update progress ${p}%.` : 'mulai kerjakan tiket.'), hold: 'set Hold — menunggu pihak lain.', done: 'set Done.' }[status];
  db.transaction(() => {
    db.prepare('UPDATE tickets SET status=?, prog=? WHERE id=?').run(status, p, t.id);
    addEvent(t.id, status, req.user.nama, `${req.user.nama} ${note?.trim() ? note.trim() : defaultText}`);
  })();
  const updated = getT.get(t.id);
  if (status === 'done') notifyTicketEvent('done', updated, { creatorEmail: creatorEmailOf(updated) });
  res.json(withEvents(updated));
});

// tutup tiket (Closed). Pemohon hanya tiket miliknya.
r.post('/:id/close', requirePerm('close'), (req, res) => {
  const t = load(req, res); if (!t) return;
  if (isTerminal(t)) return res.status(409).json({ error: 'terminal' });
  if (req.role.scope !== 'all' && t.creator_id !== req.user.id && t.nama !== req.user.nama) return res.status(403).json({ error: 'forbidden' });
  const reason = (req.body?.reason || '').trim();
  db.transaction(() => {
    db.prepare("UPDATE tickets SET status='cancelled' WHERE id=?").run(t.id);
    addEvent(t.id, 'cancelled', req.user.nama, `${actor(req)} tutup tiket.${reason ? ' Alasan: ' + reason : ''}`);
  })();
  const closed = getT.get(t.id);
  notifyTicketEvent('cancelled', closed, { creatorEmail: creatorEmailOf(closed), actorLabel: actor(req) });
  res.json(withEvents(closed));
});

export default r;
