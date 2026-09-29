/**
 * Setup.gs
 * One-time setup and owner-only maintenance. Run these from the Apps Script editor
 * (select the function in the toolbar → Run). Results appear in the Execution log.
 *
 *   setup()               Creates/repairs all sheets, headers, default settings and
 *                         platforms, the password pepper, and the first OWNER admin.
 *   seedInitialData()     Imports the programmes, student drives and official links
 *                         from the previous (Next.js/Supabase) version. Safe to re-run.
 *   validateSetup()       Checks that the spreadsheet structure is correct.
 *   recoverOwnerAccess()  Emergency: gives YOUR Google account's admin a new temporary
 *                         password (creates an owner admin if none exists for you).
 *   clearAppCache()       Clears cached public data (only needed after manual sheet edits).
 *
 * Security: because these functions do not end with "_", Apps Script technically
 * allows the browser to call them. assertEditor_() therefore refuses to run unless
 * the caller is the script owner (anonymous web visitors have no active user).
 */

function assertEditor_() {
  var active = '', effective = '';
  try { active = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  try { effective = Session.getEffectiveUser().getEmail() || ''; } catch (e) {}
  if (!active || !effective || active.toLowerCase() !== effective.toLowerCase()) {
    throw new Error('This function can only be run by the script owner from the Apps Script editor.');
  }
  return effective.toLowerCase();
}

function setup() {
  var ownerEmail = assertEditor_();
  var report = [];
  var ss = setupSpreadsheet_(report);

  withLock_(function () {
    SHEET_ORDER.forEach(function (name) { ensureSheet_(ss, name, report); });
    removeDefaultSheet_(ss, report);
    getPepper_();
    report.push('✓ Password pepper is stored in Script Properties');
    seedDefaultSettings_(report);
    seedDefaultPlatforms_(report);
  });

  var adminInfo = ensureInitialAdmin_(ownerEmail, report);
  invalidatePublicCache_();

  Logger.log('================ UniMAP Resources Hub — setup ================');
  report.forEach(function (line) { Logger.log(line); });
  if (adminInfo) {
    Logger.log('');
    Logger.log('FIRST ADMIN CREATED (role: owner)');
    Logger.log('  Email:              ' + adminInfo.email);
    Logger.log('  Temporary password: ' + adminInfo.password);
    Logger.log('  You will be asked to choose a new password at first login.');
    Logger.log('  This password is shown only once. Run recoverOwnerAccess() if you lose it.');
  }
  Logger.log('');
  Logger.log('Spreadsheet: ' + ss.getUrl());
  Logger.log('Next: run seedInitialData() (optional), then Deploy → New deployment → Web app.');
  return report;
}

function setupSpreadsheet_(report) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(APP.PROP_SPREADSHEET_ID);
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); report.push('✓ Using spreadsheet from Script Properties'); } catch (e) { ss = null; }
  }
  if (!ss) {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
    if (ss) report.push('✓ Using the spreadsheet this script is bound to: ' + ss.getName());
  }
  if (!ss) {
    ss = SpreadsheetApp.create('UniMAP Resources Hub — Database');
    report.push('✓ Created a new spreadsheet: ' + ss.getName());
  }
  props.setProperty(APP.PROP_SPREADSHEET_ID, ss.getId());
  DB_SS_ = ss;
  try { ss.setSpreadsheetTimeZone('Asia/Kuala_Lumpur'); } catch (e) {}
  return ss;
}

/** Creates a sheet with headers, or adds any missing columns to an existing one. */
function ensureSheet_(ss, name, report) {
  var schema = SCHEMA[name];
  var wanted = schema.columns.map(function (c) { return c[0]; });
  var sh = ss.getSheetByName(name);
  var created = false;
  if (!sh) {
    sh = ss.insertSheet(name);
    created = true;
  }
  var lastCol = sh.getLastColumn();
  var header = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  var hasHeader = header.some(function (h) { return h; });

  if (!hasHeader) {
    sh.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    header = wanted.slice();
  } else {
    var missing = wanted.filter(function (c) { return header.indexOf(c) === -1; });
    if (missing.length) {
      sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
      header = header.concat(missing);
      report.push('✓ ' + name + ': added missing column(s) ' + missing.join(', '));
    }
  }

  // Formatting: frozen bold header, and plain-text format so Sheets never
  // auto-converts intakes like "2020" or IDs/dates into numbers/dates.
  var width = header.length;
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#f1f5f4');
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, 1, rows, width).setNumberFormat('@');

  // TRUE/FALSE dropdowns for boolean columns (helps if the sheet is edited by hand).
  var boolRule = SpreadsheetApp.newDataValidation().requireValueInList(['TRUE', 'FALSE'], true).setAllowInvalid(false).build();
  schema.columns.forEach(function (c) {
    if (c[1] !== 'bool') return;
    var idx = header.indexOf(c[0]);
    if (idx !== -1) sh.getRange(2, idx + 1, rows, 1).setDataValidation(boolRule);
  });
  if (name === 'Submissions') {
    var stIdx = header.indexOf('status');
    if (stIdx !== -1) {
      sh.getRange(2, stIdx + 1, rows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(SUBMISSION_STATUSES_, true).setAllowInvalid(false).build());
    }
  }
  if (name === 'Admins') {
    var roleIdx = header.indexOf('role');
    if (roleIdx !== -1) {
      sh.getRange(2, roleIdx + 1, rows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(ROLES), true).setAllowInvalid(false).build());
    }
    sh.setTabColor('#b91c1c');
  }
  report.push((created ? '✓ Created sheet ' : '✓ Checked sheet ') + name);
  db_reset_();
  return sh;
}

function removeDefaultSheet_(ss, report) {
  ['Sheet1', 'Sheet 1', 'Feuille 1', 'Hoja 1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() === 0 && ss.getSheets().length > 1) {
      ss.deleteSheet(sh);
      report.push('✓ Removed empty default sheet "' + n + '"');
    }
  });
}

function seedDefaultSettings_(report) {
  var existing = {};
  db_rows_('Settings').forEach(function (r) { existing[r.key] = true; });
  var now = nowIso_();
  var rows = SETTINGS_DEF.filter(function (d) { return !existing[d.key]; }).map(function (d) {
    return { key: d.key, value: d.default, description: d.description, updated_at: now, updated_by: 'setup' };
  });
  if (rows.length) db_insertMany_('Settings', rows);
  report.push('✓ Settings: ' + rows.length + ' default value(s) added');
}

function seedDefaultPlatforms_(report) {
  if (db_rows_('Platforms').length) { report.push('✓ Platforms already exist'); return; }
  var now = nowIso_();
  db_insertMany_('Platforms', DEFAULT_PLATFORMS.map(function (name, i) {
    return { id: newId_(SCHEMA.Platforms.prefix), name: name, is_active: true, sort_order: (i + 1) * 10, created_at: now, updated_at: now };
  }));
  report.push('✓ Platforms: ' + DEFAULT_PLATFORMS.join(', '));
}

/** Creates the first owner if there are no admins yet. Returns { email, password } or null. */
function ensureInitialAdmin_(ownerEmail, report) {
  db_reset_();
  if (db_rows_('Admins').length) {
    report.push('✓ Admins already exist — no new admin created');
    return null;
  }
  var email = '';
  try { email = PropertiesService.getScriptProperties().getProperty(APP.PROP_INITIAL_ADMIN_EMAIL) || ''; } catch (e) {}
  email = validateEmail_(email || ownerEmail, 'email');
  var temp = tempPassword_();
  withLock_(function () {
    var now = nowIso_();
    db_insert_('Admins', {
      id: newId_(SCHEMA.Admins.prefix), name: 'Site Owner', email: email, role: 'owner', is_active: true,
      password_hash: hashPassword_(temp), must_change_password: true, password_changed_at: now,
      created_at: now, updated_at: now, last_login: '', created_by: 'setup'
    });
    logActivity_({ email: 'setup' }, 'admin.create', 'admin', '', 'Initial owner ' + email + ' created by setup()');
  });
  report.push('✓ Initial owner admin created for ' + email);
  return { email: email, password: temp };
}

/** Checks sheets, headers, settings, admins and properties. Used by validateSetup() and the dashboard. */
function validateStructure_() {
  var checks = [];
  var ok = true;
  function add(pass, msg) { checks.push({ ok: !!pass, message: msg }); if (!pass) ok = false; }

  var ss = null;
  try { ss = db_ss_(); add(true, 'Spreadsheet is reachable'); } catch (e) { add(false, 'Spreadsheet not found — run setup()'); }
  if (ss) {
    SHEET_ORDER.forEach(function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh) { add(false, 'Missing sheet: ' + name); return; }
      var lastCol = Math.max(1, sh.getLastColumn());
      var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
      var missing = SCHEMA[name].columns.map(function (c) { return c[0]; }).filter(function (c) { return header.indexOf(c) === -1; });
      add(!missing.length, name + (missing.length ? ': missing columns ' + missing.join(', ') : ': OK (' + Math.max(0, sh.getLastRow() - 1) + ' rows)'));
    });
    try {
      SHEET_ORDER.forEach(function (name) {
        if (name === 'ActivityLog') return;
        var t = db_table_(name);
        var seen = {}, dups = 0, blanks = 0;
        for (var r = 1; r < t.values.length; r++) {
          var k = String(t.values[r][t.colIndex[SCHEMA[name].key]] || '').trim();
          if (!k) { if (t.values[r].some(function (v) { return String(v).trim() !== ''; })) blanks++; continue; }
          if (seen[k]) dups++;
          seen[k] = 1;
        }
        if (dups) add(false, name + ': ' + dups + ' duplicate ID(s) — only the first row of each is used');
        if (blanks) add(false, name + ': ' + blanks + ' row(s) have data but no ID and are ignored');
      });
      var owners = db_rows_('Admins').filter(function (a) { return a.role === 'owner' && a.is_active; }).length;
      add(owners > 0, owners + ' active owner admin(s)');
      var platforms = db_rows_('Platforms').filter(function (p) { return p.is_active; }).length;
      add(platforms > 0, platforms + ' active platform(s)');
      var orphans = db_rows_('Resources').filter(function (r) { return r.programme_id && !db_get_('Programmes', r.programme_id); }).length;
      add(!orphans, orphans ? orphans + ' resource(s) point to a programme that no longer exists' : 'No orphaned resources');
    } catch (e) {
      add(false, 'Could not read data: ' + (e.userMessage || e.message));
    }
  }
  var pepper = null;
  try { pepper = PropertiesService.getScriptProperties().getProperty(APP.PROP_PEPPER); } catch (e) {}
  add(!!pepper, pepper ? 'Password pepper present' : 'Password pepper missing — run setup()');
  return { ok: ok, checks: checks, version: APP.VERSION };
}

function validateSetup() {
  assertEditor_();
  var result = validateStructure_();
  Logger.log('UniMAP Resources Hub — structure check: ' + (result.ok ? 'ALL GOOD' : 'PROBLEMS FOUND'));
  result.checks.forEach(function (c) { Logger.log((c.ok ? '  ✓ ' : '  ✗ ') + c.message); });
  return result;
}

function recoverOwnerAccess() {
  var email = assertEditor_();
  var temp = tempPassword_();
  var created = false;
  withLock_(function () {
    var admin = findAdminByEmail_(email);
    var now = nowIso_();
    if (admin) {
      db_update_('Admins', admin.id, {
        password_hash: hashPassword_(temp), must_change_password: true, password_changed_at: now,
        is_active: true, role: 'owner', updated_at: now
      });
    } else {
      created = true;
      db_insert_('Admins', {
        id: newId_(SCHEMA.Admins.prefix), name: 'Site Owner', email: email, role: 'owner', is_active: true,
        password_hash: hashPassword_(temp), must_change_password: true, password_changed_at: now,
        created_at: now, updated_at: now, last_login: '', created_by: 'recoverOwnerAccess'
      });
    }
    logActivity_({ email: email }, 'admin.recover', 'admin', '', 'Owner access recovered from the Apps Script editor');
  });
  cacheRemove_('lf:' + sha256Hex_(email).slice(0, 40));
  Logger.log((created ? 'Created owner admin ' : 'Reset password for ') + email);
  Logger.log('Temporary password: ' + temp);
  Logger.log('Sign in at ?p=admin — you will be asked to choose a new password.');
}

function clearAppCache() {
  assertEditor_();
  invalidatePublicCache_();
  Logger.log('Public cache cleared.');
}
