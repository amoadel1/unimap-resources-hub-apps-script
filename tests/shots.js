// Usage: node tests/shots.js <outdir> <name>=<path>[@mobile|@desktop][#dark] ...
'use strict';
const { chromium } = require('playwright');
const { createDevApp } = require('./dev-server');
(async () => {
  const [outDir, ...specs] = process.argv.slice(2);
  const app = createDevApp({ latency: 0 });
  await new Promise((r) => app.server.listen(8790, r));
  const browser = await chromium.launch();
  const errors = [];
  for (const spec of specs) {
    const m = /^([^=]+)=([^@#]*)(?:@(mobile|desktop))?(?:#(dark))?(?:\+(.*))?$/.exec(spec);
    const [, name, p, dev = 'desktop', dark, script] = m;
    const ctx = await browser.newContext({
      viewport: dev === 'mobile' ? { width: 390, height: 844 } : { width: 1360, height: 900 },
      deviceScaleFactor: dev === 'mobile' ? 2 : 1, colorScheme: dark ? 'dark' : 'light', isMobile: dev === 'mobile', hasTouch: dev === 'mobile'
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(name + ' console: ' + msg.text()); });
    await page.goto('http://localhost:8790/' + p, { waitUntil: 'networkidle' }).catch(()=>{});
    if (script) { await page.evaluate(script).catch((e) => errors.push(name + ' script: ' + e.message)); await page.waitForTimeout(600); }
    await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
    await ctx.close();
  }
  await browser.close();
  app.server.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
})();
