/**
 * server.test.js — integration tests for the Apps Script backend.
 * Runs the REAL src/*.gs files on top of gas-mock.js.
 *   node --test tests/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createMock } = require('./gas-mock');

const STRONG = 'Strong-Pass-2026x';

function fresh(opts = {}) {
  const m = createMock({ activeUser: 'owner@example.com', effectiveUser: 'owner@example.com' });
  m.context.setup();
  const temp = m.logs.find((l) => /Temporary password:/.test(l)).split('Temporary password:')[1].trim();
  if (opts.seed !== false) m.context.seedInitialData();
  m.session.active = ''; // from now on we are an anonymous web visitor
  const env = {
    m, temp,
    api: (token, action, payload) => m.run('adminApi', token, action, payload),
    rows: (name) => { m.newExecution(); return m.context.db_rows_(name); },
    ctx: (fn) => { m.newExecution(); return fn(m.context); }
  };
  return env;
}

function login(env, email, password) { return env.m.run('adminLogin', email, password); }

function ownerToken(env) {
  const r = login(env, 'owner@example.com', env.temp);
  assert.equal(r.ok, true, JSON.stringify(r));
  const c = env.api(r.data.token, 'account.changePassword', { current_password: env.temp, new_password: STRONG });
  assert.equal(c.ok, true, JSON.stringify(c));
  return c.data.token;
}

function makeAdmin(env, ownerTok, role, email) {
  email = email || role + '-' + crypto.randomBytes(3).toString('hex') + '@example.com';
  const r = env.api(ownerTok, 'admins.save', { name: 'Test ' + role, email, role });
  assert.equal(r.ok, true, JSON.stringify(r));
  const l = login(env, email, r.data.temp_password);
  assert.equal(l.ok, true);
  const c = env.api(l.data.token, 'account.changePassword', { current_password: r.data.temp_password, new_password: 'Another-Pass-99z' });
  assert.equal(c.ok, true, JSON.stringify(c));
  return { token: c.data.token, id: r.data.id, email };
}

function progId(env, slug) {
  return env.rows('Programmes').find((p) => p.slug === (slug || 'bachelor-electrical-engineering-with-honours')).id;
}

let urlCounter = 0;
function submission(env, over = {}) {
  urlCounter++;
  return Object.assign({
    resource_type: 'student', full_name: 'Test Student', programme_id: progId(env), intake: '2024',
    platform: 'Google Drive', resource_url: 'https://drive.google.com/drive/folders/TestFolder' + String(urlCounter).padStart(8, '0') + 'abc',
    notes: 'Notes', client_id: crypto.randomBytes(10).toString('hex'), elapsed_ms: 8000, website: ''
  }, over);
}
function submit(env, over) { return env.m.run('submitResource', submission(env, over)); }

// ============================================================================ Setup
test('setup creates every sheet with headers, settings, platforms and one owner', () => {
  const env = fresh({ seed: false });
  const names = env.m.ss.getSheets().map((s) => s.getName()).sort();
  assert.deepEqual(names, ['ActivityLog', 'Admins', 'Categories', 'Platforms', 'Programmes', 'Resources', 'Settings', 'Submissions']);
  const header = env.m.sheet('Resources').getRange(1, 1, 1, 18).getValues()[0];
  assert.equal(header[0], 'id');
  assert.ok(header.includes('programme_id') && header.includes('url_key') && header.includes('is_official'));
  assert.equal(env.rows('Admins').length, 1);
  assert.equal(env.rows('Admins')[0].role, 'owner');
  assert.equal(env.rows('Admins')[0].must_change_password, true);
  assert.equal(env.rows('Platforms').length, 6);
  assert.ok(env.rows('Settings').length >= 20);
  assert.ok(env.m.props.AUTH_PEPPER && env.m.props.AUTH_PEPPER.length >= 128);
  assert.ok(!/v1\$/.test(env.m.logs.join('\n')), 'password hash must never be logged');
});

test('setup is idempotent and repairs missing columns', () => {
  const env = fresh();
  const before = env.rows('Resources').length;
  env.m.session.active = 'owner@example.com';
  // simulate a missing column
  const sh = env.m.sheet('Programmes');
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idx = hdr.indexOf('name_ar');
  sh.getRange(1, idx + 1).setValues([['']]);
  env.m.newExecution();
  assert.equal(env.m.context.validateStructure_().ok, false);
  env.m.logs.length = 0;
  env.m.context.setup();
  env.m.context.seedInitialData();
  env.m.session.active = '';
  assert.equal(env.rows('Admins').length, 1, 'no second admin');
  assert.equal(env.rows('Resources').length, before, 'seed does not duplicate');
  env.m.newExecution();
  assert.equal(env.m.context.validateStructure_().ok, true);
  assert.ok(env.m.logs.some((l) => /added missing column\(s\) name_ar/.test(l)));
});

test('owner-only editor functions refuse to run for web visitors', () => {
  const env = fresh();
  for (const fn of ['setup', 'seedInitialData', 'recoverOwnerAccess', 'validateSetup', 'clearAppCache']) {
    assert.throws(() => env.m.run(fn), /script owner/, fn);
  }
  // private functions can never be called from the browser
  for (const fn of ['login_', 'db_rows_', 'hashPassword_', 'submissionApprove_', 'include_']) {
    assert.throws(() => env.m.run(fn), /not found/, fn);
  }
});

test('recoverOwnerAccess resets the owner password with a new temporary one', () => {
  const env = fresh();
  ownerToken(env);
  env.m.session.active = 'owner@example.com';
  env.m.logs.length = 0;
  env.m.context.recoverOwnerAccess();
  env.m.session.active = '';
  const temp = env.m.logs.find((l) => /Temporary password:/.test(l)).split(': ')[1].trim();
  assert.equal(login(env, 'owner@example.com', STRONG).ok, false);
  const r = login(env, 'owner@example.com', temp);
  assert.equal(r.ok, true);
  assert.equal(r.data.admin.must_change_password, true);
});

test('seed imports the previous site content with correct programme links', () => {
  const env = fresh();
  const res = env.rows('Resources');
  assert.equal(res.filter((r) => !r.is_official).length, 20);
  assert.equal(res.filter((r) => r.is_official).length, 21);
  const mech = progId(env, 'bachelor-mechatronic-engineering-with-honours');
  assert.equal(res.filter((r) => r.programme_id === mech).length, 7);
  const ids = res.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'IDs unique');
  assert.ok(ids.every((id) => /^res_[a-f0-9]{20}$/.test(id)));
  // 4 collections: 7 + 8 + 2 + 3 links, plus 1 general link (Academic Guide)
  const cats = env.rows('Categories');
  assert.deepEqual(JSON.parse(JSON.stringify(cats.map((c) => c.slug))), ['academic-programme', 'academic-courses', 'class-timetable', 'library-digital-services']);
  const count = (slug) => res.filter((r) => r.is_official && r.category_id === cats.find((c) => c.slug === slug).id).length;
  assert.deepEqual([count('academic-programme'), count('academic-courses'), count('class-timetable'), count('library-digital-services')], [7, 8, 2, 3]);
  assert.equal(res.filter((r) => r.is_official && !r.category_id).length, 1);
  const lib = cats.find((c) => c.slug === 'library-digital-services');
  assert.equal(lib.name_ar, 'خدمات المكتبة والخدمات الرقمية');
  const dspace = res.find((r) => r.url === 'https://dspace.unimap.edu.my');
  assert.ok(dspace && dspace.owner_name === 'Universiti Malaysia Perlis' && dspace.intake === 'Official' && dspace.platform === 'Website');
});

test('seedLibraryDigitalServices adds only the library collection, idempotently, on a live site', () => {
  const env = fresh();
  const t = ownerToken(env);
  // Simulate the live site before this update: no library collection/links, and an admin deleted a seeded drive.
  const lib = env.rows('Categories').find((c) => c.slug === 'library-digital-services');
  for (const r of env.rows('Resources').filter((x) => x.category_id === lib.id)) env.api(t, 'resources.delete', { id: r.id });
  assert.equal(env.api(t, 'categories.delete', { id: lib.id }).ok, true);
  const drive = env.rows('Resources').find((r) => !r.is_official);
  env.api(t, 'resources.delete', { id: drive.id });
  const before = env.rows('Resources').length;
  env.m.session.active = 'owner@example.com';
  env.m.newExecution();
  const r1 = env.m.context.seedLibraryDigitalServices();
  env.m.newExecution();
  const r2 = env.m.context.seedLibraryDigitalServices();
  env.m.session.active = '';
  assert.deepEqual([r1.categories, r1.official, r1.resources, r1.programmes], [1, 3, 0, 0]);
  assert.deepEqual([r2.categories, r2.official], [0, 0], 'second run adds nothing');
  const res = env.rows('Resources');
  assert.equal(res.length, before + 3);
  assert.ok(!res.some((r) => r.id === drive.id || r.url_key === drive.url_key), 'a deleted drive is NOT brought back');
  assert.equal(env.rows('Categories').filter((c) => c.slug === 'library-digital-services').length, 1);
  assert.equal(res.filter((r) => r.is_official).length, 21);
});

// ============================================================================ Public data
test('public data contains only active, public information', () => {
  const env = fresh();
  const t = ownerToken(env);
  const p = env.rows('Programmes')[0];
  env.api(t, 'programmes.setActive', { id: p.id, is_active: false });
  const cat = env.rows('Categories')[0];
  env.api(t, 'categories.setActive', { id: cat.id, is_active: false });
  const r = env.m.run('getPublicData');
  assert.equal(r.ok, true);
  const json = JSON.stringify(r.data);
  assert.ok(!json.includes('owner@example.com'), 'no admin emails');
  assert.ok(!/v1\$/.test(json), 'no hashes');
  assert.ok(!('rate_limit_client_per_hour' in r.data.settings), 'private settings hidden');
  assert.ok(!r.data.programmes.some((x) => x.id === p.id));
  assert.ok(!r.data.resources.some((x) => x.programme_id === p.id && !x.is_official), 'resources of inactive programme hidden');
  assert.ok(!r.data.resources.some((x) => x.category_id === cat.id), 'links of inactive collection hidden');
  assert.ok(!r.data.resources[0].hasOwnProperty('created_by'));
});

test('public data is cached and the cache is invalidated by admin changes', () => {
  const env = fresh();
  const t = ownerToken(env);
  env.m.run('getPublicData');
  env.m.resetStats();
  env.m.run('getPublicData');
  assert.equal(env.m.stats.reads, 0, 'second read served from CacheService');
  const r = env.api(t, 'programmes.save', { name: 'Bachelor of Civil Engineering with Honours', faculty: 'FKTA' });
  assert.equal(r.ok, true);
  const pub = env.m.run('getPublicData');
  assert.ok(pub.data.programmes.some((p) => p.name === 'Bachelor of Civil Engineering with Honours'));
});

test('doGet renders pages and safely embeds data', () => {
  const env = fresh();
  const t = ownerToken(env);
  const evil = '</script><script>alert(1)</script>';
  const r = env.api(t, 'resources.save', { title: evil, owner_name: 'X <b>y</b>', intake: '2024', platform: 'Box', url: 'https://app.box.com/s/evil', programme_id: progId(env) });
  assert.equal(r.ok, true, JSON.stringify(r));
  env.m.newExecution();
  const out = env.m.context.doGet({ parameter: { p: 'programme', s: 'bachelor-electrical-engineering-with-honours' } });
  const html = out.getContent();
  assert.ok(!html.includes(evil), 'raw </script> must not appear');
  assert.ok(html.includes('\\u003c/script\\u003e'));
  assert.equal(out.meta.viewport.includes('width=device-width'), true);
  assert.equal(out.xfo, 'DEFAULT');
  env.m.newExecution();
  const route = env.m.context.doGet({ parameter: { p: '<script>', s: '"><img>' } }).getContent();
  assert.ok(route.includes('"p":"home"'));
  env.m.newExecution();
  const admin = env.m.context.doGet({ parameter: { p: 'admin' } });
  assert.match(admin.getContent(), /AdminApp\.start/);
  assert.ok(!admin.getContent().includes('"resources"'), 'admin page does not embed data');
});

test('missing database is reported safely', () => {
  const env = fresh();
  env.m.setFailOpen(true);
  const r = env.m.run('getPublicData');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DB_UNAVAILABLE');
  const s = env.m.run('submitResource', { resource_type: 'student', full_name: 'Test', programme_id: 'x', intake: '2024', platform: 'Google Drive', resource_url: 'https://example.com/a', client_id: 'abcdefabcdefabcdef12', elapsed_ms: 9000 });
  assert.equal(s.ok, false);
  env.m.newExecution();
  const html = env.m.context.doGet({ parameter: {} }).getContent();
  assert.match(html, /"ok":false/);
});

// ============================================================================ Submissions
test('valid submission is stored as pending with the correct programme_id', () => {
  const env = fresh();
  const pid = progId(env, 'bachelor-computer-engineering-with-honours');
  const r = submit(env, { programme_id: pid, full_name: '  Ali   bin Abu  ', intake: '2023' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = env.rows('Submissions');
  assert.equal(s.length, 1);
  assert.equal(s[0].programme_id, pid);
  assert.equal(s[0].status, 'pending');
  assert.equal(s[0].full_name, 'Ali bin Abu');
  assert.match(s[0].submitted_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.match(s[0].id, /^sub_[a-f0-9]{20}$/);
  assert.equal(s[0].reviewed_at, '');
});

test('submission validation: required fields', () => {
  const env = fresh();
  const cases = [['full_name', ''], ['programme_id', ''], ['intake', ''], ['resource_url', '']];
  for (const [field, value] of cases) {
    const r = submit(env, { [field]: value });
    assert.equal(r.ok, false, field);
    assert.equal(r.error.code, 'REQUIRED', field);
    assert.equal(r.error.field, field);
  }
  assert.equal(submit(env, { full_name: 'A' }).error.code, 'TOO_SHORT');
  assert.equal(submit(env, { notes: 'x'.repeat(1001) }).error.code, 'TOO_LONG');
  assert.equal(submit(env, { platform: 'MySpace' }).error.code, 'INVALID_OPTION');
  assert.equal(submit(env, { programme_id: 'prg_doesnotexist' }).error.code, 'INVALID_OPTION');
  assert.equal(submit(env, { resource_type: 'hacker' }).error.code, 'INVALID_OPTION');
  assert.equal(env.m.run('submitResource', 'not an object').ok, false);
  assert.equal(env.rows('Submissions').length, 0);
});

test('submission validation: dangerous or invalid URLs are rejected', () => {
  const env = fresh();
  const bad = [
    'javascript:alert(1)', 'JAVASCRIPT://%0aalert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox',
    'file:///etc/passwd', 'ftp://example.com/x', 'drive.google.com/folder', '//evil.com/x', 'http://localhost/admin',
    'http://127.0.0.1/', 'http://192.168.1.10/', 'https://user:pass@evil.com/', 'https://evil.com/a b', 'https://evil.com/"onmouseover=',
    "https://evil.com/'x", 'https://evil.com/<x>', 'https://intranet/', 'https://a..com/', 'https://-a.com/', 'https://x.local/'
  ];
  for (const url of bad) {
    const r = submit(env, { resource_url: url });
    assert.equal(r.ok, false, url);
    assert.ok(['INVALID_URL', 'REQUIRED'].includes(r.error.code), url + ' → ' + r.error.code);
  }
  for (const url of ['https://t.me/unimap_notes', 'https://unimapedumy-my.sharepoint.com/:f:/g/personal/x/EqV?e=1', 'http://example.org/page?q=1#h.abc']) {
    assert.equal(submit(env, { resource_url: url }).ok, true, url);
  }
});

test('honeypot and too-fast forms are silently discarded', () => {
  const env = fresh();
  const a = submit(env, { website: 'http://spam.example.com' });
  const b = submit(env, { elapsed_ms: 300 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(env.rows('Submissions').length, 0, 'nothing stored');
});

test('duplicate protection recognises the same link in different shapes', () => {
  const env = fresh();
  assert.equal(submit(env, { resource_url: 'https://drive.google.com/drive/folders/1NewFolderIdAbcdefgh' }).ok, true);
  const again = submit(env, { resource_url: 'https://drive.google.com/drive/u/0/folders/1NewFolderIdAbcdefgh?usp=sharing' });
  assert.equal(again.error.code, 'DUPLICATE_PENDING');
  const existing = submit(env, { resource_url: 'https://drive.google.com/drive/mobile/folders/19GpBX01ekINNOIDGnKl0b2HevPh0w7_t' });
  assert.equal(existing.error.code, 'DUPLICATE_RESOURCE');
});

test('rate limiting per browser and site-wide', () => {
  const env = fresh();
  const cid = 'a'.repeat(20);
  for (let i = 0; i < 5; i++) assert.equal(submit(env, { client_id: cid }).ok, true);
  assert.equal(submit(env, { client_id: cid }).error.code, 'RATE_LIMITED');
  assert.equal(submit(env).ok, true, 'other browsers unaffected');
  // site-wide limit
  let last;
  for (let i = 0; i < 70; i++) { last = submit(env); if (!last.ok) break; }
  assert.equal(last.error.code, 'RATE_LIMITED');
  // next hour resets
  const now = Date.now();
  env.m.setNow(() => now + 3.8 * 3600 * 1000);
  const orig = Date.now;
  Date.now = () => now + 3.8 * 3600 * 1000;
  try { assert.equal(submit(env).ok, true); } finally { Date.now = orig; env.m.setNow(() => Date.now()); }
});

test('formula injection is neutralised in Google Sheets', () => {
  const env = fresh();
  env.m.resetStats();
  const payloads = ['=HYPERLINK("http://evil.com","click")', '+cmd|x', '-2+3+cmd', '@SUM(1)'];
  payloads.forEach((p, i) => assert.equal(submit(env, { full_name: p, notes: p }).ok, true));
  assert.equal(env.m.stats.formulas, 0, 'no cell became a formula');
  const names = env.rows('Submissions').map((s) => s.full_name);
  payloads.forEach((p) => assert.ok(names.includes(p), 'round-trips exactly: ' + p));
});

test('submissions can be closed and official links need no programme', () => {
  const env = fresh();
  const t = ownerToken(env);
  const o = submit(env, { resource_type: 'official', programme_id: '', intake: '', platform: 'Website', resource_url: 'https://www.unimap.edu.my/index.php/en/academic-calendar' });
  assert.equal(o.ok, true, JSON.stringify(o));
  const s = env.rows('Submissions').find((x) => x.resource_type === 'official');
  assert.equal(s.programme_id, '');
  assert.equal(s.intake, 'Official');
  env.api(t, 'settings.save', { values: { submissions_enabled: false } });
  assert.equal(submit(env).error.code, 'SUBMISSIONS_CLOSED');
  env.api(t, 'settings.save', { values: { submissions_enabled: true, require_https: true } });
  assert.equal(submit(env, { resource_url: 'http://example.org/x' }).error.code, 'URL_HTTPS_REQUIRED');
});

test('a held lock produces a friendly BUSY error, not corruption', () => {
  const env = fresh();
  env.m.lockState.externallyHeld = true;
  const r = submit(env);
  env.m.lockState.externallyHeld = false;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BUSY');
  assert.equal(env.rows('Submissions').length, 0);
});

// ============================================================================ Auth
test('login errors do not reveal whether the account exists; lockout after 5 failures', () => {
  const env = fresh();
  const a = login(env, 'owner@example.com', 'wrong-password-1');
  const b = login(env, 'nobody@example.com', 'wrong-password-1');
  assert.equal(a.error.code, 'INVALID_LOGIN');
  assert.equal(b.error.code, 'INVALID_LOGIN');
  assert.equal(a.error.message, b.error.message);
  for (let i = 0; i < 4; i++) login(env, 'owner@example.com', 'nope');
  const locked = login(env, 'owner@example.com', env.temp);
  assert.equal(locked.error.code, 'LOGIN_LOCKED', 'even the right password is refused while locked');
  assert.equal(login(env, 'OWNER@example.com ', 'x').error.code, 'LOGIN_LOCKED', 'email normalised');
  assert.equal(login(env, { $gt: '' }, 'x').error.code, 'INVALID_LOGIN');
});

test('admin API rejects missing, malformed and forged tokens', () => {
  const env = fresh();
  for (const tok of [undefined, null, '', 'abc', 'f'.repeat(64), { a: 1 }, 'F'.repeat(64)]) {
    const r = env.api(tok, 'bootstrap', {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'AUTH_REQUIRED');
  }
});

test('temporary password must be changed first; change revokes old sessions', () => {
  const env = fresh();
  const l = login(env, 'owner@example.com', env.temp);
  assert.equal(l.data.admin.must_change_password, true);
  assert.equal(env.api(l.data.token, 'bootstrap').error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal(env.api(l.data.token, 'account.changePassword', { current_password: env.temp, new_password: 'short1' }).error.code, 'WEAK_PASSWORD');
  assert.equal(env.api(l.data.token, 'account.changePassword', { current_password: env.temp, new_password: 'onlyletterspassword' }).error.code, 'WEAK_PASSWORD');
  assert.equal(env.api(l.data.token, 'account.changePassword', { current_password: 'wrong', new_password: STRONG }).error.code, 'INVALID_PASSWORD');
  // a second session (another device)
  const other = login(env, 'owner@example.com', env.temp).data.token;
  const c = env.api(l.data.token, 'account.changePassword', { current_password: env.temp, new_password: STRONG });
  assert.equal(c.ok, true);
  assert.equal(env.api(l.data.token, 'bootstrap').error.code, 'AUTH_REQUIRED', 'old token revoked');
  assert.equal(env.api(other, 'bootstrap').error.code, 'AUTH_REQUIRED', 'other device revoked');
  assert.equal(env.api(c.data.token, 'bootstrap').ok, true, 'new token works');
  assert.equal(login(env, 'owner@example.com', env.temp).ok, false, 'temp password no longer valid');
});

test('logout, idle timeout and absolute session lifetime', () => {
  const env = fresh();
  const t = ownerToken(env);
  assert.equal(env.api(t, 'bootstrap').ok, true);
  env.m.run('adminLogout', t);
  assert.equal(env.api(t, 'bootstrap').error.code, 'AUTH_REQUIRED');

  const t2 = login(env, 'owner@example.com', STRONG).data.token;
  const start = Date.now();
  env.m.setNow(() => start + 121 * 60 * 1000); // cache TTL (idle) passes
  assert.equal(env.api(t2, 'bootstrap').error.code, 'AUTH_REQUIRED');
  env.m.setNow(() => Date.now());

  const t3 = login(env, 'owner@example.com', STRONG).data.token;
  const orig = Date.now;
  Date.now = () => orig() + 13 * 3600 * 1000; // beyond absolute lifetime (cache still holds it)
  try { assert.equal(env.api(t3, 'bootstrap').error.code, 'AUTH_REQUIRED'); } finally { Date.now = orig; }
});

test('deactivating or resetting an admin revokes their session immediately', () => {
  const env = fresh();
  const owner = ownerToken(env);
  const a = makeAdmin(env, owner, 'admin');
  assert.equal(env.api(a.token, 'bootstrap').ok, true);
  env.api(owner, 'admins.save', { id: a.id, name: 'Test admin', role: 'admin', is_active: false });
  assert.equal(env.api(a.token, 'bootstrap').error.code, 'AUTH_REQUIRED');
  assert.equal(login(env, a.email, 'Another-Pass-99z').error.code, 'INVALID_LOGIN');
  env.api(owner, 'admins.save', { id: a.id, name: 'Test admin', role: 'admin', is_active: true });
  const t = login(env, a.email, 'Another-Pass-99z').data.token;
  const reset = env.api(owner, 'admins.resetPassword', { id: a.id });
  assert.equal(reset.ok, true);
  assert.equal(env.api(t, 'bootstrap').error.code, 'AUTH_REQUIRED');
  assert.equal(login(env, a.email, reset.data.temp_password).data.admin.must_change_password, true);
});

test('roles are enforced on the server for every action', () => {
  const env = fresh();
  const owner = ownerToken(env);
  const rev = makeAdmin(env, owner, 'reviewer');
  const adm = makeAdmin(env, owner, 'admin');
  const pid = progId(env);
  const forbidden = [
    [rev, 'programmes.save', { name: 'Hacked programme' }],
    [rev, 'resources.save', { title: 'x' }],
    [rev, 'resources.delete', { id: 'x' }],
    [rev, 'settings.save', { values: { site_name: 'Hacked' } }],
    [rev, 'admins.save', { name: 'x', email: 'x@y.com', role: 'owner' }],
    [rev, 'submissions.delete', { id: 'x' }],
    [adm, 'admins.save', { name: 'x', email: 'x@y.com', role: 'owner' }],
    [adm, 'admins.resetPassword', { id: 'x' }],
    [adm, 'settings.save', { values: { rate_limit_global_per_hour: 2000 } }],
    [adm, 'system.health', {}]
  ];
  for (const [who, action, payload] of forbidden) {
    const r = env.api(who.token, action, payload);
    assert.equal(r.ok, false, action);
    assert.equal(r.error.code, 'FORBIDDEN', action + ' → ' + r.error.code);
  }
  assert.equal(env.api(adm.token, 'settings.save', { values: { site_name: 'Hub' } }).ok, true, 'admin can edit content settings');
  submit(env);
  const sub = env.rows('Submissions')[0];
  assert.equal(env.api(rev.token, 'submissions.approve', { id: sub.id }).ok, true, 'reviewer can approve');
  const boot = env.api(rev.token, 'bootstrap');
  assert.equal(boot.data.admins.length, 1, 'non-owners only see themselves');
  assert.equal(env.api(owner, 'nonexistent.action').error.code, 'NOT_FOUND');
  assert.equal(env.api(owner, '__proto__').error.code, 'NOT_FOUND');
  assert.equal(env.api(owner, 'constructor').error.code, 'NOT_FOUND');
  void pid;
});

test('no admin response ever contains password hashes', () => {
  const env = fresh();
  const owner = ownerToken(env);
  const outputs = [env.api(owner, 'bootstrap'), env.api(owner, 'admins.save', { name: 'New', email: 'new@example.com', role: 'reviewer' })];
  outputs.push(env.api(owner, 'admins.resetPassword', { id: outputs[1].data.id }));
  outputs.push(env.api(owner, 'account.updateProfile', { name: 'Owner Person' }));
  outputs.forEach((o) => assert.ok(!/v1\$\d+\$/.test(JSON.stringify(o)) && !/password_hash/.test(JSON.stringify(o)), JSON.stringify(o).slice(0, 200)));
});

// ============================================================================ Admin CRUD
test('programme management: create, validate, update, reorder, delete rules', () => {
  const env = fresh();
  const t = ownerToken(env);
  const c = env.api(t, 'programmes.save', { name: 'Bachelor of Materials Engineering with Honours', name_ar: 'هندسة المواد', code: 'rk31', faculty: 'FKTM' });
  assert.equal(c.ok, true, JSON.stringify(c));
  const p = env.rows('Programmes').find((x) => x.id === c.data.id);
  assert.equal(p.slug, 'bachelor-of-materials-engineering-with-honours');
  assert.equal(p.code, 'RK31');
  assert.equal(c.delta.upsert.Programmes[0].id, p.id, 'delta returned');
  assert.equal(env.api(t, 'programmes.save', { name: 'bachelor of materials engineering with honours' }).error.code, 'DUPLICATE');
  assert.equal(env.api(t, 'programmes.save', { name: 'Other', code: 'RK31' }).error.code, 'DUPLICATE');
  assert.equal(env.api(t, 'programmes.save', { name: 'ab' }).error.code, 'TOO_SHORT');
  assert.equal(env.api(t, 'programmes.save', { id: 'prg_missing', name: 'Xyz programme' }).error.code, 'NOT_FOUND');
  const u = env.api(t, 'programmes.save', { id: p.id, name: 'Bachelor of Materials Engineering', slug: 'materials', code: 'RK31' });
  assert.equal(u.ok, true);
  assert.equal(env.rows('Programmes').find((x) => x.id === p.id).slug, 'materials');
  // reorder: move last to first
  const ids = env.rows('Programmes').slice().sort((a, b) => a.sort_order - b.sort_order).map((x) => x.id);
  const newOrder = [ids[ids.length - 1]].concat(ids.slice(0, -1));
  assert.equal(env.api(t, 'programmes.reorder', { ids: newOrder }).ok, true);
  const sorted = env.rows('Programmes').slice().sort((a, b) => a.sort_order - b.sort_order).map((x) => x.id);
  assert.equal(JSON.stringify(sorted), JSON.stringify(newOrder));
  // delete rules
  const busy = progId(env);
  assert.equal(env.api(t, 'programmes.delete', { id: busy }).error.code, 'IN_USE');
  assert.equal(env.api(t, 'programmes.delete', { id: p.id }).ok, true);
  assert.ok(!env.rows('Programmes').some((x) => x.id === p.id));
  // stable IDs: other rows unaffected by the row deletion
  assert.equal(progId(env), busy);
});

test('resource management: create, duplicates, official rules, toggle, bulk, delete', () => {
  const env = fresh();
  const t = ownerToken(env);
  const pid = progId(env);
  const base = { title: 'EE Notes', owner_name: 'Siti', intake: '2025', platform: 'Google Drive', url: 'https://drive.google.com/drive/folders/1EeNotesFolder123456', programme_id: pid };
  const c = env.api(t, 'resources.save', base);
  assert.equal(c.ok, true, JSON.stringify(c));
  const dup = env.api(t, 'resources.save', Object.assign({}, base, { url: 'https://drive.google.com/drive/u/1/folders/1EeNotesFolder123456?usp=drive_link' }));
  assert.equal(dup.error.code, 'DUPLICATE_RESOURCE');
  assert.equal(env.api(t, 'resources.save', Object.assign({}, base, { programme_id: '' })).error.code, 'REQUIRED', 'student resources need a programme');
  assert.equal(env.api(t, 'resources.save', Object.assign({}, base, { url: 'javascript:alert(1)' })).error.code, 'INVALID_URL');
  assert.equal(env.api(t, 'resources.save', Object.assign({}, base, { platform: 'Nope' })).error.code, 'INVALID_OPTION');
  const cat = env.rows('Categories')[0];
  const off = env.api(t, 'resources.save', { title: 'Academic calendar', owner_name: 'UniMAP', intake: '', platform: 'Website', url: 'https://www.unimap.edu.my/calendar', is_official: true, category_id: cat.id });
  assert.equal(off.ok, true, JSON.stringify(off));
  const offRow = env.rows('Resources').find((r) => r.id === off.data.id);
  assert.equal(offRow.intake, 'Official');
  assert.equal(offRow.category_id, cat.id);
  // toggle
  env.api(t, 'resources.setActive', { id: c.data.id, is_active: false });
  assert.ok(!env.m.run('getPublicData').data.resources.some((r) => r.id === c.data.id));
  // bulk
  const ids = env.rows('Resources').filter((r) => r.programme_id === progId(env, 'bachelor-mechatronic-engineering-with-honours')).map((r) => r.id);
  assert.equal(env.api(t, 'resources.bulk', { ids, op: 'deactivate' }).data.count, ids.length);
  assert.ok(env.rows('Resources').filter((r) => ids.includes(r.id)).every((r) => !r.is_active));
  assert.equal(env.api(t, 'resources.bulk', { ids: ids.slice(0, 3), op: 'delete' }).ok, true);
  assert.equal(env.rows('Resources').filter((r) => ids.includes(r.id)).length, ids.length - 3);
  assert.equal(env.api(t, 'resources.bulk', { ids: ['nope'], op: 'delete' }).error.code, 'NOT_FOUND');
  assert.equal(env.api(t, 'resources.delete', { id: c.data.id }).ok, true);
});

test('collections and platforms: rename cascade and safety rules', () => {
  const env = fresh();
  const t = ownerToken(env);
  const cat = env.rows('Categories')[0];
  assert.equal(env.api(t, 'categories.delete', { id: cat.id }).error.code, 'IN_USE');
  const nc = env.api(t, 'categories.save', { name: 'Examination Schedule', name_ar: 'جدول الامتحانات' });
  assert.equal(nc.ok, true);
  assert.equal(env.api(t, 'categories.delete', { id: nc.data.id }).ok, true);

  const drive = env.rows('Platforms').find((p) => p.name === 'Google Drive');
  submit(env);
  const r = env.api(t, 'platforms.save', { id: drive.id, name: 'Google Drive (shared)' });
  assert.equal(r.ok, true);
  assert.ok(env.rows('Resources').every((x) => x.platform !== 'Google Drive'));
  assert.ok(env.rows('Resources').some((x) => x.platform === 'Google Drive (shared)'));
  assert.equal(env.rows('Submissions')[0].platform, 'Google Drive (shared)');
  assert.equal(env.api(t, 'platforms.delete', { id: drive.id }).error.code, 'IN_USE');
  const other = env.api(t, 'platforms.save', { name: 'Dropbox' });
  assert.equal(env.api(t, 'platforms.delete', { id: other.data.id }).ok, true);
  // cannot deactivate every platform
  const active = env.rows('Platforms').filter((p) => p.is_active);
  let last;
  active.forEach((p) => { last = env.api(t, 'platforms.setActive', { id: p.id, is_active: false }); });
  assert.equal(last.error.code, 'IN_USE');
});

test('approving a submission creates the resource and records everything', () => {
  const env = fresh();
  const t = ownerToken(env);
  const pid = progId(env, 'bachelor-biomedical-electronic-engineering-with-honours');
  submit(env, { programme_id: pid, full_name: 'Farah Lim', intake: '2022', platform: 'OneDrive', resource_url: 'https://unimapedumy-my.sharepoint.com/:f:/g/personal/farah/AbCdEf' });
  const sub = env.rows('Submissions')[0];
  const r = env.api(t, 'submissions.approve', { id: sub.id, admin_notes: 'Looks good' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const res = env.rows('Resources').find((x) => x.id === r.data.resource_id);
  assert.equal(res.programme_id, pid, 'programme_id preserved');
  assert.equal(res.title, 'Farah Lim OneDrive');
  assert.equal(res.owner_name, 'Farah Lim');
  assert.equal(res.intake, '2022');
  assert.equal(res.source_submission_id, sub.id);
  assert.equal(res.is_official, false);
  const after = env.rows('Submissions')[0];
  assert.equal(after.status, 'approved');
  assert.equal(after.reviewed_by, 'owner@example.com');
  assert.ok(after.reviewed_at);
  assert.equal(after.resource_id, res.id);
  assert.equal(after.admin_notes, 'Looks good');
  assert.ok(env.m.run('getPublicData').data.resources.some((x) => x.id === res.id), 'public immediately');
  assert.equal(env.api(t, 'submissions.approve', { id: sub.id }).error.code, 'INVALID_STATE', 'no double approval');
  assert.equal(env.rows('Resources').filter((x) => x.source_submission_id === sub.id).length, 1);
  const log = env.api(t, 'activity.list', { limit: 50 }).data.activity;
  assert.ok(log.some((l) => l.action === 'submission.approve' && l.entity_id === sub.id));
});

test('approval with overrides, and duplicate approvals are blocked atomically', () => {
  const env = fresh();
  const t = ownerToken(env);
  submit(env, { resource_url: 'https://drive.google.com/drive/folders/1SameFolderForBoth00' });
  const s1 = env.rows('Submissions')[0];
  // the same link gets added manually in the meantime
  env.api(t, 'resources.save', { title: 'Manual', owner_name: 'Xavier', intake: '2024', platform: 'Google Drive', url: 'https://drive.google.com/drive/folders/1SameFolderForBoth00', programme_id: s1.programme_id });
  const before = env.rows('Resources').length;
  const r = env.api(t, 'submissions.approve', { id: s1.id });
  assert.equal(r.error.code, 'DUPLICATE_RESOURCE');
  assert.equal(env.rows('Resources').length, before, 'no resource created');
  assert.equal(env.rows('Submissions')[0].status, 'pending', 'still pending');
  // approve with overrides into another programme + as official collection link
  const cat = env.rows('Categories')[0];
  const o = env.api(t, 'submissions.approve', { id: s1.id, resource: { is_official: true, category_id: cat.id, programme_id: '', title: 'Better title', owner_name: 'UniMAP' } });
  assert.equal(o.ok, true, JSON.stringify(o));
  const res = env.rows('Resources').find((x) => x.id === o.data.resource_id);
  assert.equal(res.title, 'Better title');
  assert.equal(res.is_official, true);
  assert.equal(res.category_id, cat.id);
});

test('rejecting, reopening and deleting submissions', () => {
  const env = fresh();
  const t = ownerToken(env);
  submit(env);
  const s = env.rows('Submissions')[0];
  assert.equal(env.api(t, 'submissions.delete', { id: s.id }).error.code, 'INVALID_STATE', 'pending cannot be deleted');
  const r = env.api(t, 'submissions.reject', { id: s.id, admin_notes: 'Link is private' });
  assert.equal(r.ok, true);
  let row = env.rows('Submissions')[0];
  assert.equal(row.status, 'rejected');
  assert.equal(row.admin_notes, 'Link is private');
  assert.equal(row.reviewed_by, 'owner@example.com');
  assert.equal(env.api(t, 'submissions.reject', { id: s.id }).error.code, 'INVALID_STATE');
  assert.equal(env.api(t, 'submissions.reopen', { id: s.id }).ok, true);
  row = env.rows('Submissions')[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.reviewed_at, '');
  env.api(t, 'submissions.reject', { id: s.id });
  assert.equal(env.api(t, 'submissions.delete', { ids: [s.id] }).ok, true);
  assert.equal(env.rows('Submissions').length, 0);
  const acts = env.api(t, 'activity.list', {}).data.activity.map((a) => a.action);
  ['submission.reject', 'submission.reopen', 'submission.delete'].forEach((a) => assert.ok(acts.includes(a), a));
});

test('admin management safety rules', () => {
  const env = fresh();
  const owner = ownerToken(env);
  const me = env.rows('Admins')[0];
  assert.equal(env.api(owner, 'admins.save', { id: me.id, name: 'Me', role: 'admin', is_active: true }).error.code, 'FORBIDDEN', 'cannot demote self');
  assert.equal(env.api(owner, 'admins.save', { id: me.id, name: 'Me', role: 'owner', is_active: false }).error.code, 'FORBIDDEN');
  assert.equal(env.api(owner, 'admins.delete', { id: me.id }).error.code, 'FORBIDDEN');
  assert.equal(env.api(owner, 'admins.save', { name: 'Dup', email: 'OWNER@example.com', role: 'admin' }).error.code, 'DUPLICATE');
  assert.equal(env.api(owner, 'admins.save', { name: 'Bad', email: 'not-an-email', role: 'admin' }).error.code, 'INVALID_EMAIL');
  assert.equal(env.api(owner, 'admins.save', { name: 'Bad', email: 'a@b.com', role: 'superuser' }).error.code, 'INVALID_OPTION');
  const second = makeAdmin(env, owner, 'owner');
  assert.equal(env.api(second.token, 'admins.save', { id: me.id, name: 'Old owner', role: 'admin', is_active: true }).ok, true, 'another owner may demote');
  assert.equal(env.api(second.token, 'admins.save', { id: second.id, name: 'Xavier', role: 'admin' }).error.code, 'FORBIDDEN');
  const x = makeAdmin(env, second.token, 'reviewer');
  assert.equal(env.api(second.token, 'admins.delete', { id: x.id }).ok, true);
  assert.equal(env.api(x.token, 'bootstrap').error.code, 'AUTH_REQUIRED', 'deleted admin is signed out');
});

test('settings: validation, permissions and public effect', () => {
  const env = fresh();
  const t = ownerToken(env);
  assert.equal(env.api(t, 'settings.save', { values: { contact_email: 'nope' } }).error.code, 'INVALID_EMAIL');
  assert.equal(env.api(t, 'settings.save', { values: { session_idle_minutes: 5 } }).error.code, 'INVALID_OPTION');
  assert.equal(env.api(t, 'settings.save', { values: { unknown_key: 1 } }).error.code, 'INVALID_OPTION');
  assert.equal(env.api(t, 'settings.save', { values: { default_language: 'fr' } }).error.code, 'INVALID_OPTION');
  assert.equal(env.api(t, 'settings.save', { values: { site_name: '' } }).error.code, 'REQUIRED');
  const ok = env.api(t, 'settings.save', { values: { tagline_en: 'Built by students', announcement_ar: 'تنبيه مهم', show_welcome: 'false' } });
  assert.equal(ok.ok, true);
  assert.equal(JSON.stringify(ok.data.changed.slice().sort()), JSON.stringify(['announcement_ar', 'show_welcome', 'tagline_en']));
  const pub = env.m.run('getPublicData').data.settings;
  assert.equal(pub.tagline_en, 'Built by students');
  assert.equal(pub.announcement_ar, 'تنبيه مهم');
  assert.equal(pub.show_welcome, false);
  const again = env.api(t, 'settings.save', { values: { tagline_en: 'Built by students' } });
  assert.equal(again.data.changed.length, 0, 'no-op save changes nothing');
});

test('manually re-ordered sheet columns keep working (header-based mapping)', () => {
  const env = fresh();
  const sh = env.m.sheet('Programmes');
  // swap the first two columns (id <-> slug) including data
  sh.data.forEach((row) => { const x = row[0]; row[0] = row[1]; row[1] = x; });
  env.m.run('adminLogin', 'x', 'y');
  env.m.cacheStore.clear();
  const r = env.m.run('getPublicData');
  assert.equal(r.ok, true);
  assert.ok(r.data.programmes.every((p) => /^prg_/.test(p.id) && !/^prg_/.test(p.slug)));
  const t = ownerToken(env);
  const p = r.data.programmes[0];
  assert.equal(env.api(t, 'programmes.save', { id: p.id, name: p.name + ' X' }).ok, true);
  assert.equal(sh.data.find((row) => row[1] === p.id)[3], p.name + ' X');
});

test('efficiency: bounded spreadsheet calls per request', () => {
  const env = fresh();
  const t = ownerToken(env);
  env.m.resetStats();
  env.api(t, 'bootstrap');
  assert.ok(env.m.stats.reads <= 12, 'bootstrap reads: ' + env.m.stats.reads);
  env.m.resetStats();
  submit(env);
  assert.ok(env.m.stats.calls <= 25, 'submission calls: ' + env.m.stats.calls);
  assert.ok(env.m.stats.writes <= 2, 'submission writes: ' + env.m.stats.writes);
  const sub = env.rows('Submissions')[0];
  env.m.resetStats();
  env.api(t, 'submissions.approve', { id: sub.id });
  assert.ok(env.m.stats.writes <= 4, 'approve writes: ' + env.m.stats.writes);
  // large dataset stays within limits
  env.ctx((c) => c.withLock_(() => {
    const rows = [];
    for (let i = 0; i < 3000; i++) rows.push({ id: 'res_bulk' + i, programme_id: progId(env), title: 'Bulk ' + i, owner_name: 'Owner ' + i, intake: '2020', platform: 'Google Drive', url: 'https://example.com/' + i, url_key: 'example.com/' + i, notes: 'n', is_official: false, is_active: true, sort_order: 0 });
    c.db_insertMany_('Resources', rows);
  }));
  env.m.cacheStore.clear();
  env.m.resetStats();
  const pub = env.m.run('getPublicData');
  assert.equal(pub.ok, true);
  assert.ok(pub.data.resources.length > 3000);
  assert.ok(env.m.stats.reads <= 6, 'public reads: ' + env.m.stats.reads);
  env.m.resetStats();
  env.m.run('getPublicData');
  assert.equal(env.m.stats.reads, 0, 'large bundle cached in chunks');
});

test('unexpected errors are reported generically without internals', () => {
  const env = fresh();
  const t = ownerToken(env);
  const orig = env.m.sheet('Resources').getRange;
  env.m.sheet('Resources').getRange = () => { throw new Error('Internal sheet id ss_123 exploded at line 42'); };
  const r = env.api(t, 'resources.save', { title: 'Any title', owner_name: 'Someone', intake: '2024', platform: 'Box', url: 'https://app.box.com/s/abc', programme_id: progId(env) });
  env.m.sheet('Resources').getRange = orig;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SERVER_ERROR');
  assert.ok(!/ss_123|line 42/.test(JSON.stringify(r)));
});

test('activity log records admin actions with actor and timestamp', () => {
  const env = fresh();
  const t = ownerToken(env);
  env.api(t, 'programmes.save', { name: 'Logged programme name' });
  const log = env.api(t, 'activity.list', { limit: 10 }).data.activity;
  const e = log.find((l) => l.action === 'programme.create');
  assert.ok(e);
  assert.equal(e.admin_email, 'owner@example.com');
  assert.match(e.timestamp, /Z$/);
  assert.match(e.id, /^log_/);
  assert.equal(log[0].action, 'programme.create', 'newest first');
});

test('importFromSupabase migrates live data idempotently', () => {
  const env = fresh();
  const ss = env.m.ss;
  const put = (name, rows) => { const sh = ss.insertSheet(name); sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows); };
  put('import_programmes', [
    ['id', 'name', 'slug', 'faculty', 'description', 'is_active', 'created_at'],
    ['uuid-ee', 'Bachelor of Electrical Engineering with Honours', 'bachelor-electrical-engineering-with-honours', 'Engineering', '', 'true', '2025-01-01T00:00:00Z'],
    ['uuid-new', 'Diploma of Electrical Engineering', 'diploma-electrical-engineering', 'FKTE', 'New one', 'true', '2025-02-01T00:00:00Z']
  ]);
  put('import_resources', [
    ['id', 'programme_id', 'title', 'owner_name', 'intake', 'platform', 'url', 'notes', 'is_official', 'is_active', 'created_at'],
    ['r1', 'uuid-ee', 'ADEL Drive', 'ADEL', '2023', 'Google Drive', 'https://drive.google.com/drive/folders/1CHJnJDgs3cqo14FownuZVtShnGe9qhOY', '', 'false', 'true', ''],
    ['r2', 'uuid-new', 'Diploma notes', 'Hafiz', '2024', 'Dropbox', 'https://www.dropbox.com/sh/abc123', 'All sems', 'false', 'true', ''],
    ['r3', 'uuid-missing', 'Orphan', 'X', '2020', 'Box', 'https://app.box.com/s/orphan', '', 'false', 'true', ''],
    ['r4', '', 'Bad link', 'Y', '2020', 'Other', 'javascript:alert(1)', '', 'true', 'true', '']
  ]);
  put('import_submissions', [
    ['id', 'full_name', 'programme_id', 'intake', 'platform', 'resource_url', 'notes', 'status', 'created_at', 'reviewed_at'],
    ['s-1', 'Pending Person', 'uuid-new', '2025', 'Telegram', 'https://t.me/diploma_notes', '', 'pending', '2025-03-01T00:00:00Z', '']
  ]);
  env.m.session.active = 'owner@example.com';
  env.m.newExecution();
  const r1 = env.m.context.importFromSupabase();
  assert.equal(r1.programmes_created, 1);
  assert.equal(r1.programmes_matched, 1);
  assert.equal(r1.resources_created, 1);
  assert.equal(r1.resources_skipped_duplicate, 1);
  assert.equal(r1.submissions_created, 1);
  assert.equal(r1.platforms_created, 1);
  assert.equal(r1.problems.length, 2);
  env.m.newExecution();
  const r2 = env.m.context.importFromSupabase();
  env.m.session.active = '';
  assert.equal(r2.programmes_created + r2.resources_created + r2.submissions_created, 0, 'second run imports nothing');
  const dip = env.rows('Programmes').find((p) => p.slug === 'diploma-electrical-engineering');
  assert.ok(env.rows('Resources').some((r) => r.programme_id === dip.id && r.platform === 'Dropbox'));
  assert.equal(env.rows('Submissions')[0].programme_id, dip.id);
  assert.throws(() => env.m.run('importFromSupabase'), /script owner/);
});

// ============================================================================ doPost API (Cloudflare)
const SECRET = 'x'.repeat(8) + crypto.randomBytes(24).toString('hex');
function apiEnv() {
  const env = fresh();
  env.m.props.PROXY_SHARED_SECRET = SECRET;
  env.post = (action, payload, extra) => env.m.post(Object.assign({ secret: SECRET, action, payload, client: { ip_hash: 'ab'.repeat(16) } }, extra || {})).json;
  return env;
}

test('doPost API is disabled until the shared secret is configured, and rejects bad secrets', () => {
  const env = fresh();
  const r = env.m.post({ secret: 'whatever', action: 'public.data' });
  assert.equal(r.mime, 'application/json');
  assert.equal(r.json.error.code, 'API_DISABLED');
  env.m.props.PROXY_SHARED_SECRET = 'short';
  assert.equal(env.m.post({ secret: 'short', action: 'public.data' }).json.error.code, 'API_DISABLED', 'secrets shorter than 32 chars are refused');
  env.m.props.PROXY_SHARED_SECRET = SECRET;
  for (const bad of [{ action: 'public.data' }, { secret: SECRET.slice(0, -1), action: 'public.data' }, { secret: SECRET + 'x', action: 'public.data' }, { secret: 123, action: 'public.data' }]) {
    assert.equal(env.m.post(bad).json.error.code, 'FORBIDDEN');
  }
  assert.equal(env.m.post('not json').json.error.code, 'BAD_REQUEST');
  assert.equal(env.m.post('x'.repeat(70000)).json.error.code, 'BAD_REQUEST');
  assert.equal(env.m.post({ secret: SECRET, action: 'setup' }).json.error.code, 'NOT_FOUND', 'only allow-listed actions');
  assert.equal(env.m.post({ secret: SECRET, action: 'hashPassword_' }).json.error.code, 'NOT_FOUND');
});

test('doPost API returns the same public data and accepts submissions with IP rate limits', () => {
  const env = apiEnv();
  const viaApi = env.post('public.data', {});
  assert.equal(viaApi.ok, true);
  const direct = env.m.run('getPublicData');
  assert.equal(JSON.stringify(viaApi.data.programmes), JSON.stringify(direct.data.programmes));
  assert.ok(!/owner@example\.com|v1\$/.test(JSON.stringify(viaApi)));
  // submissions: per-IP limit is 20/hour even with different browser ids
  let last;
  for (let i = 0; i < 21; i++) { last = env.post('public.submit', { form: submission(env) }); if (!last.ok) break; }
  assert.equal(last.error.code, 'RATE_LIMITED');
  assert.equal(env.rows('Submissions').length, 20);
  // another IP is unaffected; google.script.run path is unaffected
  const other = env.m.post({ secret: SECRET, action: 'public.submit', payload: { form: submission(env) }, client: { ip_hash: 'cd'.repeat(16) } }).json;
  assert.equal(other.ok, true);
  assert.equal(submit(env).ok, true);
  // invalid input is still validated by the same server code
  assert.equal(env.post('public.submit', { form: submission(env, { resource_url: 'javascript:alert(1)' }) }).error.code, 'INVALID_URL', 'validation runs before rate limits');
  const fresh2 = env.m.post({ secret: SECRET, action: 'public.submit', payload: { form: submission(env, { resource_url: 'javascript:alert(1)' }) }, client: { ip_hash: 'ef'.repeat(16) } }).json;
  assert.equal(fresh2.error.code, 'INVALID_URL');
});

test('doPost API: admin login, admin calls and authorization are identical to google.script.run', () => {
  const env = apiEnv();
  const l = env.post('auth.login', { email: 'owner@example.com', password: env.temp });
  assert.equal(l.ok, true);
  assert.match(l.data.token, /^[a-f0-9]{64}$/);
  assert.equal(env.post('admin', { token: l.data.token, action: 'bootstrap' }).error.code, 'PASSWORD_CHANGE_REQUIRED');
  const c = env.post('admin', { token: l.data.token, action: 'account.changePassword', payload: { current_password: env.temp, new_password: STRONG } });
  assert.equal(c.ok, true);
  const tok = c.data.token;
  const boot = env.post('admin', { token: tok, action: 'bootstrap' });
  assert.equal(boot.ok, true);
  assert.ok(!/password_hash|v1\$\d+\$/.test(JSON.stringify(boot)));
  // token from one path works on the other (shared sessions), and forged tokens fail
  assert.equal(env.api(tok, 'bootstrap').ok, true);
  assert.equal(env.post('admin', { token: 'f'.repeat(64), action: 'bootstrap' }).error.code, 'AUTH_REQUIRED');
  assert.equal(env.post('admin', { action: 'bootstrap' }).error.code, 'AUTH_REQUIRED');
  // reviewer restrictions still enforced through the API
  const rev = makeAdmin(env, tok, 'reviewer');
  assert.equal(env.post('admin', { token: rev.token, action: 'programmes.save', payload: { name: 'Hacked programme' } }).error.code, 'FORBIDDEN');
  assert.equal(env.post('admin', { token: tok, action: 'no.such.action' }).error.code, 'NOT_FOUND');
  // logout
  assert.equal(env.post('auth.logout', { token: tok }).ok, true);
  assert.equal(env.post('admin', { token: tok, action: 'bootstrap' }).error.code, 'AUTH_REQUIRED');
});

test('doPost API: login with bootstrap returns the dashboard in one execution, with the same checks', () => {
  const env = apiEnv();
  // Temporary password: no dashboard data until it is changed.
  const first = env.post('auth.login', { email: 'owner@example.com', password: env.temp, bootstrap: true });
  assert.equal(first.ok, true);
  assert.equal(first.data.bootstrap, undefined);
  const tok = env.post('admin', { token: first.data.token, action: 'account.changePassword', payload: { current_password: env.temp, new_password: STRONG } }).data.token;
  env.post('auth.logout', { token: tok });
  const l = env.post('auth.login', { email: 'owner@example.com', password: STRONG, bootstrap: true });
  assert.equal(l.ok, true);
  assert.ok(l.data.bootstrap && Array.isArray(l.data.bootstrap.programmes) && l.data.bootstrap.me.email === 'owner@example.com');
  assert.ok(!/password_hash|v1\$\d+\$/.test(JSON.stringify(l)), 'no hashes leak');
  // Wrong password: plain error, nothing else.
  const bad = env.post('auth.login', { email: 'owner@example.com', password: 'wrong-password-123', bootstrap: true });
  assert.equal(bad.error.code, 'INVALID_LOGIN');
  assert.equal(bad.data, undefined);
  // Without the flag the old response shape is unchanged.
  assert.equal(env.post('auth.login', { email: 'owner@example.com', password: STRONG }).data.bootstrap, undefined);
});

test('doPost API: per-IP login lockout without affecting other IPs', () => {
  const env = apiEnv();
  const attempt = (ip, email) => env.m.post({ secret: SECRET, action: 'auth.login', payload: { email, password: 'wrong-password' }, client: { ip_hash: ip } }).json;
  const ip = '12'.repeat(16);
  let r;
  for (let i = 0; i < 25; i++) r = attempt(ip, 'user' + i + '@example.com');
  assert.equal(r.error.code, 'LOGIN_LOCKED', 'one IP trying many emails gets locked');
  const ok = env.m.post({ secret: SECRET, action: 'auth.login', payload: { email: 'owner@example.com', password: env.temp }, client: { ip_hash: '34'.repeat(16) } }).json;
  assert.equal(ok.ok, true, 'other IPs can still sign in');
});

test('adding the API does not change the HTML Service website', () => {
  const env = apiEnv();
  env.m.newExecution();
  const html = env.m.context.doGet({ parameter: {} }).getContent();
  assert.match(html, /PublicApp\.start/);
  assert.equal(env.m.run('getPublicData').ok, true);
  assert.throws(() => env.m.run('apiHandle_'), /not found/);
});

test('generateProxySecret is owner-only, stores a long secret and never logs it', () => {
  const env = fresh();
  assert.throws(() => env.m.run('generateProxySecret'), /script owner/);
  env.m.session.active = 'owner@example.com';
  env.m.logs.length = 0;
  env.m.newExecution();
  env.m.context.generateProxySecret();
  const secret = env.m.props.PROXY_SHARED_SECRET;
  assert.match(secret, /^[a-f0-9]{128}$/);
  assert.ok(!env.m.logs.join('\n').includes(secret), 'secret not written to the log');
  env.m.session.active = '';
  assert.equal(env.m.post({ secret, action: 'health' }).json.ok, true);
});

// ============================================================================ Anonymous analytics
test('analytics: ingest aggregates per day, counts unique visitors once, validates input', () => {
  const env = apiEnv();
  const pid = progId(env);
  const rid = env.rows('Resources')[0].id;
  const batch = {
    counts: [['visit', '', 3], ['pageview', '', 5], ['page', 'home', 3], ['page', 'programme', 2], ['programme', pid, 2],
      ['click', rid, 1], ['device', 'mobile', 2], ['device', 'desktop', 1], ['browser', 'chrome', 3], ['country', 'MY', 3],
      ['referrer', 'direct', 2], ['referrer', 'google', 1], ['search', '', 2], ['search_empty', '', 1],
      // invalid rows are ignored
      ['ip', '1.2.3.4', 1], ['page', '=HYPERLINK("x")', 1], ['click', 'javascript:alert(1)', 1], ['visit', '', -5], ['uniques', '', 99], 'junk'],
    visitors: ['a1b2c3d4e5f60718', 'a1b2c3d4e5f60718', '0011223344556677', 'not-a-hash']
  };
  assert.equal(env.post('analytics.ingest', batch).ok, true);
  // second batch the same day: same visitor again + one new one; counters add up in the same rows
  assert.equal(env.post('analytics.ingest', { counts: [['visit', '', 1], ['page', 'home', 1]], visitors: ['a1b2c3d4e5f60718', '8899aabbccddeeff'] }).ok, true);
  const rows = env.ctx((c) => c.analyticsSheet_(false).getRange(1, 1, c.analyticsSheet_(false).getLastRow(), 4).getValues());
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), ['date', 'metric', 'key', 'count']);
  const find = (m, k) => rows.find((r) => r[1] === m && r[2] === k);
  assert.equal(find('visit', '')[3], 4);
  assert.equal(find('page', 'home')[3], 4);
  assert.equal(find('uniques', '')[3], 3, 'each daily visitor code counted once');
  assert.equal(rows.filter((r) => r[1] === 'page' && r[2] === 'home').length, 1, 'one row per day per counter');
  const text = JSON.stringify(rows);
  assert.ok(!/1\.2\.3\.4|HYPERLINK|javascript|a1b2c3d4e5f60718|8899aabbccddeeff/.test(text), 'no IPs, injected values or visitor codes stored');
  assert.equal(rows[0].length, 4);
});

test('analytics: summary is admin-only, computes periods and top lists; ingest needs the proxy secret', () => {
  const env = apiEnv();
  const t = ownerToken(env);
  const pid = progId(env);
  const day = 86400000;
  const now = Date.now();
  // yesterday and today, written through the real ingest code with fixed clocks
  env.ctx((c) => c.analyticsIngest_({ counts: [['visit', '', 2], ['pageview', '', 4], ['programme', pid, 3]], visitors: ['1111111111111111'] }, now - day));
  env.ctx((c) => c.analyticsIngest_({ counts: [['visit', '', 5], ['pageview', '', 9], ['programme', pid, 1], ['device', 'mobile', 5]], visitors: ['1111111111111111', '2222222222222222'] }, now));
  const s = env.api(t, 'analytics.summary', {});
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.data.periods.today.visits, 5);
  assert.equal(s.data.periods.total.visits, 7);
  assert.equal(s.data.periods.total.uniques, 3, 'visitor codes are per day: same person yesterday and today counts twice');
  assert.equal(s.data.top.programmes[0].key, pid);
  assert.equal(s.data.top.programmes[0].count, 4);
  assert.equal(s.data.daily.length, 30);
  assert.equal(s.data.daily[29].visits, 5);
  // role checks
  const rev = makeAdmin(env, t, 'reviewer');
  assert.equal(env.api(rev.token, 'analytics.summary', {}).error.code, 'FORBIDDEN', 'reviewers cannot see analytics');
  const adm = makeAdmin(env, t, 'admin');
  assert.equal(env.api(adm.token, 'analytics.summary', {}).ok, true);
  assert.equal(env.api('f'.repeat(64), 'analytics.summary', {}).error.code, 'AUTH_REQUIRED');
  // not callable from the browser, and doPost needs the secret
  assert.throws(() => env.m.run('analyticsIngest_', { counts: [['visit', '', 1]] }));
  assert.equal(env.m.post({ secret: 'wrong-secret-'.repeat(4), action: 'analytics.ingest', payload: { counts: [['visit', '', 1000]] } }).json.error.code, 'FORBIDDEN');
});

test('analytics: rows older than the retention window are pruned', () => {
  const env = apiEnv();
  const day = 86400000;
  const now = Date.now();
  env.ctx((c) => {
    const sh = c.analyticsSheet_(true);
    const d = (n) => c.analyticsDate_(now - n * day);
    sh.getRange(2, 1, 3, 4).setValues([[d(500), 'visit', '', 9], [d(401), 'visit', '', 8], [d(10), 'visit', '', 7]]);
  });
  env.ctx((c) => c.analyticsIngest_({ counts: [['visit', '', 1]] }, now));
  const rows = env.ctx((c) => c.analyticsSheet_(false).getRange(2, 1, c.analyticsSheet_(false).getLastRow() - 1, 4).getValues());
  assert.deepEqual(rows.map((r) => r[3]), [7, 1], 'rows older than 400 days removed, recent ones kept');
});
