// Tick-IT — integrasi Lark: announce siklus tiket ke grup IT (Custom Bot webhook)
// + DM personal ke assignee & pembuat tiket (Lark custom app / OpenAPI).
//
// PRINSIP DESAIN: best-effort, never-block. Kalau Lark lambat/mati/salah config, tiket TETAP
// jalan normal — kegagalan cuma di-log ke console (lihat safe() di bawah), TIDAK PERNAH
// membuat request API tiket ikut gagal/lambat. notifyTicketEvent() sengaja tidak di-`await`
// oleh pemanggilnya di routes/tickets.js.
//
// ENV (semua opsional — modul ini otomatis skip bagian yang env-nya kosong):
//   LARK_WEBHOOK_URL     Wajib utk notif ke GRUP IT. URL "Custom Bot" webhook grup tsb
//                        (Lark: buka grup → Settings → Bots → Add Bot → Custom Bot → copy Webhook URL).
//   LARK_WEBHOOK_SECRET  Opsional. Isi HANYA kalau bot itu mengaktifkan "Signature Verification"
//                        (Lark kasih secret terpisah utk itu, beda dari webhook URL-nya).
//   LARK_APP_ID          Wajib utk DM PERSONAL ke assignee & pembuat tiket. Custom bot webhook di
//   LARK_APP_SECRET      atas TIDAK BISA DM — dia cuma bisa posting ke satu grup yang sama. Untuk DM,
//                        buat "custom app" (self-built) di Lark Developer Console, ambil App ID +
//                        App Secret dari situ. Permission yang app itu butuh (menu Permissions &
//                        Scopes di console app-nya): kirim pesan (im:message / im:message:send_as_bot)
//                        dan baca kontak scope email (mis. contact:user.email:readonly ATAU
//                        contact:contact.base:readonly — nama scope bisa beda sedikit tergantung
//                        versi console; kalau panggilan API di bawah menolak dgn error permission,
//                        tambahkan scope PERSIS yang disebut di pesan error itu).
//   LARK_API_BASE        Default https://open.larksuite.com (Lark internasional). Pakai
//                        https://open.feishu.cn kalau tenant Samudra Retail sebenarnya di Feishu
//                        (varian domestik Tiongkok dari produk yang sama).
//   TICKIT_PUBLIC_URL    Opsional — base URL publik TickIT, dipakai bikin link langsung ke tiket
//                        di isi pesan Lark (mis. https://voyage.samudracommerce.com/tickit).
//
// CATATAN VERIFIKASI: endpoint & payload di bawah ini mengikuti dokumentasi Lark Open API yang
// stabil selama beberapa tahun terakhir, tapi saya tidak bisa menguji panggilan sungguhan dari sini
// (tidak ada akses ke tenant Lark Anda). Sebelum production, coba tiap endpoint sekali lewat "API
// Explorer" bawaan Lark Developer Console (buka app-mu → API Explorer → pilih endpoint → isi
// App ID/Secret & parameter → Run) supaya kalau ada nama field yang bergeser, ketahuan di sana dulu
// — bukan di tengah alur tiket produksi.
import crypto from 'node:crypto';

const WEBHOOK_URL = process.env.LARK_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.LARK_WEBHOOK_SECRET || '';
const APP_ID = process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';
const API_BASE = (process.env.LARK_API_BASE || 'https://open.larksuite.com').replace(/\/$/, '');
const PUBLIC_URL = (process.env.TICKIT_PUBLIC_URL || '').replace(/\/$/, '');

const ENABLED_GROUP = !!WEBHOOK_URL;
const ENABLED_DM = !!(APP_ID && APP_SECRET);

if (!ENABLED_GROUP) console.log('[lark] LARK_WEBHOOK_URL tak diset — notifikasi ke grup IT dimatikan.');
if (!ENABLED_DM) console.log('[lark] LARK_APP_ID/LARK_APP_SECRET tak diset — DM personal dimatikan (notifikasi grup tetap jalan kalau webhook diisi).');

// ---------- 1) Post ke grup IT lewat Custom Bot webhook ----------
function signWebhook(ts) {
  // Formula tanda tangan resmi Lark utk custom bot "Signature Verification":
  //   key   = `${timestamp}\n${secret}`
  //   sign  = base64( HMAC-SHA256(key, "") )   ← pesan yang di-HMAC memang string kosong
  const key = `${ts}\n${WEBHOOK_SECRET}`;
  return crypto.createHmac('sha256', key).update('').digest('base64');
}

async function postToGroup(text) {
  if (!ENABLED_GROUP) return;
  const body = { msg_type: 'text', content: { text } };
  if (WEBHOOK_SECRET) {
    const ts = Math.floor(Date.now() / 1000).toString();
    body.timestamp = ts;
    body.sign = signWebhook(ts);
  }
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (json.code && json.code !== 0) throw new Error(`webhook menolak: ${json.code} ${json.msg || ''}`);
}

// ---------- 2) DM personal lewat Lark custom app (OpenAPI) ----------
let cachedToken = null; // { token, exp } — expire disimpan sbg epoch ms
async function tenantAccessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 30_000) return cachedToken.token;
  const res = await fetch(`${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`auth gagal: ${json.code} ${json.msg}`);
  cachedToken = { token: json.tenant_access_token, exp: Date.now() + Math.max(60, (json.expire || 7200) - 60) * 1000 };
  return cachedToken.token;
}

// email -> open_id, cache in-memory selama proses hidup (cukup — daftar user IT relatif statis)
const openIdCache = new Map();
async function resolveOpenId(email) {
  if (!email) return null;
  const key = email.trim().toLowerCase();
  if (openIdCache.has(key)) return openIdCache.get(key);
  const token = await tenantAccessToken();
  const res = await fetch(`${API_BASE}/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ emails: [key] }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`batch_get_id gagal: ${json.code} ${json.msg}`);
  const hit = (json.data?.user_list || []).find((u) => (u.email || '').toLowerCase() === key && u.user_id);
  const openId = hit?.user_id || null;
  openIdCache.set(key, openId);
  if (!openId) console.warn(`[lark] email ${key} tak ketemu di direktori tenant Lark ini — DM dilewati (cek email TickIT = email Lark org yg sama?).`);
  return openId;
}

async function dmUser(email, text) {
  if (!ENABLED_DM || !email) return;
  const openId = await resolveOpenId(email);
  if (!openId) return;
  const token = await tenantAccessToken();
  const res = await fetch(`${API_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`kirim DM gagal: ${json.code} ${json.msg}`);
}

// ---------- 3) Titik pemicu per event siklus tiket ----------
const link = (id) => (PUBLIC_URL ? `\n${PUBLIC_URL}/#/t/${id}` : '');

async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`[lark] gagal kirim (${label}):`, e?.message || e);
  }
}

/**
 * Dipanggil dari routes/tickets.js di titik create / assign / done / cancelled.
 * TIDAK di-await oleh pemanggil (fire-and-forget) — lihat catatan di kepala file.
 *
 * kind: 'created' | 'assigned' | 'done' | 'cancelled'
 * t:    row tiket (hasil getT.get(id) — punya id, tipe, ket, nama, divisi, engineer, end, dst.)
 * extra: { engineerEmail?, creatorEmail?, target?, actorLabel? } — tergantung kind
 */
export function notifyTicketEvent(kind, t, extra = {}) {
  const tag = `[${t.id}] ${t.tipe}`;
  if (kind === 'created') {
    void safe('created:group', () => postToGroup(
      `🆕 Tiket baru ${tag}\nDibuka oleh ${t.nama} (${t.divisi}).\n${t.ket}${link(t.id)}`));
  } else if (kind === 'assigned') {
    const { engineerEmail, creatorEmail, target } = extra;
    void safe('assigned:group', () => postToGroup(
      `📌 ${tag} di-assign ke ${t.engineer}.\nDibuka oleh ${t.nama} (${t.divisi}). Target: ${target || t.end}.${link(t.id)}`));
    void safe('assigned:dm-engineer', () => dmUser(engineerEmail,
      `Anda ditugaskan menangani tiket ${tag}.\nDari: ${t.nama} (${t.divisi})\nKeterangan: ${t.ket}\nTarget: ${target || t.end}${link(t.id)}`));
    void safe('assigned:dm-creator', () => dmUser(creatorEmail,
      `Tiket Anda ${tag} sedang dikerjakan oleh ${t.engineer}.${link(t.id)}`));
  } else if (kind === 'done' || kind === 'cancelled') {
    const { creatorEmail, actorLabel } = extra;
    const label = kind === 'done' ? '✅ selesai (Done)' : '🚫 ditutup (Closed)';
    void safe(`${kind}:group`, () => postToGroup(
      `${label} — ${tag}, oleh ${t.engineer || actorLabel || '-'}.${link(t.id)}`));
    void safe(`${kind}:dm-creator`, () => dmUser(creatorEmail,
      `Tiket Anda ${tag} ${kind === 'done' ? 'sudah selesai (Done)' : 'telah ditutup (Closed)'}.${link(t.id)}`));
  }
}
