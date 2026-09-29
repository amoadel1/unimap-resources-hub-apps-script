/**
 * Utils.gs
 * Shared helpers: errors, responses, validation, sanitisation, URLs, hashing, caching.
 */

// ---------------------------------------------------------------------------
// Errors & responses
// ---------------------------------------------------------------------------

/**
 * Creates an application error that is SAFE to show to the user.
 * Anything that is not an app error is reported to the browser as a generic
 * SERVER_ERROR so internal details (stack traces, sheet names, IDs) never leak.
 */
function appError_(code, message, field, params) {
  var e = new Error(message || code);
  e.appCode = code;
  e.userMessage = message || code;
  e.field = field || null;
  e.params = params || null;
  return e;
}

function errorResponse_(e) {
  if (e && e.appCode) {
    return { ok: false, error: { code: e.appCode, message: e.userMessage, field: e.field, params: e.params } };
  }
  try { console.error('Unexpected error: ' + (e && e.stack ? e.stack : e)); } catch (ignore) {}
  return { ok: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on the server. Please try again.' } };
}

/** Runs fn and wraps the result in { ok, data } / { ok:false, error }. */
function respond_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    return errorResponse_(e);
  }
}

// ---------------------------------------------------------------------------
// Time & IDs
// ---------------------------------------------------------------------------

function nowIso_() {
  return new Date().toISOString();
}

/** Stable, random, non-sequential ID, e.g. "res_4f1c2a9be0d34c51a7b2". */
function newId_(prefix) {
  var hex = Utilities.getUuid().replace(/-/g, '').slice(0, 20).toLowerCase();
  return prefix ? prefix + '_' + hex : hex;
}

/** 64 hex chars of randomness for session tokens. */
function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Type coercion
// ---------------------------------------------------------------------------

function toBool_(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v === null || v === undefined) return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on';
}

function toNum_(v, fallback) {
  if (typeof v === 'number' && isFinite(v)) return v;
  var n = parseFloat(String(v === null || v === undefined ? '' : v).trim());
  return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

function isPlainObject_(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Text sanitisation
// ---------------------------------------------------------------------------

// Control characters (except tab/newline handled separately) and bidi override
// characters that can be abused to visually spoof text. LRM/RLM (U+200E/F) and
// ZWJ/ZWNJ are kept because Arabic text can legitimately use them.
var CONTROL_RE_ = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩﻿]/g;

/** Single-line text: normalised, control chars removed, whitespace collapsed. */
function cleanLine_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s.normalize) s = s.normalize('NFC');
  return s.replace(CONTROL_RE_, '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Multi-line text: keeps line breaks (max 2 in a row), removes control chars. */
function cleanText_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  if (s.normalize) s = s.normalize('NFC');
  s = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(CONTROL_RE_, '');
  s = s.split('\n').map(function (line) { return line.replace(/ {2,}/g, ' ').trim(); }).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Validates and cleans one field.
 * opts: { label, required, min, max, multiline }
 */
function field_(value, name, opts) {
  opts = opts || {};
  var label = opts.label || name;
  var s = opts.multiline ? cleanText_(value) : cleanLine_(value);
  if (!s) {
    if (opts.required) throw appError_('REQUIRED', label + ' is required.', name);
    return '';
  }
  if (opts.min && s.length < opts.min) {
    throw appError_('TOO_SHORT', label + ' must be at least ' + opts.min + ' characters.', name, { min: opts.min });
  }
  if (opts.max && s.length > opts.max) {
    throw appError_('TOO_LONG', label + ' must be at most ' + opts.max + ' characters.', name, { max: opts.max });
  }
  return s;
}

function validateEmail_(v, name) {
  var s = cleanLine_(v).toLowerCase();
  if (!s) throw appError_('REQUIRED', 'Email is required.', name || 'email');
  if (s.length > 160 || !/^[^\s@<>()"',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) {
    throw appError_('INVALID_EMAIL', 'Please enter a valid email address.', name || 'email');
  }
  return s;
}

/**
 * Google Sheets formula-injection protection.
 * Any string beginning with = + - @ (or tab / CR) would be interpreted by
 * Sheets as a formula. Prefixing a single quote forces Sheets to store it as text.
 */
function sheetSafe_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

/** Reverses sheetSafe_ if the apostrophe was stored literally. */
function sheetUnsafe_(v) {
  if (typeof v !== 'string') return v;
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}

function slugify_(s) {
  var out = String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '');
  return out;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Strict URL validation for user-supplied resource links.
 * Accepts only absolute http(s) URLs with a public-looking host name.
 * Rejects javascript:, data:, file:, credentials in URLs, IP-address hosts,
 * localhost / internal names, whitespace, control characters and quotes.
 *
 * Returns { url, key } where key is a normalised form used for duplicate detection.
 */
function validateUrl_(raw, opts) {
  opts = opts || {};
  var fieldName = opts.field || 'url';
  var s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) throw appError_('REQUIRED', 'A link is required.', fieldName);
  if (s.length > 2048) throw appError_('INVALID_URL', 'The link is too long.', fieldName);
  if (/[\s\u0000-\u001F\u007F<>"'`\\{}|^]/.test(s)) {
    throw appError_('INVALID_URL', 'The link contains characters that are not allowed.', fieldName);
  }

  var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^\/?#]*)([\/?#][^]*)?$/.exec(s);
  if (!m) throw appError_('INVALID_URL', 'Please enter a full link starting with https://', fieldName);

  var scheme = m[1].toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') {
    throw appError_('INVALID_URL', 'Only http:// and https:// links are allowed.', fieldName);
  }
  if (opts.requireHttps && scheme !== 'https') {
    throw appError_('URL_HTTPS_REQUIRED', 'Only secure https:// links are accepted.', fieldName);
  }

  var authority = m[2];
  if (!authority || authority.indexOf('@') !== -1) {
    throw appError_('INVALID_URL', 'Links containing usernames or passwords are not allowed.', fieldName);
  }

  var hp = /^([^:\[\]]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!hp) throw appError_('INVALID_URL', 'The link has an invalid web address.', fieldName);

  var host = hp[1].toLowerCase().replace(/\.$/, '');
  var port = hp[2] ? parseInt(hp[2], 10) : null;
  if (port !== null && (port < 1 || port > 65535)) {
    throw appError_('INVALID_URL', 'The link has an invalid port.', fieldName);
  }
  if (!/^[a-z0-9¡-￿.-]+$/.test(host) || host.indexOf('.') === -1 ||
      /(^[.-])|([.-]$)|\.\.|\.-|-\./.test(host)) {
    throw appError_('INVALID_URL', 'The link has an invalid web address.', fieldName);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw appError_('INVALID_URL', 'Links to IP addresses are not allowed.', fieldName);
  }
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) {
    throw appError_('INVALID_URL', 'Links to local or internal addresses are not allowed.', fieldName);
  }
  var tld = host.split('.').pop();
  if (!/^([a-z¡-￿]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) {
    throw appError_('INVALID_URL', 'The link has an invalid web address.', fieldName);
  }

  var rest = m[3] || '';
  var url = scheme + '://' + host + (port ? ':' + port : '') + rest;
  return { url: url, key: urlKey_(url) };
}

/**
 * Normalised key for duplicate detection. Two links that open the same
 * resource should produce the same key, e.g.
 *   https://drive.google.com/drive/u/0/folders/ABC?usp=sharing
 *   https://drive.google.com/drive/folders/ABC
 * Fragments are KEPT because different official pages differ only by #anchor.
 */
function urlKey_(url) {
  var m = /^https?:\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(String(url || '').trim());
  if (!m) return String(url || '').trim().toLowerCase();
  var host = m[1].toLowerCase().replace(/^www\./, '').replace(/:(80|443)$/, '');
  var path = m[2] || '';
  var query = m[3] ? m[3].slice(1) : '';
  var frag = m[4] || '';

  // Google Drive / Docs IDs identify the resource regardless of URL shape.
  if (host === 'drive.google.com') {
    var d = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(path) || /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(path);
    if (d) return 'gdrive:' + d[1];
    var q = /(?:^|&)id=([A-Za-z0-9_-]{10,})/.exec(query);
    if (q) return 'gdrive:' + q[1];
  }
  if (host === 'docs.google.com') {
    var g = /\/(document|spreadsheets|presentation|forms|drawings)\/d\/(?:e\/)?([A-Za-z0-9_-]{10,})/.exec(path);
    if (g) return 'gdocs:' + g[2];
  }

  path = path.replace(/\/+$/, '');
  var params = query ? query.split('&').filter(function (p) {
    if (!p) return false;
    var k = p.split('=')[0].toLowerCase();
    return !(k === 'usp' || k === 'fbclid' || k === 'gclid' || k === 'ref' || k.indexOf('utm_') === 0);
  }).sort() : [];
  return host + path + (params.length ? '?' + params.join('&') : '') + frag;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function bytesToHex_(bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out.push((b < 16 ? '0' : '') + b.toString(16));
  }
  return out.join('');
}

function sha256Hex_(s) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

/** Constant-time string comparison (prevents timing attacks on hashes). */
function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  var diff = a.length ^ b.length;
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// CacheService helpers (JSON values, chunked to respect the 100 KB limit)
// ---------------------------------------------------------------------------

var CACHE_CHUNK_ = 90000;

function cacheGetJson_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var head = cache.get(key);
    if (!head) return null;
    var meta = JSON.parse(head);
    if (!meta || !meta.n) return null;
    var keys = [];
    for (var i = 0; i < meta.n; i++) keys.push(key + ':' + i);
    var parts = cache.getAll(keys);
    var buf = '';
    for (var j = 0; j < keys.length; j++) {
      if (parts[keys[j]] === undefined || parts[keys[j]] === null) return null;
      buf += parts[keys[j]];
    }
    return JSON.parse(buf);
  } catch (e) {
    return null;
  }
}

function cachePutJson_(key, obj, ttl) {
  try {
    var cache = CacheService.getScriptCache();
    var s = JSON.stringify(obj);
    var map = {};
    var n = Math.ceil(s.length / CACHE_CHUNK_) || 1;
    for (var i = 0; i < n; i++) map[key + ':' + i] = s.substr(i * CACHE_CHUNK_, CACHE_CHUNK_);
    cache.putAll(map, ttl);
    cache.put(key, JSON.stringify({ n: n }), ttl);
  } catch (e) {
    // Caching is an optimisation; failure must never break the request.
  }
}

function cacheRemove_(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) {}
}

/**
 * Fixed-window counter in CacheService. Returns the count AFTER incrementing.
 * Not perfectly atomic (CacheService has no increment), so callers that need
 * accuracy should hold the script lock.
 */
function cacheIncr_(key, ttlSeconds) {
  var cache = CacheService.getScriptCache();
  var n = parseInt(cache.get(key) || '0', 10) + 1;
  cache.put(key, String(n), ttlSeconds);
  return n;
}

function cacheCount_(key) {
  return parseInt(CacheService.getScriptCache().get(key) || '0', 10);
}
