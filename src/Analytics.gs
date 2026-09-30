/**
 * Analytics.gs
 * Privacy-friendly, anonymous visitor statistics.
 *
 * Collection (Cloudflare only): the browser sends small anonymous events to the Worker
 * (/api/collect). The Worker drops bots, derives coarse categories (device type, browser
 * family, country code, referrer host), adds them up in memory and sends ONE aggregated
 * batch to Apps Script about once a minute (action 'analytics.ingest', proxy secret only).
 *
 * Storage: sheet "Analytics" with ONE ROW PER DAY PER COUNTER, never one row per visitor:
 *     date | metric | key | count
 *     2026-10-01 | page | programme | 42
 *
 * Privacy:
 *   - No IP addresses, user agents, names, emails, cookies, search text or full URLs are
 *     stored. Referrers are reduced to a host name.
 *   - Unique visitors: the Worker sends a keyed hash that changes every day (it cannot be
 *     reversed or linked across days). Apps Script only keeps it in CacheService for about
 *     a day to avoid double counting; it is never written to the sheet.
 *   - Rows older than ANALYTICS_RETENTION_DAYS_ are deleted automatically.
 *
 * Reading: 'analytics.summary' is an admin action (role: admin or owner).
 */

var ANALYTICS_SHEET_ = 'Analytics';
var ANALYTICS_HEADER_ = ['date', 'metric', 'key', 'count'];
var ANALYTICS_RETENTION_DAYS_ = 400;       // ~13 months of daily totals
var ANALYTICS_TZ_OFFSET_MS_ = 8 * 3600000; // Malaysia time (UTC+8, no daylight saving)
var ANALYTICS_MAX_ROWS_PER_DAY_ = 1500;    // safety cap; extra keys are counted under "other"
var ANALYTICS_TAIL_ROWS_ = 2000;           // rows read to find today's block

/** Allowed counters and the shape of their keys. */
var ANALYTICS_METRICS_ = {
  visit:        /^$/,                                  // a visit (first page of a browser tab session)
  pageview:     /^$/,                                  // every page shown
  uniques:      /^$/,                                  // unique visitors (computed here, per day)
  page:         /^(home|search|programme|official|submit|about|notfound)(:[a-z0-9-]{1,80})?$/,
  programme:    /^prg_[a-z0-9]{6,40}$/,
  click:        /^res_[a-z0-9]{6,40}$/,
  search:       /^$/,
  search_empty: /^$/,
  device:       /^(mobile|tablet|desktop)$/,
  browser:      /^(chrome|safari|firefox|edge|samsung|opera|other)$/,
  country:      /^[A-Z]{2}$/,
  referrer:     /^(direct|[a-z0-9.-]{1,80})$/
};

function analyticsDate_(ms) {
  return new Date(ms + ANALYTICS_TZ_OFFSET_MS_).toISOString().slice(0, 10);
}

function analyticsSheet_(create) {
  var ss = db_ss_();
  var sh = ss.getSheetByName(ANALYTICS_SHEET_);
  if (!sh && create) {
    sh = ss.insertSheet(ANALYTICS_SHEET_);
    sh.getRange(1, 1, 1, ANALYTICS_HEADER_.length).setValues([ANALYTICS_HEADER_]);
    try {
      sh.setFrozenRows(1);
      sh.getRange('A:C').setNumberFormat('@'); // keep dates and keys as plain text
      sh.getRange(1, 1, 1, ANALYTICS_HEADER_.length).setFontWeight('bold');
    } catch (e) { /* cosmetic only */ }
  }
  return sh;
}

/**
 * Adds one aggregated batch from the Worker.
 * payload = { counts: [[metric, key, n], ...], visitors: ['<daily hash>', ...] }
 */
function analyticsIngest_(payload, nowMs) {
  nowMs = nowMs || Date.now();
  var p = isPlainObject_(payload) ? payload : {};
  var counts = Array.isArray(p.counts) ? p.counts.slice(0, 600) : [];
  var visitors = Array.isArray(p.visitors) ? p.visitors.slice(0, 2000) : [];
  var today = analyticsDate_(nowMs);

  // 1. Validate and merge the increments.
  var inc = {};
  counts.forEach(function (row) {
    if (!Array.isArray(row) || row.length !== 3) return;
    var metric = String(row[0]), key = String(row[1] === null || row[1] === undefined ? '' : row[1]), n = Number(row[2]);
    var re = ANALYTICS_METRICS_[metric];
    if (!re || metric === 'uniques' || !re.test(key)) return;
    if (!(n >= 1 && n <= 100000) || Math.floor(n) !== n) return;
    var k = metric + '\u0001' + key;
    inc[k] = (inc[k] || 0) + n;
  });

  // 2. Unique visitors: count daily hashes not seen yet today (kept ~1 day in the cache only).
  var hashes = [];
  visitors.forEach(function (h) { if (typeof h === 'string' && /^[a-f0-9]{16,64}$/.test(h) && hashes.indexOf(h) === -1) hashes.push(h); });
  var cache = CacheService.getScriptCache();
  var fresh = [];
  for (var i = 0; i < hashes.length; i += 100) {
    var chunk = hashes.slice(i, i + 100);
    var keys = chunk.map(function (h) { return 'uv:' + today + ':' + h; });
    var seen = {};
    try { seen = cache.getAll(keys) || {}; } catch (e) { seen = {}; }
    var toPut = {};
    keys.forEach(function (k, j) { if (!seen[k]) { fresh.push(chunk[j]); toPut[k] = '1'; } });
    try { if (Object.keys(toPut).length) cache.putAll(toPut, 26 * 3600); } catch (e) {}
  }
  if (fresh.length) inc['uniques\u0001'] = fresh.length;

  var keysIn = Object.keys(inc);
  if (!keysIn.length) return { written: 0 };

  // 3. Merge into today's block (always the last rows of the sheet) with one write.
  return withLock_(function () {
    var sh = analyticsSheet_(true);
    var lastRow = sh.getLastRow();
    var n = Math.min(Math.max(lastRow - 1, 0), ANALYTICS_TAIL_ROWS_);
    var tail = n ? sh.getRange(lastRow - n + 1, 1, n, 4).getValues() : [];
    var start = tail.length;
    while (start > 0 && String(tail[start - 1][0]) === today) start--;
    var block = tail.slice(start).map(function (r) { return [today, String(r[1]), String(r[2]), Number(r[3]) || 0]; });
    var index = {};
    block.forEach(function (r, j) { index[r[1] + '\u0001' + r[2]] = j; });

    keysIn.forEach(function (orig) {
      var parts = orig.split('\u0001'), metric = parts[0], key = parts[1];
      var k = orig, at = index[k];
      if (at === undefined && block.length >= ANALYTICS_MAX_ROWS_PER_DAY_ && key !== '') {
        key = 'other'; k = metric + '\u0001other'; at = index[k];
      }
      if (at === undefined) {
        index[k] = block.length;
        block.push([today, metric, key, 0]);
        at = block.length - 1;
      }
      block[at][3] += inc[orig];
    });

    var firstRow = lastRow - (tail.length - start) + 1;
    if (lastRow < 2) firstRow = 2;
    if (block.length) sh.getRange(firstRow, 1, block.length, 4).setValues(block);

    analyticsPrune_(sh, nowMs);
    return { written: block.length, uniques: fresh.length };
  });
}

/** Deletes rows older than the retention window (at most once a day). */
function analyticsPrune_(sh, nowMs) {
  var cache = CacheService.getScriptCache();
  var flag = 'an:pruned:' + analyticsDate_(nowMs);
  try { if (cache.get(flag)) return 0; } catch (e) {}
  var cutoff = analyticsDate_(nowMs - ANALYTICS_RETENTION_DAYS_ * 86400000);
  var lastRow = sh.getLastRow();
  var removed = 0;
  if (lastRow >= 2) {
    var n = Math.min(lastRow - 1, 20000);
    var dates = sh.getRange(2, 1, n, 1).getValues();
    while (removed < dates.length && String(dates[removed][0]) < cutoff) removed++;
    if (removed) sh.deleteRows(2, removed);
  }
  try { cache.put(flag, '1', 26 * 3600); } catch (e) {}
  return removed;
}

/**
 * Admin dashboard summary. Everything is computed here; the browser only receives totals.
 */
function analyticsSummary_(admin, p, nowMs) {
  nowMs = nowMs || Date.now();
  var sh = analyticsSheet_(false);
  var rows = [];
  if (sh) {
    var lastRow = sh.getLastRow();
    if (lastRow >= 2) rows = sh.getRange(2, 1, lastRow - 1, 4).getValues();
  }
  var today = analyticsDate_(nowMs);
  var local = new Date(nowMs + ANALYTICS_TZ_OFFSET_MS_);
  var dow = (local.getUTCDay() + 6) % 7; // Monday = 0
  var weekStart = analyticsDate_(nowMs - dow * 86400000);
  var monthStart = today.slice(0, 8) + '01';
  var last30 = analyticsDate_(nowMs - 29 * 86400000);

  var empty = function () { return { visits: 0, pageviews: 0, uniques: 0, clicks: 0, searches: 0 }; };
  var periods = { today: empty(), week: empty(), month: empty(), total: empty() };
  var field = { visit: 'visits', pageview: 'pageviews', uniques: 'uniques', click: 'clicks', search: 'searches' };
  var top = { page: {}, programme: {}, click: {}, device: {}, browser: {}, country: {}, referrer: {} };
  var daily = {};
  var searchEmpty30 = 0, search30 = 0;
  var first = '';

  rows.forEach(function (r) {
    var date = String(r[0]), metric = String(r[1]), key = String(r[2]), n = Number(r[3]) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !n) return;
    if (!first || date < first) first = date;
    var f = field[metric];
    if (f) {
      periods.total[f] += n;
      if (date >= monthStart) periods.month[f] += n;
      if (date >= weekStart) periods.week[f] += n;
      if (date === today) periods.today[f] += n;
    }
    if (date >= last30) {
      if (top[metric]) top[metric][key] = (top[metric][key] || 0) + n;
      if (metric === 'search') search30 += n;
      if (metric === 'search_empty') searchEmpty30 += n;
      if (metric === 'visit' || metric === 'pageview' || metric === 'uniques') {
        var d = daily[date] || (daily[date] = { date: date, visits: 0, pageviews: 0, uniques: 0 });
        d[field[metric]] += n;
      }
    }
  });

  var topList = function (obj, limit) {
    return Object.keys(obj).map(function (k) { return { key: k, count: obj[k] }; })
      .sort(function (a, b) { return b.count - a.count || (a.key < b.key ? -1 : 1); }).slice(0, limit);
  };
  var series = [];
  for (var i = 29; i >= 0; i--) {
    var ds = analyticsDate_(nowMs - i * 86400000);
    series.push(daily[ds] || { date: ds, visits: 0, pageviews: 0, uniques: 0 });
  }

  return {
    today: today,
    since: first,
    timezone: 'Asia/Kuala_Lumpur (UTC+8)',
    retention_days: ANALYTICS_RETENTION_DAYS_,
    periods: periods,
    daily: series,
    top: {
      pages: topList(top.page, 12),
      programmes: topList(top.programme, 12),
      clicks: topList(top.click, 15),
      devices: topList(top.device, 5),
      browsers: topList(top.browser, 8),
      countries: topList(top.country, 10),
      referrers: topList(top.referrer, 12)
    },
    searches_30d: search30,
    searches_no_results_30d: searchEmpty30
  };
}
