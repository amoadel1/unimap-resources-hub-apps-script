/**
 * Auth.gs
 * Server-side admin authentication, sessions and role checks.
 *
 * Why not "Sign in with Google"?
 *   The public web app must run as the owner ("Execute as: Me") with access
 *   "Anyone" so anonymous students can use it. In that mode Apps Script does NOT
 *   reveal the visitor's Google account for personal (gmail.com) accounts —
 *   Session.getActiveUser() returns an empty string — so it cannot identify admins.
 *   Therefore the hub uses its own email + password login, verified on the server.
 *
 * How it works
 *   - Passwords: salted, iterated HMAC-SHA256 with a secret "pepper" that lives only in
 *     Script Properties (never in the spreadsheet or the browser). A copy of the Admins
 *     sheet alone is not enough to test password guesses offline.
 *   - Sessions: a random 256-bit token is returned to the browser after login. The server
 *     stores only SHA-256(token) in CacheService with an idle timeout and an absolute
 *     lifetime. The token lives in the tab's sessionStorage and is sent with each call.
 *   - Every admin call re-loads the admin row from the Admins sheet, so deactivating an
 *     admin, changing their role or resetting their password takes effect immediately.
 *   - Failed logins are throttled per email (lockout) and slowed down globally.
 */

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

function getPepper_() {
  var props = PropertiesService.getScriptProperties();
  var pepper = props.getProperty(APP.PROP_PEPPER);
  if (!pepper) {
    pepper = newToken_() + newToken_();
    props.setProperty(APP.PROP_PEPPER, pepper);
  }
  return pepper;
}

function strBytes_(s) {
  return Utilities.newBlob(String(s)).getBytes();
}

function derive_(password, salt, iterations) {
  var key = strBytes_(getPepper_());
  var saltBytes = strBytes_(salt);
  var h = Utilities.computeHmacSha256Signature(strBytes_(salt + ':' + password), key);
  for (var i = 1; i < iterations; i++) {
    h = Utilities.computeHmacSha256Signature(h.concat(saltBytes), key);
  }
  return bytesToHex_(h);
}

function hashPassword_(password) {
  var salt = newToken_().slice(0, 32);
  var iterations = APP.HASH_ITERATIONS;
  return 'v1$' + iterations + '$' + salt + '$' + derive_(password, salt, iterations);
}

function verifyPassword_(password, stored) {
  var parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    // Run a dummy derivation so timing does not reveal "no such account".
    derive_(password, 'dummysaltdummysaltdummysalt00000', APP.HASH_ITERATIONS);
    return false;
  }
  var iterations = parseInt(parts[1], 10);
  if (!(iterations > 0 && iterations < 100000)) return false;
  return safeEqual_(derive_(password, parts[2], iterations), parts[3]);
}

/** Password policy: 10–128 chars, at least one letter and one digit. */
function validateNewPassword_(pw, email) {
  pw = String(pw === null || pw === undefined ? '' : pw);
  if (pw.length < 10) throw appError_('WEAK_PASSWORD', 'Password must be at least 10 characters.', 'new_password');
  if (pw.length > 128) throw appError_('WEAK_PASSWORD', 'Password must be at most 128 characters.', 'new_password');
  if (!/[A-Za-z؀-ۿ]/.test(pw) || !/[0-9]/.test(pw)) {
    throw appError_('WEAK_PASSWORD', 'Password must contain letters and numbers.', 'new_password');
  }
  if (email && pw.toLowerCase().indexOf(String(email).toLowerCase().split('@')[0]) !== -1 &&
      String(email).split('@')[0].length >= 4) {
    throw appError_('WEAK_PASSWORD', 'Password must not contain your email name.', 'new_password');
  }
  return pw;
}

/** Readable random temporary password, e.g. "Kp7m-Qx2r-Vd9s-Hb4n". */
function tempPassword_() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  var digits = '23456789';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  var groups = [];
  for (var g = 0; g < 4; g++) {
    var s = '';
    for (var i = 0; i < 4; i++) {
      var b = bytes[g * 4 + i];
      b = b < 0 ? b + 256 : b;
      s += (i === 2) ? digits.charAt(b % digits.length) : alphabet.charAt(b % alphabet.length);
    }
    groups.push(s);
  }
  return groups.join('-');
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function roleAtLeast_(admin, role) {
  return !!admin && (ROLES[admin.role] || 0) >= (ROLES[role] || 99);
}

function requireRole_(admin, role) {
  if (!roleAtLeast_(admin, role)) {
    throw appError_('FORBIDDEN', 'You do not have permission to do this.');
  }
}

function findAdminByEmail_(email) {
  email = String(email || '').toLowerCase();
  var rows = db_rows_('Admins');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email).toLowerCase() === email) return rows[i];
  }
  return null;
}

/** Admin record without secrets — the only shape ever sent to the browser. */
function publicAdmin_(a) {
  if (!a) return null;
  return {
    id: a.id, name: a.name, email: a.email, role: a.role, is_active: a.is_active,
    must_change_password: a.must_change_password, created_at: a.created_at,
    updated_at: a.updated_at, last_login: a.last_login, created_by: a.created_by
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sessionKey_(token) {
  return 'sess:' + sha256Hex_(token);
}

function sessionIdleSeconds_() {
  var minutes = toNum_(settingsMap_().session_idle_minutes, 120);
  minutes = Math.max(10, Math.min(360, minutes));
  return Math.floor(minutes * 60);
}

function createSession_(admin) {
  var token = newToken_();
  var now = Date.now();
  var data = { aid: admin.id, cat: now, lat: now };
  CacheService.getScriptCache().put(sessionKey_(token), JSON.stringify(data), sessionIdleSeconds_());
  return token;
}

/**
 * Validates the token and returns the CURRENT admin row from the sheet.
 * Throws AUTH_REQUIRED if the session is missing, expired or revoked.
 */
function requireSession_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw appError_('AUTH_REQUIRED', 'Please sign in.');
  }
  var cache = CacheService.getScriptCache();
  var key = sessionKey_(token);
  var raw = cache.get(key);
  if (!raw) throw appError_('AUTH_REQUIRED', 'Your session has expired. Please sign in again.');
  var s;
  try { s = JSON.parse(raw); } catch (e) { s = null; }
  var now = Date.now();
  if (!s || !s.aid || now - s.cat > APP.SESSION_ABSOLUTE_HOURS * 3600 * 1000) {
    cache.remove(key);
    throw appError_('AUTH_REQUIRED', 'Your session has expired. Please sign in again.');
  }
  var admin = db_get_('Admins', s.aid);
  if (!admin || !admin.is_active || !ROLES[admin.role]) {
    cache.remove(key);
    throw appError_('AUTH_REQUIRED', 'Your account is not active. Please contact the site owner.');
  }
  if (admin.password_changed_at && new Date(admin.password_changed_at).getTime() > s.cat) {
    cache.remove(key);
    throw appError_('AUTH_REQUIRED', 'Your password was changed. Please sign in again.');
  }
  // Sliding idle expiry: refresh at most once a minute to save cache writes.
  if (now - s.lat > 60000) {
    s.lat = now;
    cache.put(key, JSON.stringify(s), sessionIdleSeconds_());
  }
  return admin;
}

// ---------------------------------------------------------------------------
// Login / logout (browser entry points live in Code.gs)
// ---------------------------------------------------------------------------

function login_(email, password) {
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 256) {
    throw appError_('INVALID_LOGIN', 'Incorrect email or password.');
  }
  email = cleanLine_(email).toLowerCase();
  var failKey = 'lf:' + sha256Hex_(email).slice(0, 40);
  var globalKey = 'lf:global';

  if (cacheCount_(failKey) >= APP.LOGIN_MAX_FAILS) {
    throw appError_('LOGIN_LOCKED', 'Too many failed attempts. Please wait ' + APP.LOGIN_LOCK_MINUTES + ' minutes and try again.');
  }
  if (cacheCount_(globalKey) >= APP.LOGIN_GLOBAL_MAX_FAILS) {
    Utilities.sleep(1500); // slow down large-scale guessing without locking everyone out
  }

  var admin = findAdminByEmail_(email);
  var ok = verifyPassword_(password, admin ? admin.password_hash : '');
  if (!admin || !ok || !admin.is_active || !ROLES[admin.role]) {
    cacheIncr_(failKey, APP.LOGIN_LOCK_MINUTES * 60);
    cacheIncr_(globalKey, APP.LOGIN_LOCK_MINUTES * 60);
    Utilities.sleep(400);
    throw appError_('INVALID_LOGIN', 'Incorrect email or password.');
  }

  cacheRemove_(failKey);
  var token = createSession_(admin);
  var updated = withLock_(function () {
    var a = db_update_('Admins', admin.id, { last_login: nowIso_() });
    logActivity_(a, 'auth.login', 'admin', a.id, 'Signed in');
    return a;
  });
  return { token: token, admin: publicAdmin_(updated), idle_minutes: Math.round(sessionIdleSeconds_() / 60) };
}

function logout_(token) {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
    CacheService.getScriptCache().remove(sessionKey_(token));
  }
  return true;
}

function changeOwnPassword_(admin, payload) {
  var current = String(payload.current_password || '');
  if (!verifyPassword_(current, admin.password_hash)) {
    throw appError_('INVALID_PASSWORD', 'Your current password is incorrect.', 'current_password');
  }
  var next = validateNewPassword_(payload.new_password, admin.email);
  if (next === current) throw appError_('WEAK_PASSWORD', 'The new password must be different.', 'new_password');
  var hash = hashPassword_(next);
  return withLock_(function () {
    // Changing the password revokes every existing session (other devices too);
    // a fresh token is issued for the current browser.
    var a = db_update_('Admins', admin.id, {
      password_hash: hash,
      must_change_password: false,
      password_changed_at: nowIso_(),
      updated_at: nowIso_()
    });
    logActivity_(a, 'auth.password_change', 'admin', a.id, 'Changed own password');
    return { admin: publicAdmin_(a), token: createSession_(a) };
  });
}
