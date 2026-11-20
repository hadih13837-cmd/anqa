// ANQA (عنقا) — سرور روی Cloudflare Workers (رایگان)
// متغیرهای لازم: DEEPSEEK_API_KEY (Secret), APP_SECRET (Secret), و KV با نام USERS
// اختیاری: ALLOWED_ORIGIN (مثلاً https://hadih13837-cmd.github.io), DAILY_LIMIT, VISION_BASE/VISION_API_KEY/VISION_MODEL
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
async function pbkdf(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const normUser = s => String(s || '').trim().toLowerCase().replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
const pub = u => ({ id: u.id, name: u.name, username: u.username });

async function mkToken(env, username, days = 30) {
  const p = b64u(enc.encode(JSON.stringify({ u: username, e: Date.now() + days * 864e5 })));
  return p + '.' + await hmac(env.APP_SECRET, p);
}
async function readToken(env, t) {
  if (!t || typeof t !== 'string') return null;
  const [p, s] = t.split('.'); if (!p || !s) return null;
  if (!safeEq(s, await hmac(env.APP_SECRET, p))) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(unb64u(p)));
    if (j.e < Date.now()) return null;
    const u = await env.USERS.get('u:' + j.u, 'json');
    return u || null;
  } catch { return null; }
}

const SYS = `تو «عنقا» (ANQA) هستی؛ یک دستیار هوشمند، گرم، دقیق و باادب. پیش‌فرض به فارسی روان و طبیعی پاسخ بده، مگر کاربر زبان دیگری بخواهد یا به آن زبان بنویسد. خلاصه ولی کامل بنویس و در صورت نیاز از مارک‌داون (فهرست، جدول، بلوک کد) استفاده کن. هنگام خلاصه‌سازی سند، اول نکات کلیدی را بگو و بعد جزئیات. هرگز درباره‌ی فایلی که ندیده‌ای چیزی از خودت نساز. نام کاربر: `;
function cleanMessages(msgs, name, think) {
  if (!Array.isArray(msgs)) throw httpErr(400, 'پیام‌ها نامعتبر است');
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
const httpErr = (code, message) => Object.assign(new Error(message), { code });

async function upstream(env, messages, { stream, think, hasImg }) {
  let base = 'https://api.deepseek.com', key = env.DEEPSEEK_API_KEY, model = think ? 'deepseek-reasoner' : 'deepseek-chat';
  if (hasImg) { base = (env.VISION_BASE || '').replace(/\/$/, ''); key = env.VISION_API_KEY; model = env.VISION_MODEL; }
  if (!key || !base) throw httpErr(503, 'کلید API روی سرور تنظیم نشده است.');
  const body = { model, messages, stream: !!stream };
  if (!think || hasImg) body.temperature = 0.7;
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
  if (!r.ok) {
    const st = r.status; await r.text().catch(() => {});
    throw httpErr(502, st === 402 ? 'اعتبار حساب هوش مصنوعی تمام شده است.' : st === 401 ? 'کلید API نامعتبر است.' : st === 429 ? 'ترافیک زیاد است؛ چند ثانیه دیگر دوباره امتحان کن.' : 'خطای سرویس هوش مصنوعی (' + st + ')');
  }
  return r;
}

async function bump(env, key, max, ttl) {
  const n = +(await env.USERS.get(key)) || 0;
  if (n >= max) return false;
  await env.USERS.put(key, String(n + 1), { expirationTtl: ttl });
  return true;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allow = env.ALLOWED_ORIGIN ? (origin === env.ALLOWED_ORIGIN ? origin : env.ALLOWED_ORIGIN) : '*';
    const cors = { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Vary': 'Origin' };
    const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (!env.USERS || !env.APP_SECRET) return json(500, { error: 'سرور کامل تنظیم نشده (KV با نام USERS و متغیر APP_SECRET لازم است).' });
      const r = url.pathname;
      const ip = req.headers.get('CF-Connecting-IP') || 'x';
      const body = async (max = 3e6) => { const t = await req.text(); if (t.length > max) throw httpErr(413, 'حجم درخواست زیاد است'); try { return JSON.parse(t || '{}'); } catch { throw httpErr(400, 'درخواست نامعتبر'); } };

      if (r === '/api/config') return json(200, { vision: !!(env.VISION_API_KEY && env.VISION_BASE && env.VISION_MODEL), ready: !!env.DEEPSEEK_API_KEY });

      if (r === '/api/register' && req.method === 'POST') {
        const hr = Math.floor(Date.now() / 36e5);
        if (!await bump(env, `rl:reg:${ip}:${hr}`, 8, 7200)) return json(429, { error: 'تعداد ثبت‌نام از این شبکه زیاد است. بعداً تلاش کن.' });
        const b = await body(5e3);
        const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        const username = normUser(b.username), pw = String(b.password || '');
        if (name.length < 2) return json(400, { error: 'نام را وارد کن (حداقل ۲ حرف).' });
        if (!/^[a-z0-9_.@+-]{3,40}$/.test(username)) return json(400, { error: 'نام کاربری: ۳ تا ۴۰ حرف انگلیسی/عدد (یا شماره موبایل/ایمیل).' });
        if (pw.length < 6) return json(400, { error: 'رمز عبور حداقل ۶ نویسه باشد.' });
        if (await env.USERS.get('u:' + username)) return json(409, { error: 'این نام کاربری قبلاً ثبت شده است.' });
        const saltB = crypto.getRandomValues(new Uint8Array(16));
        const u = { id: crypto.randomUUID(), name, username, salt: hex(saltB), hash: await pbkdf(pw, saltB), created: Date.now() };
        await env.USERS.put('u:' + username, JSON.stringify(u));
        return json(200, { token: await mkToken(env, username), user: pub(u) });
      }
      if (r === '/api/login' && req.method === 'POST') {
        const b = await body(5e3);
        const username = normUser(b.username);
        const m = Math.floor(Date.now() / 6e5);
        if (!await bump(env, `rl:login:${ip}:${m}`, 12, 1200)) return json(429, { error: 'تلاش‌های ناموفق زیاد بود. ۱۰ دقیقه دیگر دوباره امتحان کن.' });
        const u = await env.USERS.get('u:' + username, 'json');
        const saltB = u ? Uint8Array.from(u.salt.match(/../g).map(h => parseInt(h, 16))) : new Uint8Array(16);
        const h = await pbkdf(String(b.password || ''), saltB);
        if (!u || !safeEq(h, u.hash)) return json(401, { error: 'نام کاربری یا رمز عبور درست نیست.' });
        return json(200, { token: await mkToken(env, u.username), user: pub(u) });
      }

      if (r === '/api/img' && req.method === 'GET') {
        const u = await readToken(env, url.searchParams.get('t'));
        if (!u) return json(401, { error: 'ورود لازم است' });
        const p = (url.searchParams.get('p') || '').slice(0, 1500);
        const w = Math.min(1536, Math.max(256, +url.searchParams.get('w') || 1024));
        const h = Math.min(1536, Math.max(256, +url.searchParams.get('h') || 1024));
        const seed = +url.searchParams.get('s') || 1;
        const model = ['flux', 'turbo'].includes(url.searchParams.get('m')) ? url.searchParams.get('m') : 'flux';
        if (!p) return json(400, { error: 'پرامپت خالی است' });
        const up = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(p)}?width=${w}&height=${h}&seed=${seed}&model=${model}&nologo=true&enhance=false`, { cf: { cacheTtl: 86400, cacheEverything: true } });
        if (!up.ok || !(up.headers.get('content-type') || '').startsWith('image/')) return json(502, { error: 'سرویس تصویر پاسخ نداد' });
        return new Response(up.body, { headers: { 'Content-Type': up.headers.get('content-type'), 'Cache-Control': 'public, max-age=31536000', ...cors } });
      }

      const user = await readToken(env, (req.headers.get('Authorization') || '').replace(/^Bearer /, ''));
      if (!user) return json(401, { error: 'ورود لازم است' });

      if (r === '/api/me') return json(200, { user: pub(user) });

      if (r === '/api/chat' && req.method === 'POST') {
        const b = await body();
        const day = new Date().toISOString().slice(0, 10);
        if (!await bump(env, `q:${user.username}:${day}`, +env.DAILY_LIMIT || 300, 172800)) return json(429, { error: 'سهمیه‌ی امروز تمام شد. فردا دوباره بیا.' });
        const { out, hasImg } = cleanMessages(b.messages, user.name, !!b.think);
        if (hasImg && !(env.VISION_API_KEY && env.VISION_BASE && env.VISION_MODEL)) return json(400, { error: 'تحلیل مستقیم تصویر روی این سرور فعال نیست.' });
        const up = await upstream(env, out, { stream: true, think: !!b.think && !hasImg, hasImg });
        return new Response(up.body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...cors } });
      }

      if (r === '/api/image' && req.method === 'POST') {
        const b = await body(2e4);
        const prompt = String(b.prompt || '').trim().slice(0, 800);
        if (!prompt) return json(400, { error: 'توضیح تصویر خالی است' });
        if (!await bump(env, `rl:img:${user.username}:${Math.floor(Date.now() / 36e5)}`, 30, 7200)) return json(429, { error: 'سقف ساخت تصویر در ساعت پر شده است.' });
        let en = prompt;
        try {
          const { out } = cleanMessages([{ role: 'user', content: prompt }], '', false);
          out[0].content = 'You are an expert prompt engineer for text-to-image models (Flux). Convert the user idea (Persian or any language) into ONE vivid, detailed English image prompt: subject, composition, lighting, mood, art style, camera/lens, colour palette, quality keywords. Preserve cultural details faithfully (Persian/Islamic architecture, calligraphy, clothing). Output ONLY the prompt, max 90 words.';
          const up = await upstream(env, out, { stream: false, think: false });
          en = String((await up.json()).choices[0].message.content).trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 1200) || prompt;
        } catch {}
        const [w, h] = ({ '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344] })[b.ratio] || [1024, 1024];
        const q = new URLSearchParams({ p: en, w, h, s: Math.floor(Math.random() * 1e9), m: b.model === 'turbo' ? 'turbo' : 'flux', t: await mkToken(env, user.username, 365) });
        return json(200, { prompt: en, url: url.origin + '/api/img?' + q });
      }
      return json(404, { error: 'یافت نشد' });
    } catch (e) {
      return json(e.code || 500, { error: e.message || 'خطای سرور' });
    }
  }
};
