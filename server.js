// ANQA (عنقا) — سرور بدون وابستگی (فقط Node 18+)
// کلید API فقط اینجا (سمت سرور) نگه‌داری می‌شود و هرگز به مرورگر نمی‌رسد.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- env ---------- */
try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const PORT = +process.env.PORT || 3000;
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_BASE = (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/$/, '');
const VIS = { key: process.env.VISION_API_KEY || '', base: (process.env.VISION_BASE || '').replace(/\/$/, ''), model: process.env.VISION_MODEL || '' };
const DAILY_LIMIT = +process.env.DAILY_LIMIT || 300;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE = path.join(DATA, 'img-cache');
fs.mkdirSync(CACHE, { recursive: true });

/* ---------- storage ---------- */
const USERS_F = path.join(DATA, 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_F, 'utf8')); } catch {}
const saveUsers = () => { const t = USERS_F + '.tmp'; fs.writeFileSync(t, JSON.stringify(users)); fs.renameSync(t, USERS_F); };
const SECRET_F = path.join(DATA, 'secret');
let SECRET = process.env.APP_SECRET || '';
if (!SECRET) { try { SECRET = fs.readFileSync(SECRET_F, 'utf8'); } catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_F, SECRET, { mode: 0o600 }); } }

/* ---------- auth helpers ---------- */
const b64u = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const mkToken = (uid, days = 30) => { const p = b64u(JSON.stringify({ u: uid, e: Date.now() + days * 864e5 })); return p + '.' + sign(p); };
function readToken(t) {
  if (!t || typeof t !== 'string') return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const good = sign(p);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const j = JSON.parse(Buffer.from(p, 'base64url')); if (j.e < Date.now() || !users[j.u]) return null; return users[j.u]; } catch { return null; }
}
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPw = (pw, u) => { const h = crypto.scryptSync(pw, u.salt, 64); const o = Buffer.from(u.hash, 'hex'); return h.length === o.length && crypto.timingSafeEqual(h, o); };
const normUser = s => String(s || '').trim().toLowerCase().replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));

/* ---------- rate limiting ---------- */
const hits = new Map();
function limited(key, max, ms) {
  const n = Date.now(); const a = (hits.get(key) || []).filter(t => n - t < ms);
  a.push(n); hits.set(key, a); return a.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 36e5)) hits.delete(k); }, 6e5).unref();

/* ---------- http helpers ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...SEC }); res.end(JSON.stringify(obj)); };
const readBody = (req, max = 3e6) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', d => { n += d.length; if (n > max) { no(new Error('حجم درخواست زیاد است')); req.destroy(); } else c.push(d); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { no(new Error('درخواست نامعتبر')); } });
  req.on('error', no);
});
const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const pub = u => ({ id: u.id, name: u.name, username: u.username });
const authed = req => readToken((req.headers.authorization || '').replace(/^Bearer /, ''));

/* ---------- AI ---------- */
const SYS = `تو «عنقا» (ANQA) هستی؛ یک دستیار هوشمند، گرم، دقیق و باادب. پیش‌فرض به فارسی روان و طبیعی پاسخ بده، مگر کاربر زبان دیگری بخواهد یا به آن زبان بنویسد. خلاصه ولی کامل بنویس و در صورت نیاز از مارک‌داون (فهرست، جدول، بلوک کد) استفاده کن. هنگام خلاصه‌سازی سند، اول نکات کلیدی را بگو و بعد جزئیات. هرگز درباره‌ی فایلی که ندیده‌ای چیزی از خودت نساز. نام کاربر: `;
function cleanMessages(msgs, name, think) {
  if (!Array.isArray(msgs)) throw new Error('پیام‌ها نامعتبر است');
  const out = [{ role: 'system', content: SYS + name + (think ? '\nقبل از پاسخ، گام‌به‌گام و با دقت استدلال کن.' : '') }];
  let hasImg = false;
  for (const m of msgs.slice(-24)) {
    if (!m || !['user', 'assistant'].includes(m.role)) continue;
    if (typeof m.content === 'string') out.push({ role: m.role, content: m.content.slice(0, 120000) });
    else if (Array.isArray(m.content) && m.role === 'user') {
      hasImg = true;
      out.push({ role: 'user', content: m.content.slice(0, 6).map(p => p.type === 'image_url' ? { type: 'image_url', image_url: { url: String(p.image_url?.url || '').slice(0, 2.5e6) } } : { type: 'text', text: String(p.text || '').slice(0, 120000) }) });
    }
  }
  return { out, hasImg };
}
async function upstreamChat(messages, { stream, think, hasImg }) {
  let base = DS_BASE, key = DS_KEY, model = think ? 'deepseek-reasoner' : 'deepseek-chat';
  if (hasImg) { base = VIS.base; key = VIS.key; model = VIS.model; }
  if (!key) throw Object.assign(new Error('کلید API روی سرور تنظیم نشده است.'), { code: 503 });
  const body = { model, messages, stream: !!stream };
  if (!think || hasImg) body.temperature = 0.7;
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  if (!r.ok) {
    let t = await r.text(); try { t = JSON.parse(t).error?.message || t; } catch {}
    console.error('upstream', r.status, t.slice(0, 200));
    throw Object.assign(new Error(r.status === 402 ? 'اعتبار حساب هوش مصنوعی تمام شده است.' : r.status === 401 ? 'کلید API نامعتبر است.' : r.status === 429 ? 'ترافیک زیاد است؛ چند ثانیه دیگر دوباره امتحان کن.' : 'خطای سرویس هوش مصنوعی (' + r.status + ')'), { code: 502 });
  }
  return r;
}
function quota(u) {
  const d = new Date().toISOString().slice(0, 10);
  if (u.qd !== d) { u.qd = d; u.qn = 0; }
  if (u.qn >= DAILY_LIMIT) return false;
  u.qn++; return true;
}

/* ---------- routes ---------- */
async function api(req, res, url) {
  const r = url.pathname;
  if (r === '/api/config' && req.method === 'GET') return json(res, 200, { vision: !!(VIS.key && VIS.base && VIS.model), ready: !!DS_KEY });

  if (r === '/api/register' && req.method === 'POST') {
    if (limited('reg:' + ip(req), 8, 36e5)) return json(res, 429, { error: 'تعداد ثبت‌نام از این شبکه زیاد است. بعداً تلاش کن.' });
    const b = await readBody(req, 5e3);
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    const username = normUser(b.username);
    const pw = String(b.password || '');
    if (name.length < 2) return json(res, 400, { error: 'نام را وارد کن (حداقل ۲ حرف).' });
    if (!/^[a-z0-9_.@+-]{3,40}$/.test(username)) return json(res, 400, { error: 'نام کاربری: ۳ تا ۴۰ حرف انگلیسی/عدد (یا شماره موبایل/ایمیل).' });
    if (pw.length < 6) return json(res, 400, { error: 'رمز عبور حداقل ۶ نویسه باشد.' });
    if (Object.values(users).some(u => u.username === username)) return json(res, 409, { error: 'این نام کاربری قبلاً ثبت شده است.' });
    const id = crypto.randomUUID();
    users[id] = { id, name, username, ...hashPw(pw), created: Date.now(), qd: '', qn: 0 };
    saveUsers();
    return json(res, 200, { token: mkToken(id), user: pub(users[id]) });
  }
  if (r === '/api/login' && req.method === 'POST') {
    if (limited('login:' + ip(req), 12, 6e5)) return json(res, 429, { error: 'تلاش‌های ناموفق زیاد بود. ۱۰ دقیقه دیگر دوباره امتحان کن.' });
    const b = await readBody(req, 5e3);
    const u = Object.values(users).find(x => x.username === normUser(b.username));
    if (!u || !checkPw(String(b.password || ''), u)) return json(res, 401, { error: 'نام کاربری یا رمز عبور درست نیست.' });
    return json(res, 200, { token: mkToken(u.id), user: pub(u) });
  }

  // GET /api/img — پراکسی تصویر (توکن در query چون تگ <img> هدر ندارد)
  if (r === '/api/img' && req.method === 'GET') {
    const u = readToken(url.searchParams.get('t'));
    if (!u) return json(res, 401, { error: 'ورود لازم است' });
    const p = (url.searchParams.get('p') || '').slice(0, 1500);
    const w = Math.min(1536, Math.max(256, +url.searchParams.get('w') || 1024));
    const h = Math.min(1536, Math.max(256, +url.searchParams.get('h') || 1024));
    const seed = +url.searchParams.get('s') || 1;
    const model = ['flux', 'turbo'].includes(url.searchParams.get('m')) ? url.searchParams.get('m') : 'flux';
    if (!p) return json(res, 400, { error: 'پرامپت خالی است' });
    const key = crypto.createHash('sha1').update([p, w, h, seed, model].join('|')).digest('hex');
    const f = path.join(CACHE, key + '.img');
    if (!fs.existsSync(f)) {
      if (limited('img:' + u.id, 30, 36e5)) return json(res, 429, { error: 'سقف ساخت تصویر در ساعت پر شده است.' });
      const pr = `https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=${w}&height=${h}&seed=${seed}&model=${model}&nologo=true&enhance=false`;
      const up = await fetch(pr, { signal: AbortSignal.timeout(120000) });
      if (!up.ok || !(up.headers.get('content-type') || '').startsWith('image/')) return json(res, 502, { error: 'سرویس تصویر پاسخ نداد' });
      fs.writeFileSync(f, Buffer.from(await up.arrayBuffer()));
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000', ...SEC });
    return fs.createReadStream(f).pipe(res);
  }

  const user = authed(req);
  if (!user) return json(res, 401, { error: 'ورود لازم است' });

  if (r === '/api/me' && req.method === 'GET') return json(res, 200, { user: pub(user) });

  if (r === '/api/chat' && req.method === 'POST') {
    const b = await readBody(req);
    if (limited('chat:' + user.id, 40, 6e4)) return json(res, 429, { error: 'خیلی سریع پیام می‌دهی؛ کمی صبر کن.' });
    if (!quota(user)) return json(res, 429, { error: 'سهمیه‌ی امروز تمام شد. فردا دوباره بیا.' });
    saveUsers();
    const { out, hasImg } = cleanMessages(b.messages, user.name, !!b.think);
    if (hasImg && !(VIS.key && VIS.base && VIS.model)) return json(res, 400, { error: 'تحلیل مستقیم تصویر روی این سرور فعال نیست.' });
    const up = await upstreamChat(out, { stream: true, think: !!b.think && !hasImg, hasImg });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...SEC });
    const rd = up.body.getReader();
    req.on('close', () => rd.cancel().catch(() => {}));
    try { for (;;) { const { done, value } = await rd.read(); if (done) break; res.write(value); } } catch {}
    return res.end();
  }

  if (r === '/api/image' && req.method === 'POST') {
    const b = await readBody(req, 2e4);
    const prompt = String(b.prompt || '').trim().slice(0, 800);
    if (!prompt) return json(res, 400, { error: 'توضیح تصویر خالی است' });
    if (limited('imgreq:' + user.id, 12, 6e4)) return json(res, 429, { error: 'کمی صبر کن و دوباره بساز.' });
    let en = prompt;
    try {
      const { out } = cleanMessages([{ role: 'user', content: prompt }], '', false);
      out[0].content = 'You are an expert prompt engineer for text-to-image models (Flux). Convert the user idea (Persian or any language) into ONE vivid, detailed English image prompt: subject, composition, lighting, mood, art style, camera/lens, colour palette, quality keywords. Preserve cultural details faithfully (Persian/Islamic architecture, calligraphy, clothing). Output ONLY the prompt, max 90 words.';
      const up = await upstreamChat(out, { stream: false, think: false });
      en = String((await up.json()).choices[0].message.content).trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 1200) || prompt;
    } catch (e) { console.error('enhance failed:', e.message); }
    const [w, h] = ({ '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344] })[b.ratio] || [1024, 1024];
    const q = new URLSearchParams({ p: en, w, h, s: Math.floor(Math.random() * 1e9), m: b.model === 'turbo' ? 'turbo' : 'flux', t: mkToken(user.id, 365) });
    return json(res, 200, { prompt: en, url: '/api/img?' + q });
  }
  return json(res, 404, { error: 'یافت نشد' });
}

/* ---------- static ---------- */
const PUBLIC = path.join(__dirname, 'public');
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, SEC); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=86400', ...SEC });
  fs.createReadStream(f).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    serveStatic(req, res, url);
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) json(res, e.code || 500, { error: e.message || 'خطای سرور' }); else res.end();
  }
}).listen(PORT, () => console.log(`ANQA running on :${PORT}  (AI key: ${DS_KEY ? 'set' : 'MISSING'})`));
