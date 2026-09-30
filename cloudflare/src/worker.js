/**
 * UniMAP Resources Hub — Cloudflare Worker (static assets + API proxy).
 *
 * Browser ──same origin──▶ this Worker ──server-to-server──▶ Apps Script doPost ──▶ Google Sheets
 *
 * - Static files (dist/) are served by Workers Static Assets; this code only runs for /api/*
 *   (see "run_worker_first" in wrangler.jsonc).
 * - The browser never talks to Google, so Google multi-login (/u/N/) problems cannot occur,
 *   and there are no CORS issues (all requests are same-origin).
 * - This is NOT an open proxy: only the fixed routes below exist, the backend URL comes from a
 *   secret, and redirects are followed only to script.googleusercontent.com (Google's documented
 *   one-time URL for Content Service responses).
 * - Admin session tokens live in an HttpOnly cookie; page JavaScript never sees them.
 *
 * Secrets (wrangler secret put …):  GAS_API_URL, GAS_PROXY_SECRET, IP_HASH_SECRET (optional)
 */

const ADMIN_ACTIONS = new Set([
  'session.me', 'account.changePassword', 'account.updateProfile', 'bootstrap',
  'programmes.save', 'programmes.setActive', 'programmes.delete', 'programmes.reorder',
  'categories.save', 'categories.setActive', 'categories.delete', 'categories.reorder',
  'platforms.save', 'platforms.setActive', 'platforms.delete', 'platforms.reorder',
  'resources.save', 'resources.setActive', 'resources.delete', 'resources.bulk',
  'submissions.approve', 'submissions.reject', 'submissions.saveNotes', 'submissions.reopen', 'submissions.delete',
  'admins.save', 'admins.resetPassword', 'admins.delete',
  'settings.save', 'activity.list', 'analytics.summary', 'system.health', 'system.clearCache'
]);

const COOKIE_SECURE = '__Host-urh_admin';
const COOKIE_DEV = 'urh_admin_dev';          // used only when DEV_BACKEND=1 on plain http://localhost
const MAX_BODY = 32 * 1024;                    // request bodies from the browser
const MAX_BACKEND_BODY = 8 * 1024 * 1024;      // responses from Apps Script
const BACKEND_TIMEOUT_MS = 28000;             // POST of a write (never retried)
const SAFE_POST_TIMEOUT_MS = 15000;           // POST of a read / login (retried once)
const REDIRECT_TIMEOUT_MS = 10000;            // GET of the script output (retried once)
const SLOW_BACKEND_MS = 8000;                 // log calls slower than this
const RETRY_SAFE_ACTIONS = new Set(['public.data', 'health', 'auth.login', 'auth.logout']);
const ADMIN_READ_ACTIONS = new Set(['session.me', 'bootstrap', 'activity.list', 'analytics.summary', 'system.health']);
const PUBLIC_TTL_MS = 60 * 1000;               // fresh window for the in-memory public cache
const PUBLIC_STALE_MS = 6 * 60 * 60 * 1000;    // serve last good copy for up to 6 h if Google is down
const TOKEN_RE = /^[a-f0-9]{64}$/;

// Per-isolate memory cache for public data (the Cache API has no effect on *.workers.dev).
let publicMemo = null; // { body: string, at: number }
let publicInflight = null;

export default {
  async fetch(request, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    let response;
    try {
      maybeFlushAnalytics(env, ctx, false);
      response = await route(request, env, ctx, url);
    } catch (err) {
      console.error('API error:', err && err.stack ? err.stack : String(err));
      response = json({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: 'The service is temporarily unavailable. Please try again.' } }, 502);
    }
    return secureHeaders(response);
  }
};

/** Secrets pasted into a terminal can pick up stray whitespace/newlines — normalise them once. */
function cleanEnv(env) {
  const out = Object.create(env);
  for (const k of ['GAS_API_URL', 'GAS_PROXY_SECRET', 'IP_HASH_SECRET', 'GAS_REDIRECT_HOST', 'DEV_BACKEND', 'TIMEOUT_SCALE']) {
    if (typeof env[k] === 'string') Object.defineProperty(out, k, { value: env[k].trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------- Routing

async function route(request, env, ctx, url) {
  const config = checkConfig(env);
  if (!config.ok) {
    console.error('Worker misconfigured:', config.reason);
    return json({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'The service is not configured yet.' } }, 503);
  }
  const key = request.method + ' ' + url.pathname;
  switch (key) {
    case 'GET /api/public': return publicData(env, ctx);
    case 'GET /api/health': return health(env);
    case 'POST /api/submit': return guarded(request, env, submit);
    case 'POST /api/admin/login': return guarded(request, env, login);
    case 'POST /api/admin/logout': return guarded(request, env, logout);
    case 'POST /api/admin/call': return guarded(request, env, adminCall);
    case 'POST /api/collect': return guarded(request, env, (req, e, body) => collect(req, e, body, ctx));
    default: {
      const known = ['/api/public', '/api/health', '/api/submit', '/api/admin/login', '/api/admin/logout', '/api/admin/call', '/api/collect'];
      if (known.includes(url.pathname)) return json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, 405);
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
    }
  }
}

function checkConfig(env) {
  const dev = env.DEV_BACKEND === '1';
  const u = String(env.GAS_API_URL || '');
  const prodRe = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
  const devRe = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[A-Za-z0-9_\/-]*$/;
  if (!(prodRe.test(u) || (dev && devRe.test(u)))) return { ok: false, reason: 'GAS_API_URL missing or not an Apps Script /exec URL' };
  if (String(env.GAS_PROXY_SECRET || '').length < 32) return { ok: false, reason: 'GAS_PROXY_SECRET missing or shorter than 32 characters' };
  return { ok: true };
}

/** CSRF + input checks for every state-changing request, then runs the handler with parsed JSON. */
async function guarded(request, env, handler) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (!origin || origin !== url.origin) {
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Cross-site request refused.' } }, 403);
  }
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') {
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Cross-site request refused.' } }, 403);
  }
  const ct = request.headers.get('Content-Type') || '';
  if (!/^application\/json\b/i.test(ct)) {
    return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Expected JSON.' } }, 415);
  }
  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > MAX_BODY) return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Request too large.' } }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Request too large.' } }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request.' } }, 400);
  }
  return handler(request, env, body);
}

// ---------------------------------------------------------------------------- Handlers

async function publicData(env, ctx) {
  const now = Date.now();
  if (publicMemo && now - publicMemo.at < PUBLIC_TTL_MS) {
    return raw(publicMemo.body, 200, { 'Cache-Control': 'no-cache', 'X-Hub-Cache': 'HIT' });
  }
  try {
    if (!publicInflight) {
      publicInflight = callBackend(env, 'public.data', {}, '').finally(() => { publicInflight = null; });
    }
    const data = await publicInflight;
    if (data.ok) {
      const body = JSON.stringify(data);
      publicMemo = { body, at: Date.now() };
      return raw(body, 200, { 'Cache-Control': 'no-cache', 'X-Hub-Cache': 'MISS' });
    }
    if (publicMemo && now - publicMemo.at < PUBLIC_STALE_MS) {
      return raw(publicMemo.body, 200, { 'Cache-Control': 'no-cache', 'X-Hub-Cache': 'STALE' });
    }
    return json(publicError(data), 503);
  } catch (err) {
    if (publicMemo && now - publicMemo.at < PUBLIC_STALE_MS) {
      console.error('Backend failed, serving stale public data:', String(err));
      return raw(publicMemo.body, 200, { 'Cache-Control': 'no-cache', 'X-Hub-Cache': 'STALE' });
    }
    throw err;
  }
}

let healthMemo = null; // avoid turning /api/health into a way to spend Apps Script executions
async function health(env) {
  if (healthMemo && Date.now() - healthMemo.at < 30000) return json(healthMemo.body, healthMemo.status);
  const started = Date.now();
  const data = await callBackend(env, 'health', {}, '');
  const body = { ok: !!data.ok, data: { backend: data.ok ? 'ok' : 'error', version: data.data && data.data.version, ms: Date.now() - started } };
  healthMemo = { at: Date.now(), body, status: data.ok ? 200 : 503 };
  return json(body, healthMemo.status);
}

async function submit(request, env, body) {
  if (!body.form || typeof body.form !== 'object' || Array.isArray(body.form)) {
    return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid submission.' } }, 400);
  }
  const form = pick(body.form, ['resource_type', 'full_name', 'programme_id', 'intake', 'platform', 'resource_url', 'notes', 'website', 'elapsed_ms', 'client_id']);
  const data = await callBackend(env, 'public.submit', { form }, await ipHash(request, env));
  return json(publicError(data), 200);
}

async function login(request, env, body) {
  if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.email.length > 200 || body.password.length > 256) {
    return json({ ok: false, error: { code: 'INVALID_LOGIN', message: 'Incorrect email or password.' } }, 200);
  }
  // bootstrap:true → the dashboard data comes back with the login (one Apps Script call instead of two).
  const data = await callBackend(env, 'auth.login', { email: body.email, password: body.password, bootstrap: true }, await ipHash(request, env));
  if (data.ok && data.data && TOKEN_RE.test(String(data.data.token || ''))) {
    const token = data.data.token;
    delete data.data.token;
    return json(data, 200, { 'Set-Cookie': sessionCookie(env, token, request) });
  }
  return json(publicError(data), 200);
}

async function logout(request, env) {
  const token = readSession(request, env);
  if (token) {
    try { await callBackend(env, 'auth.logout', { token }, await ipHash(request, env)); } catch (e) { /* cookie is cleared anyway */ }
  }
  return json({ ok: true, data: true }, 200, { 'Set-Cookie': clearCookie(env, request) });
}

async function adminCall(request, env, body) {
  const action = body.action;
  if (typeof action !== 'string' || !ADMIN_ACTIONS.has(action)) {
    return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown action.' } }, 404);
  }
  const payload = body.payload === undefined ? {} : body.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request.' } }, 400);
  }
  const token = readSession(request, env);
  if (!token) {
    return json({ ok: false, error: { code: 'AUTH_REQUIRED', message: '' } }, 200, { 'Set-Cookie': clearCookie(env, request) });
  }
  const data = await callBackend(env, 'admin', { token, action, payload }, await ipHash(request, env));
  const headers = {};
  if (data.ok && data.data && typeof data.data === 'object' && 'token' in data.data) {
    // Password change issues a new session token → rotate the cookie, never expose the token.
    const next = String(data.data.token || '');
    delete data.data.token;
    if (TOKEN_RE.test(next)) headers['Set-Cookie'] = sessionCookie(env, next, request);
  }
  if (!data.ok && data.error && data.error.code === 'AUTH_REQUIRED') headers['Set-Cookie'] = clearCookie(env, request);
  if (data.ok && touchesPublicContent(data.delta, action)) publicMemo = null; // next public request re-reads
  return json(publicError(data), 200, headers);
}

const CONTENT_TABLES = ['Programmes', 'Resources', 'Categories', 'Platforms', 'Settings'];
function touchesPublicContent(delta, action) {
  if (action === 'settings.save' || action === 'system.clearCache') return true;
  if (!delta || typeof delta !== 'object') return false;
  const names = Object.keys(delta.upsert || {}).concat(Object.keys(delta.remove || {}));
  return names.some((n) => CONTENT_TABLES.includes(n));
}

// ---------------------------------------------------------------------------- Anonymous analytics
//
// The browser posts tiny anonymous events to /api/collect. Nothing identifying is kept:
//   - bots are dropped; the user agent is reduced to device type + browser family;
//   - the country is Cloudflare's 2-letter code; the referrer is a host name only;
//   - unique visitors use a keyed hash of (day, IP, user agent) that changes every day and
//     is only used by Apps Script to avoid double counting (never stored in the sheet).
// Events are added up in memory and sent to Apps Script as ONE aggregated batch about once a
// minute (or every 200 events), in the background (ctx.waitUntil), so pages never wait.
// A batch still in memory when Cloudflare recycles the instance is lost: counts are estimates.

const ANALYTICS_FLUSH_MS = 60 * 1000;
const ANALYTICS_FLUSH_EVENTS = 200;
const ANALYTICS_MAX_KEYS = 500;
const ANALYTICS_MAX_EVENTS_PER_REQUEST = 30;
const ANALYTICS_IP_LIMIT = 300;                 // events per hashed IP per 10 minutes (per instance)
const BOT_RE = /bot|crawl|spider|slurp|preview|fetch|monitor|headless|lighthouse|pingdom|curl|wget|python|java\/|go-http|axios|node-fetch|facebookexternalhit|whatsapp|telegram|discord|embedly/i;
const PAGE_RE = /^(home|search|programme|official|submit|about|notfound)(:[a-z0-9-]{1,80})?$/;
const PROG_RE = /^prg_[a-z0-9]{6,40}$/;
const RES_RE = /^res_[a-z0-9]{6,40}$/;
const HOST_RE = /^[a-z0-9.-]{1,80}$/;

let analyticsBuf = newAnalyticsBuffer();
const analyticsIpCount = new Map();

function newAnalyticsBuffer() { return { counts: new Map(), visitors: new Set(), events: 0, since: 0 }; }

function addCount(metric, key, n) {
  const k = metric + '\u0001' + key;
  if (!analyticsBuf.counts.has(k) && analyticsBuf.counts.size >= ANALYTICS_MAX_KEYS) return;
  analyticsBuf.counts.set(k, (analyticsBuf.counts.get(k) || 0) + (n || 1));
}

function deviceType(ua) {
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}
function browserFamily(ua) {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}
function referrerKey(host, ownHost) {
  host = String(host || '').toLowerCase().replace(/^www\./, '').slice(0, 80);
  if (!host || !HOST_RE.test(host) || host === ownHost.replace(/^www\./, '')) return 'direct';
  if (/(^|\.)google\./.test(host)) return 'google';
  if (/(^|\.)bing\.com$/.test(host)) return 'bing';
  if (/(^|\.)(facebook\.com|fb\.com)$/.test(host)) return 'facebook';
  if (/(^|\.)(instagram\.com)$/.test(host)) return 'instagram';
  if (/(^|\.)(t\.co|twitter\.com|x\.com)$/.test(host)) return 'x.com';
  if (/(^|\.)(linkedin\.com|lnkd\.in)$/.test(host)) return 'linkedin';
  return host;
}
function malaysiaDate(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }

async function dailyVisitorHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return '';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 300);
  const secret = String(env.IP_HASH_SECRET || env.GAS_PROXY_SECRET);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('uv|' + malaysiaDate(Date.now()) + '|' + ip + '|' + ua));
  return Array.from(new Uint8Array(sig)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function collect(request, env, body, ctx) {
  const done = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const ua = request.headers.get('User-Agent') || '';
  const events = Array.isArray(body.events) ? body.events.slice(0, ANALYTICS_MAX_EVENTS_PER_REQUEST) : [];
  if (!ua || BOT_RE.test(ua) || !events.length) return done();

  // Per-instance flood guard (keyed by the same hashed IP used for other rate limits).
  const ipKey = await ipHash(request, env);
  const now = Date.now();
  if (ipKey) {
    const slot = analyticsIpCount.get(ipKey);
    if (!slot || now - slot.at > 10 * 60 * 1000) analyticsIpCount.set(ipKey, { at: now, n: events.length });
    else { slot.n += events.length; if (slot.n > ANALYTICS_IP_LIMIT) return done(); }
    if (analyticsIpCount.size > 5000) analyticsIpCount.clear();
  }

  const ownHost = new URL(request.url).hostname.toLowerCase();
  let accepted = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.t) {
      case 'visit': {
        addCount('visit', '');
        addCount('device', deviceType(ua));
        addCount('browser', browserFamily(ua));
        const country = String((request.cf && request.cf.country) || '').toUpperCase();
        if (/^[A-Z]{2}$/.test(country) && country !== 'XX' && country !== 'T1') addCount('country', country);
        addCount('referrer', referrerKey(typeof ev.ref === 'string' ? ev.ref : '', ownHost));
        const h = await dailyVisitorHash(request, env);
        if (h && analyticsBuf.visitors.size < 2000) analyticsBuf.visitors.add(h);
        accepted++;
        break;
      }
      case 'pv':
        if (typeof ev.p === 'string' && PAGE_RE.test(ev.p)) { addCount('pageview', ''); addCount('page', ev.p); accepted++; }
        if (typeof ev.id === 'string' && PROG_RE.test(ev.id)) addCount('programme', ev.id);
        break;
      case 'click':
        if (typeof ev.id === 'string' && RES_RE.test(ev.id)) { addCount('click', ev.id); accepted++; }
        break;
      case 'search':
        addCount('search', ''); if (ev.empty === true) addCount('search_empty', ''); accepted++;
        break;
      default: break;
    }
  }
  if (accepted) {
    if (!analyticsBuf.events) analyticsBuf.since = now;
    analyticsBuf.events += accepted;
  }
  maybeFlushAnalytics(env, ctx, false);
  return done();
}

/** Sends the in-memory counters to Apps Script in the background when they are due. */
function maybeFlushAnalytics(env, ctx, force) {
  const b = analyticsBuf;
  if (!b.events) return false;
  if (!force && b.events < ANALYTICS_FLUSH_EVENTS && Date.now() - b.since < ANALYTICS_FLUSH_MS * timeoutScale(env)) return false;
  analyticsBuf = newAnalyticsBuffer();
  const counts = [];
  for (const [k, n] of b.counts) { const i = k.indexOf('\u0001'); counts.push([k.slice(0, i), k.slice(i + 1), n]); }
  const payload = { counts, visitors: Array.from(b.visitors) };
  const task = callBackend(env, 'analytics.ingest', payload, '')
    .then((res) => { if (!res || !res.ok) console.warn('Analytics batch not stored:', res && res.error && res.error.code); })
    .catch((err) => console.warn('Analytics batch dropped:', err && err.message));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  return true;
}

// ---------------------------------------------------------------------------- Backend call

/**
 * POSTs to the Apps Script web app and follows Google's documented redirect to a one-time
 * script.googleusercontent.com URL (Content Service). The redirect is followed manually with
 * GET, and only to that host, so the Worker can never be steered to another server.
 */
async function callBackend(env, action, payload, clientIpHash) {
  // Read-only calls (and login, whose repeat is harmless) may be retried once if Google's
  // front end stalls. Writes are never re-sent: the script may already have run them.
  const retrySafe = RETRY_SAFE_ACTIONS.has(action) || (action === 'admin' && ADMIN_READ_ACTIONS.has(payload && payload.action));
  const scale = timeoutScale(env);
  const postTimeout = Math.round((retrySafe ? SAFE_POST_TIMEOUT_MS : BACKEND_TIMEOUT_MS) * scale);
  try {
    return await callBackendOnce(env, action, payload, clientIpHash, postTimeout, scale);
  } catch (err) {
    if (!retrySafe || !err.transient) throw err;
    console.warn('Backend retry (' + action + ') after ' + err.phase + ' failure: ' + err.message);
    return await callBackendOnce(env, action, payload, clientIpHash, postTimeout, scale);
  }
}

/** Local tests only (DEV_BACKEND=1) may shrink the backend timeouts. */
function timeoutScale(env) {
  const v = parseFloat(env.TIMEOUT_SCALE);
  return env.DEV_BACKEND === '1' && v > 0 && v <= 1 ? v : 1;
}

async function callBackendOnce(env, action, payload, clientIpHash, postTimeout, scale) {
  const started = Date.now();
  let phase = 'post';
  let text;
  try {
    const body = JSON.stringify({ secret: env.GAS_PROXY_SECRET, action, payload, client: { ip_hash: clientIpHash || '' } });
    let res = await fetch(env.GAS_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'manual',
      signal: AbortSignal.timeout(postTimeout)
    });
    let hops = 0;
    while (res.status >= 300 && res.status < 400) {
      if (++hops > 3) throw new Error('Too many redirects from backend');
      const loc = res.headers.get('Location');
      discardBody(res);
      if (!loc) throw new Error('Redirect without Location from backend');
      const next = new URL(loc, env.GAS_API_URL);
      if (!redirectAllowed(next, env)) throw new Error('Refused redirect to ' + next.hostname);
      phase = 'redirect';
      // Fetching the script's stored output is read-only, so a stalled GET is retried once.
      res = await fetchRedirect(next.toString(), Math.round(REDIRECT_TIMEOUT_MS * scale));
    }
    phase = 'body';
    if (res.status !== 200) {
      discardBody(res);
      const e = new Error('Backend HTTP ' + res.status);
      // 5xx, or 404 from the one-time output URL after a retried GET: a read can be re-run.
      if (res.status >= 500 || (res.status === 404 && hops > 0)) e.transient = true;
      throw e;
    }
    text = res.bodyText !== undefined ? res.bodyText : await res.text();
  } catch (err) {
    // Wrap (DOMException.message is read-only) and tag where and after how long it failed.
    const name = err && err.name ? err.name : 'Error';
    const e = new Error('[' + action + ' ' + phase + ' ' + (Date.now() - started) + 'ms] ' + name + ': ' + (err && err.message ? err.message : String(err)));
    e.transient = !!(err && err.transient) || name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError';
    e.phase = phase;
    throw e;
  }
  const ms = Date.now() - started;
  if (ms > SLOW_BACKEND_MS) console.log('Slow backend call: ' + action + ' ' + ms + 'ms');
  if (text.length > MAX_BACKEND_BODY) throw new Error('Backend response too large');
  let data;
  try { data = JSON.parse(text); } catch (e) {
    // Usually means the deployment is not "Anyone" / not a web app, and Google returned an HTML page.
    throw new Error('Backend returned non-JSON (check the Apps Script deployment access settings)');
  }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') throw new Error('Backend returned an unexpected shape');
  if (!data.ok && data.error && (data.error.code === 'API_DISABLED' || (data.error.code === 'FORBIDDEN' && action !== 'admin'))) {
    throw new Error('Backend refused the proxy (' + data.error.code + ') — check PROXY_SHARED_SECRET / GAS_PROXY_SECRET');
  }
  return data;
}

/** GET the script output (headers + body) within one timeout; one retry on a stall/network error. */
async function fetchRedirect(url, timeoutMs) {
  for (let attempt = 1; ; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal });
      if (res.status !== 200) return res;
      const bodyText = await res.text();
      return { status: 200, headers: res.headers, bodyText };
    } catch (err) {
      const transient = err && (err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError');
      if (attempt >= 2 || !transient) throw err;
      console.warn('Retrying backend output fetch after: ' + (err && err.message));
    }
  }
}

/** Release an unread response body so the connection is not held open. */
function discardBody(res) {
  try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch (e) { /* ignore */ }
}

function redirectAllowed(u, env) {
  if (u.protocol === 'https:' && u.hostname === (env.GAS_REDIRECT_HOST || 'script.googleusercontent.com')) return true;
  if (env.DEV_BACKEND === '1' && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  return false;
}

// ---------------------------------------------------------------------------- Helpers

async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return '';
  const keyMaterial = new TextEncoder().encode(String(env.IP_HASH_SECRET || env.GAS_PROXY_SECRET));
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function cookieName(env, request) {
  const secure = new URL(request.url).protocol === 'https:';
  return secure || env.DEV_BACKEND !== '1' ? COOKIE_SECURE : COOKIE_DEV;
}

function sessionCookie(env, token, request) {
  const name = cookieName(env, request);
  const secure = name === COOKIE_SECURE ? '; Secure' : '';
  // Session cookie (no Max-Age): the server-side idle timeout still applies.
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

function clearCookie(env, request) {
  const name = cookieName(env, request);
  const secure = name === COOKIE_SECURE ? '; Secure' : '';
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function readSession(request, env) {
  const header = request.headers.get('Cookie') || '';
  const name = cookieName(env, request);
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const token = v.join('=');
      return TOKEN_RE.test(token) ? token : '';
    }
  }
  return '';
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 4096);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Only pass through the documented response shape. */
function publicError(data) {
  if (data.ok) return data;
  const e = data.error || {};
  return { ok: false, error: { code: String(e.code || 'SERVER_ERROR'), message: String(e.message || ''), field: e.field || null, params: e.params || null } };
}

function json(obj, status, headers) {
  return raw(JSON.stringify(obj), status, headers);
}

function raw(body, status, headers) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {})
  });
}

function secureHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  r.headers.set('X-Frame-Options', 'DENY');
  r.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return r;
}
