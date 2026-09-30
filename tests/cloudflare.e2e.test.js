/**
 * cloudflare.e2e.test.js — end-to-end tests of the Cloudflare architecture, locally:
 *
 *   Chromium ──▶ wrangler dev (the real Worker + real built static assets, workerd runtime)
 *                   ──▶ local Apps Script emulation (real src/*.gs running doPost, incl. the
 *                       302 → one-time "googleusercontent" redirect Google documents)
 *
 *   npm run build:cf && NODE_PATH=$(npm root -g) node --test tests/cloudflare.e2e.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { createDevApp } = require('./dev-server');

const SECRET = 'cf-test-secret-' + require('crypto').randomBytes(24).toString('hex');
const BACKEND_PORT = 8798;
const CF_PORT = 8797;
const BASE = `http://localhost:${CF_PORT}`;
const NEW_PW = 'Kedah-Perlis-2026x';
const MOBILE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 820, height: 1180 } };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

let backend, wrangler, browser;

test.before(async () => {
  backend = createDevApp({ latency: 20, proxySecret: SECRET });
  await new Promise((r) => backend.server.listen(BACKEND_PORT, r));
  const cfDir = path.join(__dirname, '..', 'cloudflare');
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(CF_PORT), '--ip', '127.0.0.1',
    '--var', `GAS_API_URL:http://localhost:${BACKEND_PORT}/exec`, '--var', `GAS_PROXY_SECRET:${SECRET}`,
    '--var', 'DEV_BACKEND:1', '--var', 'IP_HASH_SECRET:test-ip-secret', '--var', 'TIMEOUT_SCALE:0.1'], { cwd: cfDir, detached: true, env: Object.assign({}, process.env, { WRANGLER_SEND_METRICS: 'false' }) });
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('wrangler dev did not start:\n' + log)), 60000);
    const onData = (d) => { log += d; if (/Ready on/.test(log)) { clearTimeout(timer); resolve(); } };
    wrangler.stdout.on('data', onData); wrangler.stderr.on('data', onData);
  });
  browser = await chromium.launch();
});

test.after(async () => {
  if (browser) await browser.close();
  if (wrangler) { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch (e) { wrangler.kill('SIGTERM'); } }
  if (backend) backend.server.close();
});

async function open(device, p, errors, googleRequests) {
  const ctx = await browser.newContext(device || DESKTOP);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors && errors.push(e.message));
  page.on('console', (m) => { if (errors && m.type() === 'error' && !/fonts\.g|TUNNEL|ERR_TUNNEL/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => { const h = new URL(r.url()).hostname; if (googleRequests && /google\.com|googleusercontent\.com/.test(h)) googleRequests.push(r.url()); });
  page.on('dialog', async (d) => { errors && errors.push('DIALOG ' + d.message()); await d.dismiss(); });
  await page.goto(BASE + (p || '/'));
  return { ctx, page };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function api(method, p, body, headers) {
  const res = await fetch(BASE + p, {
    method, headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json', Origin: BASE } : {}, headers || {}),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, headers: res.headers };
}

let ownerChanged = false;
async function adminLogin(page) {
  await page.goto(BASE + '/admin');
  await page.waitForSelector('#login-form');
  await page.fill('#email', 'owner@example.com');
  await page.fill('#password', ownerChanged ? NEW_PW : backend.tempPassword);
  await page.click('#login-form button[type=submit]');
  if (!ownerChanged) {
    await page.waitForSelector('#pw-form');
    await page.fill('#pw-form [name=current_password]', backend.tempPassword);
    await page.fill('#pw-form [name=new_password]', NEW_PW);
    await page.fill('#pw-form [name=confirm_password]', NEW_PW);
    await page.click('#pw-form button[type=submit]');
    ownerChanged = true;
  }
  await page.waitForSelector('.admin-shell');
}

// ============================================================================ Public
test('public site loads through Cloudflare and never contacts Google from the browser', async () => {
  const errors = [], google = [];
  const { ctx, page } = await open(DESKTOP, '/', errors, google);
  await page.waitForSelector('.prog-card');
  assert.equal(await page.textContent('h1'), 'UniMAP Resources Hub');
  assert.equal(await page.locator('.prog-card').count(), 8);
  assert.equal(await page.locator('.coll-card').count(), 3);
  assert.match(await page.textContent('.site-footer'), /not an official UniMAP system/i);
  assert.equal(await page.getAttribute('.site-footer a[href="/admin"]', 'href'), '/admin');
  await page.reload();
  await page.waitForSelector('.prog-card');
  assert.deepEqual(google, [], 'browser made no requests to Google');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('strict security headers (CSP without inline scripts) are served and respected', async () => {
  const res = await fetch(BASE + '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const html = await res.text();
  assert.ok(!/<script>(?!\s*<\/script>)/.test(html), 'no inline <script> blocks');
  assert.ok(!/onclick=/.test(html));
  const adm = await fetch(BASE + '/admin');
  assert.equal(adm.status, 200);
  assert.match(adm.headers.get('x-robots-tag') || '', /noindex/);
  const nf = await fetch(BASE + '/does-not-exist');
  assert.equal(nf.status, 404);
});

test('search, programme pages, official collections and deep links work', async () => {
  const errors = [];
  const { ctx, page } = await open(DESKTOP, '/', errors);
  await page.waitForSelector('#home-search');
  await page.fill('#home-search', '2016');
  assert.match(await page.textContent('.search-results'), /Mohammed Khaled/);
  await page.fill('#home-search', '');
  await page.click('.prog-card:has-text("Mechatronic")');
  await page.waitForSelector('#prog-list');
  assert.match(page.url(), /\?p=programme&s=bachelor-mechatronic-engineering-with-honours$/);
  assert.equal(await page.locator('#prog-list .res-card').count(), 7);
  await page.selectOption('#f-intake', '2024');
  assert.equal(await page.locator('#prog-list .res-card').count(), 2);
  const link = page.locator('#prog-list .res-card a.btn-primary').first();
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await link.getAttribute('rel'), /noopener/);
  await page.goBack();
  await page.waitForSelector('.prog-card');
  await page.goto(BASE + '/?p=official&c=academic-courses');
  await page.waitForSelector('.link-row');
  assert.equal(await page.locator('.link-row').count(), 8);
  assert.match(await page.textContent('main'), /independent student initiative/);
  await page.goto(BASE + '/?p=programme&s=nope');
  await page.waitForSelector('main');
  assert.match(await page.textContent('main'), /Page not found/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Arabic/English with RTL/LTR, and no horizontal scroll on phone, tablet and desktop', async () => {
  const pages = ['/', '/?p=programme&s=bachelor-electrical-engineering-with-honours', '/?p=official', '/?p=submit', '/?p=about', '/?p=search&q=drive'];
  for (const dev of [MOBILE, TABLET, DESKTOP]) {
    const errors = [];
    const { ctx, page } = await open(dev, '/', errors);
    for (const lang of ['en', 'ar']) {
      for (const p of pages) {
        await page.goto(BASE + p + (p.includes('?') ? '&' : '?') + 'lang=' + lang);
        await page.waitForSelector('#main');
        assert.equal(await page.getAttribute('html', 'dir'), lang === 'ar' ? 'rtl' : 'ltr');
        assert.ok(await noHScroll(page), `horizontal scroll: ${p} ${lang} @${dev.viewport.width}px`);
      }
    }
    if (dev === MOBILE) {
      await page.goto(BASE + '/?lang=en');
      await page.waitForSelector('[data-action="menu"]');
      await page.click('[data-action="menu"]');
      assert.ok(await page.isVisible('#mobile-menu'), 'mobile navigation opens');
      await page.click('#mobile-menu a:has-text("About")');
      await page.waitForSelector('h1:has-text("About")');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('public data is rendered instantly from the browser copy on repeat visits', async () => {
  const { ctx, page } = await open(DESKTOP, '/');
  await page.waitForSelector('.prog-card');
  const stored = await page.evaluate(() => !!localStorage.getItem('urh_public_v1'));
  assert.ok(stored);
  // second visit: block the API — the page must still render from the stored copy
  await page.route('**/api/public', (route) => route.abort());
  await page.reload();
  await page.waitForSelector('.prog-card', { timeout: 3000 });
  await ctx.close();
});

// ============================================================================ Submission
test('submission via Cloudflare: validation, duplicate, success, stored in the Sheet', async () => {
  const errors = [];
  const { ctx, page } = await open(MOBILE, '/?p=submit', errors);
  await page.waitForSelector('#submit-form');
  await page.click('#submit-form button[type=submit]');
  assert.ok(await page.locator('[aria-invalid="true"]').count() >= 3);
  await page.fill('#full_name', 'Aminah Yusof');
  await page.selectOption('#programme_id', { label: 'Bachelor of Computer Engineering with Honours' });
  await page.fill('#intake', '2025');
  await page.fill('#resource_url', 'javascript:alert(1)');
  await page.click('#submit-form button[type=submit]');
  assert.match(await page.textContent('#resource_url-err'), /valid link/);
  await page.waitForTimeout(2600);
  await page.fill('#resource_url', 'https://drive.google.com/drive/folders/1lYMpBrPn8bs-XHwdeGFOaTP2mNDI-5NA?usp=sharing');
  await page.click('#submit-form button[type=submit]');
  await page.waitForSelector('#resource_url-err:has-text("already listed")');
  await page.fill('#resource_url', 'https://drive.google.com/drive/folders/1AminahCloudflare2025xyz');
  await page.click('#submit-form button[type=submit]');
  await page.waitForSelector('text=submission received');
  assert.deepEqual(errors, []);
  await ctx.close();
  backend.m.newExecution();
  const row = backend.m.context.db_rows_('Submissions').find((s) => s.full_name === 'Aminah Yusof');
  assert.ok(row, 'written to the Submissions sheet');
  assert.equal(row.status, 'pending');
});

test('anti-spam through the Worker: honeypot, fill time, per-IP rate limit', async () => {
  backend.m.newExecution();
  const pid = backend.m.context.db_rows_('Programmes')[0].id;
  const before = backend.m.context.db_rows_('Submissions').length;
  const form = (i, extra) => Object.assign({ resource_type: 'student', full_name: 'Spam Test', programme_id: pid, intake: '2024', platform: 'Box',
    resource_url: 'https://app.box.com/s/ratelimit' + i, client_id: require('crypto').randomBytes(10).toString('hex'), elapsed_ms: 9000 }, extra || {});
  const hp = await api('POST', '/api/submit', { form: form('hp', { website: 'http://spam' }) });
  assert.equal(hp.json.ok, true);
  const fast = await api('POST', '/api/submit', { form: form('fast', { elapsed_ms: 100 }) });
  assert.equal(fast.json.ok, true);
  backend.m.newExecution();
  assert.equal(backend.m.context.db_rows_('Submissions').length, before, 'honeypot / too-fast not stored');
  let last;
  for (let i = 0; i < 25; i++) { last = await api('POST', '/api/submit', { form: form(i) }); if (!last.json.ok) break; }
  assert.equal(last.json.error.code, 'RATE_LIMITED', 'per-IP limit applies even with new browser ids');
});

test('the Worker is not an open proxy and rejects cross-site / malformed requests', async () => {
  assert.equal((await api('POST', '/api/submit', { form: {} }, { Origin: 'https://evil.example' })).status, 403);
  const noOrigin = await fetch(BASE + '/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await api('POST', '/api/admin/login', 'x=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await api('POST', '/api/submit', '{"form":' + '"x"'.padEnd(40000, ' ') + '}')).status, 413);
  assert.equal((await api('POST', '/api/submit', '[1,2]')).status, 400);
  assert.equal((await api('GET', '/api/../exec')).status, 404);
  assert.equal((await api('GET', '/api/public?url=https://evil.example')).json.ok, true, 'query params are ignored, nothing is fetched from them');
  assert.equal((await api('GET', '/api/proxy?url=https://evil.example')).status, 404);
  assert.equal((await api('POST', '/api/public', {})).status, 405);
  const unknown = await api('POST', '/api/admin/call', { action: 'setup' });
  assert.equal(unknown.status, 404);
  const proto = await api('POST', '/api/admin/call', { action: '__proto__' });
  assert.equal(proto.status, 404);
});

test('a stalled Google response is retried for reads/login but never re-sends a write', async () => {
  const f = backend.faults;
  // Stall on the POST (the script ran, the answer never came): login is re-sent once.
  let before = f.posts;
  f.stallPost = 1;
  const a = await api('POST', '/api/admin/login', { email: 'nobody@example.com', password: 'wrong-password-123' });
  assert.equal(a.status, 200);
  assert.equal(a.json.error.code, 'INVALID_LOGIN', 'the user sees the real answer, not "unavailable"');
  assert.equal(f.posts - before, 2);
  // Stall on the GET of the script output: only the GET is repeated, the script runs once.
  before = f.posts;
  f.stallEcho = 1;
  const b = await api('POST', '/api/admin/login', { email: 'nobody@example.com', password: 'wrong-password-123' });
  assert.equal(b.json.error.code, 'INVALID_LOGIN');
  assert.equal(f.posts - before, 1);
  // A write whose POST stalls is NOT re-sent (it may already have been applied).
  before = f.posts;
  f.stallPost = 1;
  const w = await api('POST', '/api/submit', { form: { resource_type: 'student', full_name: 'Stall Test', programme_id: 'x', intake: '2024',
    platform: 'Box', resource_url: 'https://app.box.com/s/stalltest', client_id: 'abcdefabcdefabcdefab', elapsed_ms: 9000 } });
  assert.equal(w.status, 502);
  assert.equal(w.json.error.code, 'BACKEND_UNAVAILABLE');
  assert.equal(f.posts - before, 1, 'the write was sent exactly once');
  f.stallPost = 0; f.stallEcho = 0;
});

// ============================================================================ Admin
test('admin login uses an HttpOnly cookie; the token is never visible to JavaScript', async () => {
  const errors = [];
  const { ctx, page } = await open(DESKTOP, '/admin', errors);
  await page.waitForSelector('#login-form');
  await page.fill('#email', 'owner@example.com');
  await page.fill('#password', 'wrong-password-123');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('.notice-danger:has-text("Incorrect email or password")');
  await adminLogin(page);
  const js = await page.evaluate(() => ({ cookie: document.cookie, ss: JSON.stringify(sessionStorage), ls: JSON.stringify(localStorage) }));
  assert.ok(!/[a-f0-9]{64}/.test(js.cookie + js.ss + js.ls), 'no session token readable by page JavaScript');
  const cookies = await ctx.cookies();
  const c = cookies.find((x) => /urh_admin/.test(x.name));
  assert.ok(c, 'session cookie set');
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Strict');
  // a new tab shares the session (the old sessionStorage design required signing in again)
  const tab2 = await ctx.newPage();
  await tab2.goto(BASE + '/admin');
  await tab2.waitForSelector('.admin-shell');
  // the login API response itself contains no token
  const r = await api('POST', '/api/admin/login', { email: 'owner@example.com', password: NEW_PW });
  assert.equal(r.json.ok, true);
  assert.ok(!('token' in r.json.data));
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('admin flow via Cloudflare: approve, public update, edit, delete, reject, settings, activity', async () => {
  const errors = [];
  const { ctx, page } = await open(DESKTOP, '/admin', errors);
  await adminLogin(page);
  await page.click('.side-nav a[data-view="submissions"]');
  await page.click('tr:has-text("Aminah Yusof") [data-a="review"]');
  await page.waitForSelector('[data-approve]');
  await page.fill('.sheet [name="title"]', 'Aminah — CE Notes (Cloudflare)');
  await page.click('[data-approve]');
  await page.waitForSelector('.toast:has-text("Approved")');
  // public page shows it (Worker invalidates its public cache after admin changes)
  const pub = await ctx.newPage();
  await pub.goto(BASE + '/?p=programme&s=bachelor-computer-engineering-with-honours');
  await pub.waitForFunction(() => /Aminah — CE Notes \(Cloudflare\)/.test(document.body.textContent), null, { timeout: 5000 });
  // edit the resource, then delete it
  await page.click('.side-nav a[data-view="resources"]');
  await page.fill('#res-q', 'Aminah');
  await page.waitForTimeout(300);
  await page.click('tr:has-text("Aminah") [data-a="edit"]');
  await page.fill('.sheet [name="notes"]', 'Edited through Cloudflare');
  await page.click('.sheet [data-save]');
  await page.waitForSelector('.toast:has-text("Resource saved")');
  await pub.reload();
  await pub.waitForFunction(() => /Edited through Cloudflare/.test(document.body.textContent), null, { timeout: 5000 });
  await page.click('tr:has-text("Aminah") [data-a="edit"]');
  await page.click('.sheet [data-del]');
  await page.click('.sheet-sm [data-ok]');
  await page.waitForSelector('.toast:has-text("Resource deleted")');
  await pub.reload();
  await pub.waitForSelector('#prog-list');
  await pub.waitForFunction(() => !/Aminah/.test(document.body.textContent), null, { timeout: 5000 });
  // reject a spam submission with a note
  await page.click('.side-nav a[data-view="submissions"]');
  await page.click('tr:has-text("Spam Test") [data-a="review"]');
  await page.fill('.sheet [name="admin_notes"]', 'Spam');
  await page.click('[data-reject]');
  await page.click('.sheet-sm [data-ok]');
  await page.waitForSelector('.toast:has-text("rejected")');
  // programme change → correct programme page
  await page.click('.side-nav a[data-view="programmes"]');
  await page.click('[data-a="add"]');
  await page.fill('.sheet [name="name"]', 'Bachelor of Civil Engineering with Honours');
  await page.fill('.sheet [name="faculty"]', 'FKTA');
  await page.click('.sheet [data-save]');
  await page.waitForSelector('.toast:has-text("Programme added")');
  await pub.goto(BASE + '/?p=programme&s=bachelor-of-civil-engineering-with-honours');
  await pub.waitForSelector('h1:has-text("Civil Engineering")');
  // settings → public UI updates
  await page.click('.side-nav a[data-view="settings"]');
  await page.fill('#set-announcement_en', 'Cloudflare test announcement');
  await page.click('.savebar [data-a="save"]');
  await page.waitForSelector('.toast:has-text("Settings saved")');
  await pub.goto(BASE + '/');
  await pub.waitForFunction(() => /Cloudflare test announcement/.test(document.body.textContent), null, { timeout: 5000 });
  // activity log
  await page.click('.side-nav a[data-view="activity"]');
  const log = await page.textContent('#act-feed');
  ['submission.approve', 'resource.update', 'resource.delete', 'submission.reject', 'programme.create', 'settings.update'].forEach((a) => assert.ok(log.includes(a), a));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('admin management, password change, logout, expired and unauthorised sessions', async () => {
  const errors = [];
  const { ctx, page } = await open(DESKTOP, '/admin', errors);
  await adminLogin(page);
  // create a reviewer
  await page.click('.side-nav a[data-view="admins"]');
  await page.click('[data-a="add"]');
  await page.fill('.sheet [name="name"]', 'Reviewer Person');
  await page.fill('.sheet [name="email"]', 'reviewer@example.com');
  await page.selectOption('.sheet [name="role"]', 'reviewer');
  await page.click('.sheet [data-save]');
  await page.waitForSelector('.temp-pass');
  const temp = (await page.textContent('.temp-pass')).trim();
  await page.click('.sheet [data-close]:has-text("Done")');
  // reviewer signs in in a separate browser context, must change password, then is restricted
  const rctx = await browser.newContext(DESKTOP);
  const rp = await rctx.newPage();
  await rp.goto(BASE + '/admin');
  await rp.fill('#email', 'reviewer@example.com');
  await rp.fill('#password', temp);
  await rp.click('#login-form button[type=submit]');
  await rp.waitForSelector('#pw-form');
  await rp.fill('#pw-form [name=current_password]', temp);
  await rp.fill('#pw-form [name=new_password]', 'Kuala-Perlis-9921x');
  await rp.fill('#pw-form [name=confirm_password]', 'Kuala-Perlis-9921x');
  await rp.click('#pw-form button[type=submit]');
  await rp.waitForSelector('.admin-shell');
  const forbidden = await rp.evaluate(() => fetch('/api/admin/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'programmes.save', payload: { name: 'Hacked programme' } }) }).then((r) => r.json()));
  assert.equal(forbidden.error.code, 'FORBIDDEN', 'reviewer cannot edit programmes even by calling the API directly');
  // owner deactivates the reviewer → reviewer's next call is refused and cookie cleared
  await page.reload();
  await page.waitForSelector('.admin-shell');
  await page.click('.side-nav a[data-view="admins"]');
  await page.click('tr:has-text("reviewer@example.com") [data-a="edit"]');
  await page.click('.sheet [name="is_active"] + .track');
  await page.click('.sheet [data-save]');
  await page.waitForSelector('.toast:has-text("Admin saved")');
  const after = await rp.evaluate(() => fetch('/api/admin/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'bootstrap' }) }).then((r) => r.json()));
  assert.equal(after.error.code, 'AUTH_REQUIRED');
  await rctx.close();
  // forged / expired cookie
  const fctx = await browser.newContext();
  await fctx.addCookies([{ name: 'urh_admin_dev', value: 'f'.repeat(64), url: BASE, httpOnly: true, sameSite: 'Strict' }]);
  const fp = await fctx.newPage();
  await fp.goto(BASE + '/admin');
  await fp.waitForSelector('#login-form');
  await fctx.close();
  // no cookie at all
  assert.equal((await api('POST', '/api/admin/call', { action: 'bootstrap' })).json.error.code, 'AUTH_REQUIRED');
  // owner changes own password from My account → cookie rotated, still signed in
  await page.click('.side-nav a[data-view="account"]');
  await page.fill('#password-form [name=current_password]', NEW_PW);
  await page.fill('#password-form [name=new_password]', 'Arau-Campus-2027z');
  await page.fill('#password-form [name=confirm_password]', 'Arau-Campus-2027z');
  await page.click('#password-form button[type=submit]');
  await page.waitForSelector('.toast:has-text("Password updated")');
  await page.click('.side-nav a[data-view="overview"]');
  await page.reload();
  await page.waitForSelector('.admin-shell');
  // logout clears the session server-side and the cookie
  await page.click('[data-act="logout"]');
  await page.waitForSelector('#login-form');
  assert.equal((await ctx.cookies()).filter((x) => /urh_admin/.test(x.name) && x.value).length, 0);
  await page.reload();
  await page.waitForSelector('#login-form');
  // restore owner password for other tests
  const l = await api('POST', '/api/admin/login', { email: 'owner@example.com', password: 'Arau-Campus-2027z' });
  assert.equal(l.json.ok, true);
  const cookie = l.headers.get('set-cookie').split(';')[0];
  const ch = await api('POST', '/api/admin/call', { action: 'account.changePassword', payload: { current_password: 'Arau-Campus-2027z', new_password: NEW_PW } }, { Cookie: cookie });
  assert.equal(ch.json.ok, true);
  assert.ok(!('token' in ch.json.data), 'rotated token not exposed');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('admin dashboard works on a phone through Cloudflare', async () => {
  const errors = [];
  const { ctx, page } = await open(MOBILE, '/admin', errors);
  await adminLogin(page);
  for (const v of ['overview', 'submissions', 'resources', 'programmes', 'collections', 'platforms', 'admins', 'settings', 'activity', 'account']) {
    await page.evaluate((x) => AdminApp.ctx.setView(x), v);
    await page.waitForTimeout(50);
    assert.ok(await noHScroll(page), 'overflow in admin ' + v);
  }
  await page.click('[data-act="open-nav"]');
  await page.click('.side-nav a[data-view="submissions"]');
  await page.waitForSelector('.tabs');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the original Apps Script HTML site keeps working alongside', async () => {
  const errors = [];
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${BACKEND_PORT}/`);
  await page.waitForSelector('.prog-card');
  await page.goto(`http://localhost:${BACKEND_PORT}/?p=admin`);
  await page.waitForSelector('#login-form');
  await page.fill('#email', 'owner@example.com');
  await page.fill('#password', NEW_PW);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('.admin-shell');
  assert.ok(await page.evaluate(() => /^[a-f0-9]{64}$/.test(sessionStorage.getItem('urh_admin_token') || '')), 'old site still uses its sessionStorage flow');
  assert.deepEqual(errors, []);
  await ctx.close();
});
