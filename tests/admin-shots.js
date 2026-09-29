'use strict';
const { chromium } = require('playwright');
const { createDevApp } = require('./dev-server');
(async () => {
  const out = process.argv[2];
  const app = createDevApp({ latency: 0 });
  // add a pending submission for realism
  app.m.run('submitResource', { resource_type: 'student', full_name: 'Nur Aisyah Binti Ahmad', programme_id: app.m.context.db_rows_('Programmes')[0].id, intake: '2024', platform: 'Google Drive', resource_url: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv', notes: 'Semester 3 notes and past years', client_id: 'abcdef0123456789abcd', elapsed_ms: 9000 });
  await new Promise((r) => app.server.listen(8791, r));
  const browser = await chromium.launch();
  const errors = [];
  for (const dev of ['desktop', 'mobile']) {
    const ctx = await browser.newContext(dev === 'mobile' ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(dev + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/TUNNEL/.test(m.text())) errors.push(dev + ' console: ' + m.text()); });
    await page.goto('http://localhost:8791/?p=admin');
    if (dev === 'desktop') await page.screenshot({ path: `${out}/adm-login.png` });
    await page.fill('#email', 'owner@example.com');
    await page.fill('#password', dev === 'desktop' ? app.tempPassword : 'Kedah-Perlis-2026x');
    await page.click('#login-form button[type=submit]');
    await page.waitForTimeout(700);
    if (dev === 'desktop') {
      await page.screenshot({ path: `${out}/adm-forcepw.png` });
      await page.fill('[name=current_password]', app.tempPassword);
      await page.fill('[name=new_password]', 'Kedah-Perlis-2026x');
      await page.fill('[name=confirm_password]', 'Kedah-Perlis-2026x');
      await page.click('#pw-form button[type=submit]');
      await page.waitForTimeout(900);
    }
    for (const v of ['overview', 'submissions', 'resources', 'programmes', 'settings']) {
      await page.evaluate((v) => AdminApp.ctx.setView(v), v);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}/adm-${dev}-${v}.png`, fullPage: dev === 'desktop' && v !== 'settings' });
    }
    await page.evaluate(() => AdminApp.ctx.setView('submissions'));
    await page.click('[data-a="review"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/adm-${dev}-review.png` });
    if (dev === 'mobile') {
      await page.keyboard.press('Escape');
      await page.click('[data-act="open-nav"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/adm-mobile-nav.png` });
    }
    await ctx.close();
  }
  await browser.close(); app.server.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
})();
