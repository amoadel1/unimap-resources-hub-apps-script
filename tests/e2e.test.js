/**
 * e2e.test.js — browser tests of the real HTML/JS served by doGet(), using
 * Playwright (Chromium) against the local dev server (tests/dev-server.js).
 *   NODE_PATH=$(npm root -g) node --test tests/e2e.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createDevApp } = require('./dev-server');

const PORT = 8795;
const BASE = 'http://localhost:' + PORT + '/';
const NEW_PW = 'Kedah-Perlis-2026x';
let app, browser;

const MOBILE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 820, height: 1180 } };
const DESKTOP = { viewport: { width: 1440, height: 900 } };

test.before(async () => {
  app = createDevApp({ latency: 30 });
  await new Promise((r) => app.server.listen(PORT, r));
  browser = await chromium.launch();
});
test.after(async () => { await browser.close(); app.server.close(); });

async function open(device, path, errors) {
  const ctx = await browser.newContext(device || DESKTOP);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors && errors.push(e.message));
  page.on('console', (m) => { if (errors && m.type() === 'error' && !/TUNNEL|fonts\.g/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', async (d) => { errors && errors.push('DIALOG: ' + d.message()); await d.dismiss(); });
  await page.goto(BASE + (path || ''));
  await page.waitForSelector('#main, .auth-wrap form, .admin-shell', { timeout: 5000 }).catch(() => {});
  return { ctx, page };
}
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

let ownerPassword = null;
async function adminLogin(page) {
  await page.fill('#email', 'owner@example.com');
  await page.fill('#password', ownerPassword || app.tempPassword);
  await page.click('#login-form button[type=submit]');
  if (!ownerPassword) {
    await page.waitForSelector('#pw-form');
    await page.fill('#pw-form [name=current_password]', app.tempPassword);
    await page.fill('#pw-form [name=new_password]', NEW_PW);
    await page.fill('#pw-form [name=confirm_password]', NEW_PW);
    await page.click('#pw-form button[type=submit]');
    ownerPassword = NEW_PW;
  }
  await page.waitForSelector('.admin-shell');
}

test('homepage renders from embedded data with zero server calls', async () => {
  const errors = [];
  const { ctx, page } = await open(DESKTOP, '', errors);
  assert.equal(await page.textContent('h1'), 'UniMAP Resources Hub');
  assert.equal(await page.evaluate(() => window.__rpcCount || 0), 0);
  assert.equal(await page.locator('.prog-card').count(), 8);
  assert.equal(await page.locator('.coll-card').count(), 4);
  assert.match(await page.textContent('.site-footer'), /independent student initiative/i);
  assert.match(await page.textContent('#official'), /not an official UniMAP system/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('instant search across programme, owner, intake, platform and notes', async () => {
  const { ctx, page } = await open(DESKTOP);
  const search = async (q) => { await page.fill('#home-search', q); await page.waitForTimeout(80); };
  await search('mechatronic');
  assert.ok(await page.locator('.search-group .prog-card').count() >= 1);
  await search('2016');
  assert.match(await page.textContent('.search-results'), /Mohammed Khaled/);
  await search('box');
  assert.match(await page.textContent('.search-results'), /SAIF HASAN AL AHDAL/);
  await search('multiple students');
  assert.match(await page.textContent('.search-results'), /Community Drive/);
  await search('timetable');
  assert.match(await page.textContent('.search-results'), /Class Timetable/);
  await search('zzzqqq');
  assert.match(await page.textContent('.search-results'), /No results/);
  await page.click('[data-action="clear-search"]');
  assert.equal(await page.locator('.prog-card').count(), 8);
  await ctx.close();
});

test('programme page: navigation, filters, safe external links, deep link', async () => {
  const { ctx, page } = await open(DESKTOP);
  await page.click('.prog-card:has-text("Mechatronic")');
  await page.waitForSelector('#prog-list');
  assert.match(page.url(), /p=programme&s=bachelor-mechatronic-engineering-with-honours/);
  assert.equal(await page.locator('#prog-list .res-card').count(), 7);
  await page.selectOption('#f-intake', '2024');
  assert.equal(await page.locator('#prog-list .res-card').count(), 2);
  await page.selectOption('#f-intake', '');
  await page.click('[data-platform="Box"]');
  assert.equal(await page.locator('#prog-list .res-card').count(), 1);
  const link = page.locator('#prog-list .res-card a.btn-primary').first();
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.match(await link.getAttribute('rel'), /noopener/);
  assert.match(await link.getAttribute('href'), /^https:\/\/app\.box\.com\//);
  await page.goBack();
  await page.waitForSelector('.prog-card');
  await ctx.close();
  const deep = await open(DESKTOP, '?p=programme&s=bachelor-biomedical-electronic-engineering-with-honours');
  assert.equal(await deep.page.locator('#prog-list .res-card').count(), 5);
  await deep.ctx.close();
  const missing = await open(DESKTOP, '?p=programme&s=does-not-exist');
  assert.match(await missing.page.textContent('main'), /Page not found/);
  await missing.ctx.close();
});

test('official collections show links and the independence notice', async () => {
  const { ctx, page } = await open(DESKTOP, '?p=official&c=academic-programme');
  assert.equal(await page.locator('.off-card').count(), 7);
  assert.match(await page.textContent('main'), /independent student initiative/);
  // Every card: category label, Official badge, title, description, platform; whole card is the link.
  const card = page.locator('.off-card').first();
  assert.equal(await card.getAttribute('target'), '_blank');
  assert.match(await card.getAttribute('rel'), /noopener/);
  assert.match(await card.locator('.off-type').textContent(), /Academic Programme/);
  assert.match(await card.locator('.badge').textContent(), /Official/);
  assert.match(await card.locator('.off-foot').textContent(), /Website/);
  assert.ok(!/https?:\/\//.test(await page.textContent('.off-grid')), 'no raw URLs');
  // Official index: 4 collections, and the Academic Guide is a normal card (not full width).
  await page.goto(page.url().split('?')[0] + '?p=official');
  await page.waitForSelector('.coll-card');
  assert.equal(await page.locator('.coll-card').count(), 4);
  const guide = page.locator('.off-card', { hasText: 'UniMAP Academic Guide' });
  assert.equal(await guide.count(), 1);
  const gw = (await guide.boundingBox()).width, cw = (await page.locator('.coll-card').first().boundingBox()).width;
  assert.ok(Math.abs(gw - cw) < 2, 'guide card has the same width as the collection cards (' + gw + ' vs ' + cw + ')');
  // Tablet: 2 columns, phone: 1 column, no horizontal scroll.
  for (const [w, cols] of [[820, 2], [375, 1]]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(page.url().split('?')[0] + '?p=official&c=academic-courses');
    await page.waitForSelector('.off-card');
    const xs = new Set(await page.locator('.off-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left))));
    assert.equal(xs.size, cols, w + 'px → ' + cols + ' column(s)');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  }
  // Equal height per row on desktop.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(page.url().split('?')[0] + '?p=official&c=academic-courses');
  await page.waitForSelector('.off-card');
  const boxes = await page.locator('.off-card').evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.height)]; }));
  const rows = {}; boxes.forEach(([top, h]) => { (rows[top] = rows[top] || []).push(h); });
  Object.values(rows).forEach((hs) => assert.equal(new Set(hs).size, 1, 'equal heights in a row: ' + hs));
  // Search finds the library links.
  for (const q of ['EZproxy', 'Library', 'DSpace', 'Repository', 'Room Reservation', 'Digital Repository']) {
    await page.goto(page.url().split('?')[0] + '?p=search&q=' + encodeURIComponent(q));
    await page.waitForSelector('.off-card');
    assert.ok(await page.locator('.off-card').count() >= 1, 'search: ' + q);
  }
  await ctx.close();
});

test('Arabic / English switching sets RTL/LTR and translates the interface', async () => {
  const { ctx, page } = await open(MOBILE);
  await page.click('[data-action="lang"]');
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  assert.equal(await page.getAttribute('html', 'lang'), 'ar');
  assert.match(await page.textContent('.section-head h2'), /تصفّح حسب التخصص/);
  assert.match(await page.textContent('.prog-card >> nth=0'), /بكالوريوس/);
  assert.ok(await noHorizontalScroll(page), 'no horizontal scroll in RTL mobile');
  await page.reload();
  await page.waitForSelector('#main');
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl', 'language remembered');
  await page.click('[data-action="lang"]');
  assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
  await ctx.close();
});

test('responsive: no horizontal scrolling on phone, tablet and desktop', async () => {
  const pages = ['', '?p=programme&s=bachelor-electrical-engineering-with-honours', '?p=official', '?p=official&c=academic-courses', '?p=submit', '?p=about', '?p=search&q=drive'];
  for (const dev of [MOBILE, TABLET, DESKTOP]) {
    for (const lang of ['en', 'ar']) {
      const errors = [];
      const { ctx, page } = await open(dev, '', errors);
      for (const p of pages) {
        await page.goto(BASE + p + (p ? '&' : '?') + 'lang=' + lang);
        await page.waitForSelector('#main');
        assert.ok(await noHorizontalScroll(page), `overflow on ${p} ${lang} ${dev.viewport.width}px`);
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  }
});

test('submission form: client validation, server validation, success', async () => {
  const errors = [];
  const { ctx, page } = await open(MOBILE, '?p=submit', errors);
  await page.click('#submit-form button[type=submit]');
  assert.ok(await page.locator('[aria-invalid="true"]').count() >= 3, 'required fields flagged');
  await page.fill('#full_name', 'Aminah Yusof');
  await page.selectOption('#programme_id', { label: 'Bachelor of Computer Engineering with Honours' });
  await page.fill('#intake', '2025');
  await page.fill('#resource_url', 'javascript:alert(1)');
  await page.click('#submit-form button[type=submit]');
  assert.match(await page.textContent('#resource_url-err'), /valid link/);
  // server-side duplicate detection (link already listed for this programme)
  await page.fill('#resource_url', 'https://drive.google.com/drive/folders/1lYMpBrPn8bs-XHwdeGFOaTP2mNDI-5NA?usp=sharing');
  await page.waitForTimeout(2600); // humans take a moment; very fast forms are treated as bots
  await page.click('#submit-form button[type=submit]');
  await page.waitForSelector('#resource_url-err');
  assert.match(await page.textContent('#resource_url-err'), /already listed/);
  await page.fill('#resource_url', 'https://drive.google.com/drive/folders/1AminahNotesFolder2025x');
  await page.fill('#notes', 'Semester 1–4 notes');
  await page.click('#submit-form button[type=submit]');
  await page.waitForSelector('text=submission received');
  assert.deepEqual(errors, []);
  await ctx.close();
  app.m.newExecution();
  const s = app.m.context.db_rows_('Submissions').find((x) => x.full_name === 'Aminah Yusof');
  assert.ok(s, 'stored');
  assert.equal(s.status, 'pending');
});

test('submission form in Arabic shows Arabic errors', async () => {
  const { ctx, page } = await open(DESKTOP, '?p=submit&lang=ar');
  await page.click('#submit-form button[type=submit]');
  assert.match(await page.textContent('#full_name-err'), /هذا الحقل مطلوب/);
  await ctx.close();
});

test('admin: unauthorized access shows login; wrong password rejected', async () => {
  const { ctx, page } = await open(DESKTOP, '?p=admin');
  await page.waitForSelector('#login-form');
  await page.evaluate(() => sessionStorage.setItem('urh_admin_token', 'f'.repeat(64)));
  await page.reload();
  await page.waitForSelector('#login-form');
  assert.match(await page.textContent('#login-form'), /session has expired|sign in/i);
  await page.fill('#email', 'owner@example.com');
  await page.fill('#password', 'wrong-password-123');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('.notice-danger:has-text("Incorrect email or password")');
  await ctx.close();
});

test('admin: login, forced password change, approve submission end-to-end', async () => {
  const errors = [];
  const { ctx, page } = await open(DESKTOP, '?p=admin', errors);
  await adminLogin(page);
  assert.match(await page.textContent('.stats'), /Pending submissions/);
  await page.click('.side-nav a[data-view="submissions"]');
  await page.click('tr:has-text("Aminah Yusof") [data-a="review"]');
  await page.waitForSelector('[data-approve]');
  const title = page.locator('.sheet [name="title"]');
  assert.equal(await title.inputValue(), 'Aminah Yusof Drive');
  await title.fill('Aminah Yusof — CE Notes');
  await page.fill('.sheet [name="admin_notes"]', 'Verified link opens');
  await page.click('[data-approve]');
  await page.waitForSelector('.toast:has-text("Approved")');
  assert.equal(await page.locator('tr:has-text("Aminah Yusof")').count(), 0, 'left pending tab');
  // public site shows it under Computer Engineering
  const pub = await ctx.newPage();
  await pub.goto(BASE + '?p=programme&s=bachelor-computer-engineering-with-honours');
  await pub.waitForSelector('#prog-list');
  assert.match(await pub.textContent('#prog-list'), /Aminah Yusof — CE Notes/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('admin: programme CRUD through the dashboard reflects on the public site', async () => {
  const errors = [];
  const { ctx, page } = await open(DESKTOP, '?p=admin', errors);
  await adminLogin(page);
  await page.click('.side-nav a[data-view="programmes"]');
  await page.click('[data-a="add"]');
  await page.fill('.sheet [name="name"]', 'Bachelor of Civil Engineering with Honours');
  await page.fill('.sheet [name="name_ar"]', 'بكالوريوس الهندسة المدنية');
  await page.fill('.sheet [name="faculty"]', 'FKTA');
  await page.click('.sheet [data-save]');
  await page.waitForSelector('.toast:has-text("Programme added")');
  assert.ok(await page.locator('td:has-text("Bachelor of Civil Engineering with Honours")').count() >= 1);
  // validation error shown inline
  await page.click('[data-a="add"]');
  await page.fill('.sheet [name="name"]', 'Bachelor of Civil Engineering with Honours');
  await page.click('.sheet [data-save]');
  await page.waitForSelector('.sheet .field-error');
  assert.match(await page.textContent('.sheet .field-error'), /already exists/);
  await page.keyboard.press('Escape');
  const pub = await ctx.newPage();
  await pub.goto(BASE);
  await pub.waitForSelector('.prog-card');
  assert.equal(await pub.locator('.prog-card').count(), 9);
  // hide it again → disappears publicly
  await page.click('tr:has-text("Civil Engineering") [data-a="toggle"]');
  await page.waitForSelector('.toast:has-text("hidden")');
  await pub.reload();
  await pub.waitForSelector('.prog-card');
  assert.equal(await pub.locator('.prog-card').count(), 8);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('admin: stored XSS attempt is rendered as text everywhere', async () => {
  const errors = [];
  const pid = (() => { app.m.newExecution(); return app.m.context.db_rows_('Programmes')[0].id; })();
  const xss = '<img src=x onerror="window.__pwned=1">';
  const r = app.m.run('submitResource', { resource_type: 'student', full_name: xss, programme_id: pid, intake: '2024', platform: 'Box', resource_url: 'https://app.box.com/s/xsstest', notes: '<script>window.__pwned=1</script>', client_id: 'x'.repeat(20).replace(/x/g, 'a'), elapsed_ms: 9000 });
  assert.equal(r.ok, true);
  const { ctx, page } = await open(DESKTOP, '?p=admin', errors);
  await adminLogin(page);
  await page.click('.side-nav a[data-view="submissions"]');
  await page.click('tr:has-text("onerror") [data-a="review"]');
  await page.click('[data-approve]');
  await page.waitForSelector('.toast:has-text("Approved")');
  const pub = await ctx.newPage();
  await pub.goto(BASE + '?p=search&q=onerror');
  await pub.waitForSelector('.res-card');
  assert.equal(await pub.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.match(await pub.textContent('.res-card'), /<img src=x onerror/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('admin dashboard is usable on a phone', async () => {
  const errors = [];
  const { ctx, page } = await open(MOBILE, '?p=admin', errors);
  await adminLogin(page);
  for (const v of ['overview', 'submissions', 'resources', 'programmes', 'collections', 'platforms', 'admins', 'settings', 'activity', 'account']) {
    await page.evaluate((x) => AdminApp.ctx.setView(x), v);
    await page.waitForTimeout(60);
    assert.ok(await noHorizontalScroll(page), 'overflow in admin ' + v);
  }
  await page.click('[data-act="open-nav"]');
  await page.click('.side-nav a[data-view="settings"]');
  await page.fill('#set-tagline_en', 'By Students, For Students — UniMAP');
  await page.waitForSelector('.savebar');
  await page.click('.savebar [data-a="save"]');
  await page.waitForSelector('.toast:has-text("Settings saved")');
  const pub = await ctx.newPage();
  await pub.goto(BASE);
  await pub.waitForSelector('.pill');
  assert.match(await pub.textContent('.pill'), /UniMAP/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
