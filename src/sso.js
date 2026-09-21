// Tick-IT — jembatan SSO ke Voyage.
// TickIT dipasang di path /tick-it di bawah domain Voyage (voyage.samudracommerce.com/tick-it),
// jadi cookie `lapor_session` milik Voyage OTOMATIS ikut terkirim browser ke sini juga — satu
// origin (host sama), cookie Path default "/" mencakup semua sub-path termasuk /tick-it.
//
// Verifikasi identitasnya lewat endpoint whoami Voyage, dipanggil SERVER-KE-SERVER lewat jaringan
// internal Coolify (Host header di-override ke voyage.samudracommerce.com), BUKAN lewat internet/
// Cloudflare — lebih cepat, dan tidak ikut kena kalau Cloudflare/DNS publik lagi ada masalah.
// URL internal ini sudah disiapkan di Coolify env (lihat coolify-deploy-summary.txt):
//   Whoami: http://coolify-proxy/api/v1/whoami  (Host: voyage.samudracommerce.com)
//
// Kontrak whoami mengikuti /.well-known/sif.json Voyage:
//   auth_header: X-Api-Key (nilainya = TICKIT_VOYAGE_SERVICE_KEY, rahasia, cuma ada di Coolify)
//   forward_cookie: lapor_session (dikirim lewat header Cookie di request internal ini)
//   returns: { person_id, email, name, status, apps: [{app,label,icon,base_path,descriptor,role,source}] }

const WHOAMI_URL = process.env.VOYAGE_WHOAMI_URL || 'http://coolify-proxy/api/v1/whoami';
const WHOAMI_HOST = process.env.VOYAGE_WHOAMI_HOST || 'voyage.samudracommerce.com';
export const VOYAGE_PUBLIC_BASE = (process.env.VOYAGE_PUBLIC_BASE_URL || 'https://voyage.samudracommerce.com').replace(/\/$/, '');
const SERVICE_KEY = process.env.TICKIT_VOYAGE_SERVICE_KEY || '';

// Kandidat endpoint whoami, DICOBA BERURUTAN. Yang pertama jalur internal Coolify: cepat, tak
// lewat internet. Tapi jalur itu bergantung pada override header `Host` — dan `Host` adalah
// FORBIDDEN HEADER di spesifikasi fetch, jadi undici (fetch bawaan Node) boleh membuangnya
// diam-diam. Kalau dibuang, request sampai ke proxy dgn Host: coolify-proxy, Traefik tak tahu
// harus melempar ke Voyage, dan balasannya non-OK. Kandidat kedua = URL publik, yang tak butuh
// override apa pun. Hanya dipakai kalau yang pertama gagal, jadi jalur cepat tetap yang utama.
const PUBLIC_WHOAMI = `${VOYAGE_PUBLIC_BASE}/api/v1/whoami`;
const WHOAMI_CANDIDATES = [...new Set([WHOAMI_URL, PUBLIC_WHOAMI])];

// Sama persis dgn normalizeBase() di server.js (fix Farhan, commit 551f731) — prefiks sub-path
// dibaca dgn urutan preferensi yg sama, supaya "next=" yg kita kirim ke Voyage dan BASE yg dipakai
// server.js buat redirect/link selalu konsisten walau dua modul beda file. Sengaja diduplikasi
// (bukan di-import dari server.js) supaya sso.js tetap berdiri sendiri/gampang dites.
function normalizeBase(v) {
  const t = String(v || '').trim();
  if (!t || t === '/') return '';
  return '/' + t.replace(/^\/+|\/+$/g, '');
}
export const BASE = normalizeBase(process.env.TICKIT_BASE_PATH ?? process.env.TICKIT_SSO_PREFIX ?? '/tick-it');

if (!SERVICE_KEY) {
  console.warn('[tick-it/sso] TICKIT_VOYAGE_SERVICE_KEY belum di-set — SSO Voyage tidak akan aktif ' +
    '(whoami selalu dianggap gagal). Set env ini di Coolify (sudah disiapkan, lihat coolify-deploy-summary.txt).');
}

// Cache pendek per-token: request beruntun dalam satu page-load (beberapa panggilan API sebelum
// sesi lokal TickIT ke-set) tidak perlu memanggil whoami berkali-kali ke Voyage.
const cache = new Map(); // token -> { data, exp }
const CACHE_MS = 30_000;

export async function whoami(token) {
  if (!token || !SERVICE_KEY) return null;   // lalu-lintas anonim itu normal — sengaja tak di-log
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.data;

  let data = null;
  for (const url of WHOAMI_CANDIDATES) {
    const headers = { 'X-Api-Key': SERVICE_KEY, Cookie: `lapor_session=${token}` };
    // Host hanya perlu di-override kalau URL-nya BUKAN host Voyage sebenarnya (jalur internal).
    let internal = false;
    try { internal = new URL(url).host !== WHOAMI_HOST; } catch { /* URL aneh: jangan override */ }
    if (internal) headers.Host = WHOAMI_HOST;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        // GAGAL DIAM-DIAM ITU RACUN. Tanpa baris ini, whoami yang ditolak 401/403/404 tak
        // meninggalkan jejak apa pun di log, dan satu-satunya gejala yang terlihat user adalah
        // halaman yang "gagal dimuat" (sebenarnya redirect loop). Cuplikan body dipotong dan
        // diratakan; token & X-Api-Key TIDAK pernah ikut ter-log.
        const snippet = (await res.text().catch(() => '')).slice(0, 180).replace(/\s+/g, ' ').trim();
        console.warn(`[tick-it/sso] whoami ditolak: HTTP ${res.status} dari ${url}` + (snippet ? ` — ${snippet}` : ''));
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!body?.email) { console.warn(`[tick-it/sso] whoami 200 tapi body tanpa email (${url}).`); continue; }
      if (!['aktif', 'leaving'].includes(body.status)) {
        console.warn(`[tick-it/sso] status orang "${body.status}" tidak diterima TickIT.`);
        continue;
      }
      if (url !== WHOAMI_CANDIDATES[0]) console.warn(`[tick-it/sso] jalur utama gagal — identitas didapat dari cadangan ${url}.`);
      data = body;
      break;
    } catch (e) {
      // Voyage tak terjangkau/timeout -> "belum terverifikasi", BUKAN "ditolak permanen":
      // user tetap bisa masuk lewat login lokal TickIT (lihat public/login.html).
      console.warn(`[tick-it/sso] whoami gagal (${url}):`, e.message);
    }
  }
  if (data) cache.set(token, { data, exp: Date.now() + CACHE_MS });
  else cache.delete(token);
  return data;
}

// URL login Voyage yang mengarah balik ke path TickIT yang benar sesudah sukses. `nextPath` di
// sini adalah path YANG SUDAH DILUCUTI prefix-nya oleh Traefik (mis. req.originalUrl di dalam
// container = "/tickets/123"), jadi harus ditambah lagi BASE-nya di sini supaya Voyage tahu ini
// harus balik ke "/tick-it/tickets/123" (yg terlihat dari luar), bukan "/tickets/123" di domain
// Voyage sendiri.
export function loginUrl(nextPath) {
  const clean = nextPath && nextPath.startsWith('/') ? nextPath : '/';
  const next = BASE + clean;
  return `${VOYAGE_PUBLIC_BASE}/login?next=${encodeURIComponent(next)}`;
}

// Ambil satu cookie dari header Cookie mentah. Tidak pakai paket cookie-parser (cuma butuh SATU
// cookie asing di luar punya cookie-session, dan cookie-session cuma parse cookie miliknya sendiri).
export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}
