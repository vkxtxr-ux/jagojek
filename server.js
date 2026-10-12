'use strict';
/**
 * Jagojek web server (MODE DEMO) — tanpa dependensi npm.
 * Node >= 22.13: http, crypto, sqlite bawaan.
 * Saldo = uang VIRTUAL. Untuk uang sungguhan perlu payment gateway berizin + harga dihitung di server.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const qr = require('./lib/qr');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const SIGNUP_BONUS = Number(process.env.SIGNUP_BONUS) || 100000;
const PUB = path.join(__dirname, 'public');
const LATER_LIMIT = 2000000;
const REG_LIMIT = Number(process.env.REG_LIMIT) || 40;     // pendaftaran per IP per jam (WiFi acara = 1 IP bersama)
const LOGIN_LIMIT = Number(process.env.LOGIN_LIMIT) || 100; // percobaan login per IP per 10 menit
const REW = { FOOD10K: 500, RIDE15K: 800, MART20K: 1000 };

const dbPath = DATA_DIR === ':memory:' ? ':memory:' : (fs.mkdirSync(DATA_DIR, { recursive: true }), path.join(DATA_DIR, 'jagojek.db'));
const db = new DatabaseSync(dbPath);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, ident TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL,
  bal INTEGER NOT NULL DEFAULT 0 CHECK(bal>=0), pts INTEGER NOT NULL DEFAULT 0 CHECK(pts>=0),
  later_used INTEGER NOT NULL DEFAULT 0 CHECK(later_used>=0), created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(tok TEXT PRIMARY KEY, uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
CREATE TABLE IF NOT EXISTS states(uid INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, json TEXT NOT NULL, upd INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS txs(id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cid TEXT, ts INTEGER NOT NULL, label TEXT NOT NULL, amt INTEGER NOT NULL, kind TEXT NOT NULL, peer INTEGER, refunded INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS txs_cid ON txs(uid,cid) WHERE cid IS NOT NULL;
CREATE INDEX IF NOT EXISTS txs_uid ON txs(uid,id DESC);
CREATE TABLE IF NOT EXISTS ops(uid INTEGER NOT NULL, opid TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(uid,opid));
CREATE TABLE IF NOT EXISTS awards(uid INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(uid,kind,ref));
`);

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id=?'),
  userByIdent: db.prepare('SELECT * FROM users WHERE ident=?'),
  insUser: db.prepare('INSERT INTO users(ident,name,pass,bal,pts,created) VALUES(?,?,?,?,0,?)'),
  insSess: db.prepare('INSERT INTO sessions(tok,uid,exp) VALUES(?,?,?)'),
  getSess: db.prepare('SELECT s.uid,s.exp FROM sessions s WHERE s.tok=?'),
  delSess: db.prepare('DELETE FROM sessions WHERE tok=?'),
  purge: db.prepare('DELETE FROM sessions WHERE exp<?'),
  getState: db.prepare('SELECT json FROM states WHERE uid=?'),
  putState: db.prepare('INSERT INTO states(uid,json,upd) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET json=excluded.json,upd=excluded.upd'),
  insTx: db.prepare('INSERT INTO txs(uid,cid,ts,label,amt,kind,peer) VALUES(?,?,?,?,?,?,?)'),
  txs: db.prepare('SELECT id,label,amt,ts,kind FROM txs WHERE uid=? ORDER BY id DESC LIMIT 40'),
  txByCid: db.prepare('SELECT * FROM txs WHERE uid=? AND cid=?'),
  markRef: db.prepare('UPDATE txs SET refunded=1 WHERE id=?'),
  setBal: db.prepare('UPDATE users SET bal=?,pts=?,later_used=? WHERE id=?'),
  insOp: db.prepare('INSERT OR IGNORE INTO ops(uid,opid,ts) VALUES(?,?,?)'),
  insAward: db.prepare('INSERT OR IGNORE INTO awards(uid,kind,ref) VALUES(?,?,?)'),
  topupSum: db.prepare("SELECT COALESCE(SUM(amt),0) s FROM txs WHERE uid=? AND kind='topup' AND ts>?"),
  purgeOps: db.prepare('DELETE FROM ops WHERE ts<?'),
};

/* ---------- util ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const isInt = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

function normIdent(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s.includes('@')) {
    const e = s.toLowerCase();
    if (e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return { ident: e, type: 'email' };
    return null;
  }
  const d = s.replace(/[\s\-().]/g, '');
  const m = /^(?:\+62|62|0)(8\d{7,12})$/.exec(d);
  return m ? { ident: '+62' + m[1], type: 'phone' } : null;
}
function looksLikeIdent(s) { return normIdent(s) !== null; }

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const key = await new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPw(pw, stored) {
  const [v, saltHex, keyHex] = String(stored).split('$');
  if (v !== 's1') return false;
  const key = await new Promise((res, rej) => crypto.scrypt(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
  const exp = Buffer.from(keyHex, 'hex');
  return exp.length === key.length && crypto.timingSafeEqual(exp, key);
}
const DUMMY_HASH = 's1$' + '00'.repeat(16) + '$' + '00'.repeat(64);

/* rate limit sederhana (di memori) */
const hits = new Map();
function limit(key, max, windowMs) {
  const t = now(), h = (hits.get(key) || []).filter(x => t - x < windowMs);
  if (h.length >= max) { hits.set(key, h); return false; }
  h.push(t); hits.set(key, h); return true;
}
function failCount(key, windowMs) { const t = now(); return (hits.get(key) || []).filter(x => t - x < windowMs).length; }
setInterval(() => { const t = now(); for (const [k, v] of hits) { const f = v.filter(x => t - x < 3600000); f.length ? hits.set(k, f) : hits.delete(k); } q.purge.run(t); q.purgeOps.run(t - 7 * 864e5); }, 600000).unref();

const clientIp = req => {
  if (process.env.TRUST_PROXY) { const xf = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); if (xf.length) return xf[xf.length - 1]; }
  return req.socket.remoteAddress || 'x';
};
const isHttps = req => !!req.socket.encrypted || (process.env.TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

/* ---------- sesi ---------- */
function parseCookies(req) {
  const out = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setCookie(res, req, value, maxAgeSec) {
  const parts = [`sid=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  if (isHttps(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, parts.join('; ')) : parts.join('; '));
}
function startSession(res, req, uid, keep) {
  const tok = crypto.randomBytes(32).toString('base64url'), ttl = keep ? 30 * 864e5 : 864e5;
  q.insSess.run(sha(tok), uid, now() + ttl);
  setCookie(res, req, tok, keep ? Math.floor(ttl / 1000) : null);
}
function sessionUser(req) {
  const tok = parseCookies(req).sid; if (!tok) return null;
  const s = q.getSess.get(sha(tok)); if (!s) return null;
  if (s.exp < now()) { q.delSess.run(sha(tok)); return null; }
  return q.userById.get(s.uid) || null;
}

/* ---------- dompet ---------- */
function snapshot(uid) {
  const u = q.userById.get(uid);
  return {
    bal: u.bal, pts: u.pts, laterUsed: u.later_used, laterLimit: LATER_LIMIT,
    tx: q.txs.all(uid).map(t => ({ id: t.id, t: t.label, a: t.amt, ts: t.ts, k: t.kind })),
  };
}
const meOf = u => ({ id: u.id, name: u.name, ident: u.ident, created: u.created });
function loadState(uid) { const r = q.getState.get(uid); if (!r) return null; try { return JSON.parse(r.json); } catch { return null; } }

function withTx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; }
}

function walletOp(uid, b) {
  const type = String(b.type || ''), opid = cleanText(b.id, 64);
  if (!opid) throw new HttpError(400, 'ID operasi wajib');
  try { return walletOp2(uid, b, type, opid); }
  catch (e) { if (/UNIQUE/.test(String(e && e.message))) throw new HttpError(409, 'Transaksi duplikat'); throw e; }
}
function walletOp2(uid, b, type, opid) {
  return withTx(() => {
    if (q.insOp.run(uid, opid, now()).changes === 0) return { ...snapshot(uid), dup: true };
    const u = q.userById.get(uid);
    let bal = u.bal, pts = u.pts, later = u.later_used, info = {};
    const label = cleanText(b.label, 80);
    const cid = b.cid ? cleanText(b.cid, 64) : null;
    const rec = (l, amt, kind, c, peer) => q.insTx.run(uid, c || null, now(), l, amt, kind, peer || null);
    const amount = Number(b.amount);

    if (type === 'topup') {
      if (!isInt(amount, 1000, 2000000)) throw new HttpError(400, 'Nominal top up 1.000 – 2.000.000');
      const sum = q.topupSum.get(uid, now() - 864e5).s;
      if (sum + amount > 10000000) throw new HttpError(400, 'Batas top up demo Rp10.000.000 per hari tercapai');
      bal += amount; rec(label || 'Top up', amount, 'topup');
    } else if (type === 'pay') {
      if (!isInt(amount, 1, 50000000)) throw new HttpError(400, 'Nominal tidak valid');
      if (bal < amount) throw new HttpError(409, 'Saldo JagoPay tidak cukup');
      const kind = ['order', 'qr', 'bill', 'plus', 'tip', 'other'].includes(b.kind) ? b.kind : 'other';
      bal -= amount; rec(label || 'Pembayaran', -amount, kind, cid);
      if (kind === 'qr') pts += Math.floor(amount / 2000);
    } else if (type === 'later_charge') {
      if (!isInt(amount, 1, LATER_LIMIT)) throw new HttpError(400, 'Nominal tidak valid');
      if (later + amount > LATER_LIMIT) throw new HttpError(409, 'Limit JagoLater tidak cukup');
      later += amount; rec((label || 'Pembayaran') + ' (JagoLater)', -amount, 'later', cid);
    } else if (type === 'later_repay') {
      if (!isInt(amount, 1, LATER_LIMIT) || amount > later) throw new HttpError(400, 'Nominal tidak valid');
      if (bal < amount) throw new HttpError(409, 'Saldo JagoPay tidak cukup');
      bal -= amount; later -= amount; rec('Lunasi JagoLater', -amount, 'other');
    } else if (type === 'refund' || type === 'later_refund') {
      const t = q.txByCid.get(uid, cleanText(b.ref || b.cid, 64));
      if (!t || t.refunded || t.amt >= 0 || now() - t.ts > 864e5) throw new HttpError(409, 'Tidak ada transaksi yang bisa dikembalikan');
      const amt = -t.amt;
      if (t.kind === 'later') { later = Math.max(0, later - amt); }
      else if (t.kind === 'order') { bal += amt; rec('Refund ' + cleanText(b.label || t.label, 60), amt, 'refund'); }
      else throw new HttpError(409, 'Transaksi ini tidak bisa di-refund');
      q.markRef.run(t.id);
    } else if (type === 'transfer') {
      if (!isInt(amount, 1000, 20000000)) throw new HttpError(400, 'Nominal transfer 1.000 – 20.000.000');
      if (bal < amount) throw new HttpError(409, 'Saldo JagoPay tidak cukup');
      const to = cleanText(b.to, 120);
      if (!to) throw new HttpError(400, 'Penerima wajib diisi');
      const n = normIdent(to);
      if (n) {
        const r = q.userByIdent.get(n.ident);
        if (!r) throw new HttpError(404, 'Penerima belum terdaftar di Jagojek');
        if (r.id === uid) throw new HttpError(400, 'Tidak bisa transfer ke akun sendiri');
        bal -= amount; rec('Transfer ke ' + r.name, -amount, 'transfer', null, r.id);
        q.setBal.run(r.bal + amount, r.pts, r.later_used, r.id);
        q.insTx.run(r.id, null, now(), 'Terima dari ' + u.name, amount, 'in', uid);
        info = { to: r.name };
      } else {
        bal -= amount; rec('Transfer ke ' + to + ' (eksternal, simulasi)', -amount, 'ext'); info = { to, external: true };
      }
    } else if (type === 'redeem') {
      const cost = REW[b.code];
      if (!cost) throw new HttpError(400, 'Voucher tidak dikenal');
      if (pts < cost) throw new HttpError(409, 'Poin tidak cukup');
      pts -= cost;
    } else if (type === 'points') {
      const ref = cleanText(b.ref, 64);
      if (b.kind === 'order') {
        const t = q.txByCid.get(uid, ref);
        if (!t || t.amt >= 0 || (t.kind !== 'order' && t.kind !== 'later')) throw new HttpError(409, 'Referensi poin tidak valid');
        if (q.insAward.run(uid, 'order', ref).changes) { const st = loadState(uid); const mult = st && st.plus && st.plus.on ? 2 : 1; pts += Math.floor(-t.amt / 1000) * mult; }
      } else if (b.kind === 'rate') {
        if (ref && q.insAward.run(uid, 'rate', ref).changes) pts += 10;
      } else throw new HttpError(400, 'Jenis poin tidak dikenal');
    } else throw new HttpError(400, 'Operasi tidak dikenal');

    q.setBal.run(bal, pts, later, uid);
    return { ...snapshot(uid), info };
  });
}

/* ---------- state ---------- */
const STATE_KEYS = { orders: 'a', notifs: 'a', contacts: 'a', owned: 'a', places: 'o', used: 'o', chats: 'o', fav: 'o', plus: 'o', set: 'o', seq: 'n' };
function sanitizeState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new HttpError(400, 'State tidak valid');
  const out = {};
  for (const [k, t] of Object.entries(STATE_KEYS)) {
    if (!(k in s)) continue; const v = s[k];
    if (t === 'a' && Array.isArray(v) && v.length <= 300) out[k] = v;
    else if (t === 'o' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
    else if (t === 'n' && isInt(v, 0, 1e9)) out[k] = v;
  }
  const js = JSON.stringify(out);
  if (js.length > 300000) throw new HttpError(413, 'Data terlalu besar');
  return js;
}

/* ---------- HTTP ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Content-Type harus application/json'));
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 400000) { reject(new HttpError(413, 'Data terlalu besar')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(o && typeof o === 'object' ? o : {}); } catch { reject(new HttpError(400, 'JSON tidak valid')); } });
    req.on('error', reject);
  });
}
function secHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep) || p.includes('\0')) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { const idx = path.join(PUB, 'index.html'); if (!path.extname(p)) return fs.readFile(idx, (e2, d) => { if (e2) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(d); }); res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function publicOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String(req.headers['x-forwarded-host'] && process.env.TRUST_PROXY ? req.headers['x-forwarded-host'] : req.headers.host || 'localhost').split(',')[0].trim().replace(/[^a-zA-Z0-9.:\-\[\]]/g, '');
  return (isHttps(req) ? 'https://' : 'http://') + host;
}

async function api(req, res, pathname) {
  const m = req.method;
  if (m === 'POST' || m === 'PUT') { if (req.headers['x-jj'] !== '1') throw new HttpError(403, 'Permintaan ditolak'); }

  if (pathname === '/api/register' && m === 'POST') {
    const ip = clientIp(req);
    if (!limit('reg:' + ip, REG_LIMIT, 3600000)) throw new HttpError(429, 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.');
    const b = await readJson(req);
    const name = cleanText(b.name, 40), n = normIdent(b.ident), pw = String(b.password || '');
    if (name.length < 2) throw new HttpError(400, 'Nama minimal 2 karakter');
    if (!n) throw new HttpError(400, 'Masukkan email atau no. HP yang valid');
    if (pw.length < 8 || pw.length > 72) throw new HttpError(400, 'Kata sandi 8–72 karakter');
    if (q.userByIdent.get(n.ident)) throw new HttpError(409, 'Email atau no. HP sudah terdaftar. Silakan masuk.');
    const hash = await hashPw(pw);
    let uid;
    try {
      uid = withTx(() => {
        const r = q.insUser.run(n.ident, name, hash, SIGNUP_BONUS, now()); const id = Number(r.lastInsertRowid);
        if (SIGNUP_BONUS > 0) q.insTx.run(id, null, now(), 'Bonus pendaftar (saldo demo)', SIGNUP_BONUS, 'topup', null);
        return id;
      });
    } catch (e) { if (/UNIQUE/.test(String(e.message))) throw new HttpError(409, 'Email atau no. HP sudah terdaftar. Silakan masuk.'); throw e; }
    startSession(res, req, uid, b.keep !== false);
    return send(res, 201, { me: meOf(q.userById.get(uid)), wallet: snapshot(uid), state: null });
  }

  if (pathname === '/api/login' && m === 'POST') {
    const ip = clientIp(req);
    if (!limit('login:' + ip, LOGIN_LIMIT, 600000)) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.');
    const b = await readJson(req);
    const n = normIdent(b.ident), pw = String(b.password || '').slice(0, 200);
    const key = 'fail:' + (n ? n.ident : 'invalid');
    if (failCount(key, 900000) >= 6) throw new HttpError(429, 'Akun dikunci sementara karena terlalu banyak salah sandi. Coba lagi 15 menit lagi.');
    const u = n ? q.userByIdent.get(n.ident) : null;
    const ok = await verifyPw(pw, u ? u.pass : DUMMY_HASH);
    if (!u || !ok) { limit(key, 1e9, 900000); throw new HttpError(401, 'Email/no. HP atau kata sandi salah'); }
    hits.delete(key);
    startSession(res, req, u.id, b.keep !== false);
    return send(res, 200, { me: meOf(u), wallet: snapshot(u.id), state: loadState(u.id) });
  }

  if (pathname === '/api/logout' && m === 'POST') {
    const tok = parseCookies(req).sid; if (tok) q.delSess.run(sha(tok));
    setCookie(res, req, '', 0);
    return send(res, 200, { ok: true });
  }

  const user = sessionUser(req);
  if (!user) throw new HttpError(401, 'Sesi berakhir. Silakan masuk lagi.');

  if (pathname === '/api/me' && m === 'GET') return send(res, 200, { me: meOf(user), wallet: snapshot(user.id), state: loadState(user.id) });
  if (pathname === '/api/wallet' && m === 'GET') return send(res, 200, snapshot(user.id));
  if (pathname === '/api/wallet' && m === 'POST') {
    if (!limit('w:' + user.id, 120, 60000)) throw new HttpError(429, 'Terlalu banyak transaksi. Pelan-pelan ya.');
    return send(res, 200, walletOp(user.id, await readJson(req)));
  }
  if (pathname === '/api/state' && m === 'PUT') {
    const b = await readJson(req);
    q.putState.run(user.id, sanitizeState(b.state), now());
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Tidak ditemukan');
}

const server = http.createServer(async (req, res) => {
  secHeaders(req, res);
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { res.writeHead(400); return res.end('Bad request'); }
  try {
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (pathname === '/share.svg' && req.method === 'GET') {
      const svg = qr.svg(publicOrigin(req) + '/', { fg: '#7A2205', bg: '#ffffff' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' }); return res.end(svg);
    }
    if (pathname === '/api/config' && req.method === 'GET') return send(res, 200, { origin: publicOrigin(req), demo: true, signupBonus: SIGNUP_BONUS });
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('[error]', e && e.stack || e);
    if (!res.headersSent) send(res, 500, { error: 'Terjadi kesalahan di server' }); else res.end();
  }
});
server.requestTimeout = 30000; server.headersTimeout = 15000;

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`Jagojek berjalan di http://localhost:${PORT}  (data: ${dbPath})`));
  const bye = () => { server.close(() => { try { db.close(); } catch { } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
module.exports = { server, db, normIdent };
