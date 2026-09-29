/**
 * Code.gs
 * Web app entry point (doGet) and the ONLY functions the browser may call.
 *
 * Browser-callable surface (everything else ends with "_" and is private):
 *   getPublicData()                     → public programmes/resources/settings
 *   submitResource(form)                → public submission (validated + rate limited)
 *   adminLogin(email, password)         → returns a session token
 *   adminLogout(token)
 *   adminApi(token, action, payload)    → every admin operation (authorised per call)
 *   doPost(e)                           → JSON API for the Cloudflare frontend (Api.gs);
 *                                         requires the PROXY_SHARED_SECRET script property
 * Setup.gs also exposes owner-only maintenance functions that refuse to run
 * unless executed by the script owner from the Apps Script editor.
 */

function doGet(e) {
  var params = (e && e.parameter) || {};
  var page = String(params.p || '').toLowerCase();
  var siteName = APP.NAME;
  var tpl;

  if (page === 'admin') {
    tpl = HtmlService.createTemplateFromFile('Admin');
    tpl.appUrl = safeAppUrl_();
    try { siteName = String(settingsMap_().site_name || APP.NAME); } catch (err) {}
    tpl.siteName = siteName;
    return finishOutput_(tpl, siteName + ' — Admin');
  }

  tpl = HtmlService.createTemplateFromFile('Index');
  var boot;
  try {
    boot = { ok: true, data: publicBundle_() };
    siteName = boot.data.settings.site_name || APP.NAME;
  } catch (err) {
    boot = errorResponse_(err);
  }
  tpl.bootJson = safeJson_(boot);
  tpl.routeJson = safeJson_(initialRoute_(params));
  tpl.appUrl = safeAppUrl_();
  tpl.siteName = siteName;
  return finishOutput_(tpl, siteName);
}

function finishOutput_(tpl, title) {
  return tpl.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Used by templates: <?!= include_('Styles') ?> */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** JSON that is safe to embed inside a <script> element. */
function safeJson_(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function safeAppUrl_() {
  try {
    var u = ScriptApp.getService().getUrl() || '';
    return /^https:\/\/script\.google\.com\//.test(u) ? u : '';
  } catch (e) {
    return '';
  }
}

/** Whitelisted deep-link parameters (?p=programme&s=slug, ?p=official&c=slug, ?p=search&q=...). */
function initialRoute_(params) {
  var page = String(params.p || 'home').toLowerCase();
  if (['home', 'programme', 'official', 'submit', 'about', 'search', 'contact'].indexOf(page) === -1) page = 'home';
  return {
    p: page === 'contact' ? 'about' : page,
    s: slugify_(params.s || '').slice(0, 120),
    c: slugify_(params.c || '').slice(0, 120),
    q: cleanLine_(params.q || '').slice(0, 120),
    lang: params.lang === 'ar' || params.lang === 'en' ? params.lang : ''
  };
}

// ---------------------------------------------------------------------------
// Public data
// ---------------------------------------------------------------------------

function bySortThenName_(a, b) {
  return (a.sort_order - b.sort_order) || String(a.name).localeCompare(String(b.name));
}

/** Builds (or returns the cached) public data bundle. */
function publicBundle_() {
  var cached = cacheGetJson_(APP.CACHE_PUBLIC);
  if (cached) return cached;

  var programmes = db_rows_('Programmes').filter(function (p) { return p.is_active; }).sort(bySortThenName_);
  var categories = db_rows_('Categories').filter(function (c) { return c.is_active; }).sort(bySortThenName_);
  var activeProg = {}, activeCat = {};
  programmes.forEach(function (p) { activeProg[p.id] = true; });
  categories.forEach(function (c) { activeCat[c.id] = true; });

  var resources = db_rows_('Resources').filter(function (r) {
    if (!r.is_active) return false;
    if (r.is_official) {
      if (r.category_id && !activeCat[r.category_id]) return false;
      if (r.programme_id && !activeProg[r.programme_id]) return false;
      return true;
    }
    return !!activeProg[r.programme_id];
  }).map(function (r) {
    return {
      id: r.id, programme_id: r.programme_id, category_id: r.category_id, title: r.title,
      owner_name: r.owner_name, intake: r.intake, platform: r.platform, url: r.url,
      notes: r.notes, is_official: r.is_official, sort_order: r.sort_order,
      created_at: r.created_at
    };
  });

  var bundle = {
    version: APP.VERSION,
    generated_at: nowIso_(),
    settings: publicSettings_(),
    programmes: programmes.map(function (p) {
      return {
        id: p.id, slug: p.slug, code: p.code, name: p.name, name_ar: p.name_ar, faculty: p.faculty,
        description: p.description, description_ar: p.description_ar, sort_order: p.sort_order
      };
    }),
    categories: categories.map(function (c) {
      return { id: c.id, slug: c.slug, name: c.name, name_ar: c.name_ar, description: c.description, description_ar: c.description_ar, sort_order: c.sort_order };
    }),
    resources: resources,
    platforms: db_rows_('Platforms').filter(function (p) { return p.is_active; }).sort(bySortThenName_)
      .map(function (p) { return p.name; })
  };
  cachePutJson_(APP.CACHE_PUBLIC, bundle, APP.CACHE_TTL_PUBLIC);
  return bundle;
}

// ---------------------------------------------------------------------------
// Browser-callable functions
// ---------------------------------------------------------------------------

function getPublicData() {
  return respond_(publicBundle_);
}

function submitResource(form) {
  return respond_(function () { return submissionCreate_(form); });
}

function adminLogin(email, password) {
  return respond_(function () { return login_(email, password); });
}

function adminLogout(token) {
  return respond_(function () { return logout_(token); });
}

function adminApi(token, action, payload) {
  return adminDispatch_(token, action, payload);
}
