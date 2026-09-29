/**
 * Database.gs
 * Google Sheets data layer.
 *
 * Design goals
 *  - ONE getValues() call per sheet per request (results memoised per execution).
 *  - Columns are mapped by header name, so manual column re-ordering is safe.
 *  - Rows are identified by a stable ID column, never by row number.
 *  - All writes happen inside withLock_() so concurrent requests cannot corrupt data.
 *  - Every written string passes through sheetSafe_() (formula-injection protection).
 *  - Every change is recorded in a per-request "delta" that admin responses send
 *    back to the dashboard, so the browser can update without reloading everything.
 */

var DB_SS_ = null;      // Spreadsheet handle (per execution)
var DB_MEMO_ = {};      // name -> table snapshot (per execution)
var DB_DELTA_ = null;   // change collector for the current admin request
var DB_LOCK_DEPTH_ = 0; // re-entrancy guard for withLock_

var CONTENT_TABLES_ = { Programmes: 1, Resources: 1, Categories: 1, Platforms: 1, Settings: 1 };

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function db_ss_() {
  if (DB_SS_) return DB_SS_;
  var id = null;
  try { id = PropertiesService.getScriptProperties().getProperty(APP.PROP_SPREADSHEET_ID); } catch (e) {}
  try {
    DB_SS_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {
    DB_SS_ = null;
  }
  if (!DB_SS_) {
    throw appError_('DB_UNAVAILABLE', 'The database is not available yet. The site owner needs to run setup().');
  }
  return DB_SS_;
}

function db_sheet_(name) {
  var sh = db_ss_().getSheetByName(name);
  if (!sh) throw appError_('DB_UNAVAILABLE', 'The database is not set up correctly (missing sheet). Please contact the site owner.');
  return sh;
}

/** Clears per-execution snapshots so the next read is fresh. */
function db_reset_() {
  DB_MEMO_ = {};
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function db_coerce_(v, type) {
  switch (type) {
    case 'bool': return toBool_(v);
    case 'number': return toNum_(v, 0);
    case 'date':
      if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
      return v === null || v === undefined ? '' : String(v).trim();
    default:
      if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
      return sheetUnsafe_(v === null || v === undefined ? '' : String(v));
  }
}

function db_toCell_(v, type) {
  switch (type) {
    case 'bool': return v ? 'TRUE' : 'FALSE';
    case 'number': return toNum_(v, 0);
    default: return sheetSafe_(v === null || v === undefined ? '' : String(v));
  }
}

/** Loads a whole table with a single getValues() call and memoises it. */
function db_table_(name) {
  if (DB_MEMO_[name]) return DB_MEMO_[name];
  var schema = SCHEMA[name];
  if (!schema) throw new Error('Unknown table ' + name);
  var sh = db_sheet_(name);
  var values = sh.getDataRange().getValues();
  var header = (values[0] || []).map(function (h) { return String(h).trim(); });
  var colIndex = {};
  header.forEach(function (h, i) { if (h && colIndex[h] === undefined) colIndex[h] = i; });
  if (colIndex[schema.key] === undefined) {
    throw appError_('DB_UNAVAILABLE', 'The database is not set up correctly (missing columns). Please contact the site owner.');
  }

  var keyIdx = colIndex[schema.key];
  var rows = [], byKey = {}, rowNum = {}, raw = {};
  for (var r = 1; r < values.length; r++) {
    var line = values[r];
    var k = String(line[keyIdx] === null || line[keyIdx] === undefined ? '' : line[keyIdx]).trim();
    if (!k || byKey[k]) continue; // skip blank rows and accidental duplicate keys
    var obj = {};
    for (var c = 0; c < schema.columns.length; c++) {
      var col = schema.columns[c][0];
      var idx = colIndex[col];
      obj[col] = db_coerce_(idx === undefined ? '' : line[idx], schema.columns[c][1]);
    }
    obj[schema.key] = k;
    rows.push(obj);
    byKey[k] = obj;
    rowNum[k] = r + 1;
    raw[k] = line;
  }

  var t = {
    name: name, schema: schema, sheet: sh, header: header, colIndex: colIndex,
    values: values, rows: rows, byKey: byKey, rowNum: rowNum, raw: raw,
    lastRow: values.length
  };
  DB_MEMO_[name] = t;
  return t;
}

/** Returns all rows of a table (do not mutate the returned objects). */
function db_rows_(name) {
  return db_table_(name).rows;
}

function db_get_(name, key) {
  if (key === null || key === undefined || key === '') return null;
  return db_table_(name).byKey[String(key)] || null;
}

/**
 * Reads only the last `limit` rows of a table (used for the activity log so that
 * a large log never needs to be read in full).
 */
function db_tail_(name, limit) {
  var schema = SCHEMA[name];
  var sh = db_sheet_(name);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var start = Math.max(2, lastRow - limit + 1);
  var values = sh.getRange(start, 1, lastRow - start + 1, lastCol).getValues();
  var colIndex = {};
  header.forEach(function (h, i) { if (h && colIndex[h] === undefined) colIndex[h] = i; });
  var out = [];
  for (var r = values.length - 1; r >= 0; r--) {
    var obj = {};
    for (var c = 0; c < schema.columns.length; c++) {
      var col = schema.columns[c][0];
      var idx = colIndex[col];
      obj[col] = db_coerce_(idx === undefined ? '' : values[r][idx], schema.columns[c][1]);
    }
    if (obj[schema.key]) out.push(obj);
  }
  return out; // newest first
}

// ---------------------------------------------------------------------------
// Writing (call inside withLock_)
// ---------------------------------------------------------------------------

function db_buildRow_(t, obj, baseRaw) {
  var width = t.header.length;
  var row = baseRaw ? baseRaw.slice(0, width) : [];
  while (row.length < width) row.push('');
  var cols = t.schema.columns;
  for (var c = 0; c < cols.length; c++) {
    var idx = t.colIndex[cols[c][0]];
    if (idx === undefined) continue;
    row[idx] = db_toCell_(obj[cols[c][0]], cols[c][1]);
  }
  return row;
}

function db_normalise_(t, obj) {
  var out = {};
  var cols = t.schema.columns;
  for (var c = 0; c < cols.length; c++) {
    var v = obj[cols[c][0]];
    out[cols[c][0]] = (v === undefined) ? db_coerce_('', cols[c][1]) : v;
  }
  return out;
}

function db_insert_(name, obj) {
  return db_insertMany_(name, [obj])[0];
}

/** Inserts several rows with a single setValues() call. */
function db_insertMany_(name, objs) {
  if (!objs.length) return [];
  var t = db_table_(name);
  var key = t.schema.key;
  var rows = [], saved = [];
  objs.forEach(function (o) {
    var obj = db_normalise_(t, o);
    if (!obj[key]) throw new Error('Missing key for insert into ' + name);
    if (t.byKey[obj[key]]) throw appError_('CONFLICT', 'A record with the same ID already exists.');
    rows.push(db_buildRow_(t, obj, null));
    saved.push(obj);
  });
  t.sheet.getRange(t.lastRow + 1, 1, rows.length, t.header.length).setValues(rows);
  saved.forEach(function (obj, i) {
    t.lastRow += 1;
    t.rows.push(obj);
    t.byKey[obj[key]] = obj;
    t.rowNum[obj[key]] = t.lastRow;
    t.raw[obj[key]] = rows[i];
    t.values.push(rows[i]);
    delta_upsert_(name, obj);
  });
  return saved;
}

/** Updates one row (a single setValues() call). Returns the updated object. */
function db_update_(name, keyValue, patch) {
  var t = db_table_(name);
  var existing = t.byKey[keyValue];
  if (!existing) throw appError_('NOT_FOUND', 'The record no longer exists. Please refresh.');
  var merged = {};
  Object.keys(existing).forEach(function (k) { merged[k] = existing[k]; });
  Object.keys(patch).forEach(function (k) { if (k !== t.schema.key) merged[k] = patch[k]; });
  var row = db_buildRow_(t, merged, t.raw[keyValue]);
  t.sheet.getRange(t.rowNum[keyValue], 1, 1, t.header.length).setValues([row]);
  t.raw[keyValue] = row;
  t.values[t.rowNum[keyValue] - 1] = row;
  var i = t.rows.indexOf(existing);
  if (i !== -1) t.rows[i] = merged;
  t.byKey[keyValue] = merged;
  delta_upsert_(name, merged);
  return merged;
}

/**
 * Deletes rows by key. Rows are deleted bottom-up so row numbers stay valid.
 * The table snapshot is dropped afterwards (row numbers shift).
 */
function db_delete_(name, keys) {
  if (!Array.isArray(keys)) keys = [keys];
  var t = db_table_(name);
  var nums = [];
  keys.forEach(function (k) {
    if (!t.rowNum[k]) throw appError_('NOT_FOUND', 'The record no longer exists. Please refresh.');
    nums.push(t.rowNum[k]);
  });
  nums.sort(function (a, b) { return b - a; });
  // Group consecutive rows so each block is removed with one call.
  var i = 0;
  while (i < nums.length) {
    var end = nums[i], start = end, j = i + 1;
    while (j < nums.length && nums[j] === start - 1) { start = nums[j]; j++; }
    t.sheet.deleteRows(start, end - start + 1);
    i = j;
  }
  keys.forEach(function (k) { delta_remove_(name, k); });
  delete DB_MEMO_[name];
}

/**
 * Writes new values for ONE column across many rows with a single setValues().
 * changes: { key: newValue }
 */
function db_updateColumn_(name, column, changes) {
  var t = db_table_(name);
  var idx = t.colIndex[column];
  if (idx === undefined) throw new Error('Missing column ' + column + ' in ' + name);
  var type = null;
  t.schema.columns.forEach(function (c) { if (c[0] === column) type = c[1]; });
  var keyIdx = t.colIndex[t.schema.key];
  var n = t.values.length - 1;
  if (n < 1) return;
  var colValues = [];
  for (var r = 1; r <= n; r++) {
    var line = t.values[r];
    var k = String(line[keyIdx] === null || line[keyIdx] === undefined ? '' : line[keyIdx]).trim();
    var isOwner = k && t.rowNum[k] === r + 1;
    if (isOwner && Object.prototype.hasOwnProperty.call(changes, k)) line[idx] = db_toCell_(changes[k], type);
    colValues.push([line[idx] === undefined ? '' : line[idx]]);
  }
  t.sheet.getRange(2, idx + 1, n, 1).setValues(colValues);
  Object.keys(changes).forEach(function (k) {
    var obj = t.byKey[k];
    if (!obj) return;
    var merged = {};
    Object.keys(obj).forEach(function (f) { merged[f] = obj[f]; });
    merged[column] = changes[k];
    var pos = t.rows.indexOf(obj);
    if (pos !== -1) t.rows[pos] = merged;
    t.byKey[k] = merged;
    delta_upsert_(name, merged);
  });
}

/**
 * Serialises write operations. Acquires the script lock, clears stale
 * snapshots so reads inside fn() are fresh, and flushes before releasing.
 */
function withLock_(fn) {
  if (DB_LOCK_DEPTH_ > 0) return fn();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw appError_('BUSY', 'The server is busy right now. Please try again in a moment.');
  }
  DB_LOCK_DEPTH_++;
  try {
    db_reset_();
    return fn();
  } finally {
    DB_LOCK_DEPTH_--;
    try { SpreadsheetApp.flush(); } catch (e) {}
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Delta tracking
// ---------------------------------------------------------------------------

function delta_begin_() {
  DB_DELTA_ = { upsert: {}, remove: {} };
}

function delta_upsert_(name, obj) {
  if (!DB_DELTA_) return;
  var key = SCHEMA[name].key;
  var list = DB_DELTA_.upsert[name] || (DB_DELTA_.upsert[name] = []);
  for (var i = 0; i < list.length; i++) {
    if (list[i][key] === obj[key]) { list[i] = obj; return; }
  }
  list.push(obj);
}

function delta_remove_(name, key) {
  if (!DB_DELTA_) return;
  (DB_DELTA_.remove[name] || (DB_DELTA_.remove[name] = [])).push(key);
  var list = DB_DELTA_.upsert[name];
  if (list) {
    var k = SCHEMA[name].key;
    DB_DELTA_.upsert[name] = list.filter(function (o) { return o[k] !== key; });
  }
}

function delta_touchesContent_() {
  if (!DB_DELTA_) return false;
  var names = Object.keys(DB_DELTA_.upsert).concat(Object.keys(DB_DELTA_.remove));
  for (var i = 0; i < names.length; i++) if (CONTENT_TABLES_[names[i]]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Activity log (append-only; never reads the whole log)
// ---------------------------------------------------------------------------

var DB_LOG_HEADER_ = null;

function logActivity_(admin, action, entityType, entityId, details) {
  try {
    var sh = db_sheet_('ActivityLog');
    if (!DB_LOG_HEADER_) {
      DB_LOG_HEADER_ = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0]
        .map(function (h) { return String(h).trim(); });
    }
    var entry = {
      id: newId_('log'),
      timestamp: nowIso_(),
      admin_email: admin ? admin.email : 'public',
      action: action,
      entity_type: entityType || '',
      entity_id: entityId || '',
      details: String(details || '').slice(0, 1000)
    };
    var row = DB_LOG_HEADER_.map(function (h) {
      return Object.prototype.hasOwnProperty.call(entry, h) ? sheetSafe_(String(entry[h])) : '';
    });
    sh.appendRow(row);
    delta_upsert_('ActivityLog', entry);
    return entry;
  } catch (e) {
    // Logging must never break the main operation.
    try { console.error('Activity log failed: ' + e); } catch (ignore) {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public cache
// ---------------------------------------------------------------------------

function invalidatePublicCache_() {
  cacheRemove_(APP.CACHE_PUBLIC);
  cacheRemove_('settings_v1');
}
