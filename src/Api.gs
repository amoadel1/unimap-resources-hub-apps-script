/**
 * Api.gs
 * HTTP/JSON API used by the Cloudflare frontend (server-to-server only).
 *
 * This file is ADDITIVE: doGet(), the HTML Service website and google.script.run
 * keep working exactly as before. doPost() simply exposes the SAME public/auth/admin
 * functions over HTTP so a Cloudflare Worker can call them.
 *
 * Request (POST body, JSON):
 *   { "secret": "<PROXY_SHARED_SECRET>", "action": "<allow-listed action>",
 *     "payload": { ... }, "client": { "ip_hash": "<hex>" } }
 *
 * Allow-listed actions:
 *   public.data     → publicBundle_()                    (same data as the public page)
 *   public.submit   → submitResource(payload.form)
 *   auth.login      → adminLogin(payload.email, payload.password)
 *   auth.logout     → adminLogout(payload.token)
 *   admin           → adminApi(payload.token, payload.action, payload.payload)
 *   analytics.ingest → analyticsIngest_(payload)  (anonymous, pre-aggregated counters; see Analytics.gs)
 *                     (adminApi keeps its own session + role + action allow-list checks)
 *
 * Security:
 *   - Disabled until the Script Property PROXY_SHARED_SECRET (≥ 32 chars) is set.
 *   - The secret is compared in constant time; it is known only to the Worker.
 *     Apps Script cannot read request headers, so it travels in the (TLS-encrypted) body.
 *   - The client IP never reaches Apps Script; the Worker sends an HMAC hash of it,
 *     used only as a rate-limit key.
 *   - Responses are JSON produced by the existing respond_/errorResponse_ helpers,
 *     so internal errors are never leaked.
 */

var API_CLIENT_ = null; // { ipHash } for the current API request (null for google.script.run)
var API_MAX_BODY_ = 64 * 1024;

function doPost(e) {
  var out;
  try {
    out = apiHandle_(e);
  } catch (err) {
    out = errorResponse_(err);
  } finally {
    API_CLIENT_ = null;
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function apiHandle_(e) {
  var secret = '';
  try { secret = PropertiesService.getScriptProperties().getProperty(APP.PROP_PROXY_SECRET) || ''; } catch (err) {}
  if (secret.length < 32) {
    return { ok: false, error: { code: 'API_DISABLED', message: 'The API is not enabled.' } };
  }

  var raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  if (!raw || raw.length > API_MAX_BODY_) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request.' } };
  }
  var body;
  try { body = JSON.parse(raw); } catch (err) { body = null; }
  if (!isPlainObject_(body)) return { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid request.' } };

  if (typeof body.secret !== 'string' || !safeEqual_(body.secret, secret)) {
    Utilities.sleep(250);
    return { ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden.' } };
  }

  var client = isPlainObject_(body.client) ? body.client : {};
  var ipHash = typeof client.ip_hash === 'string' && /^[a-f0-9]{16,64}$/.test(client.ip_hash) ? client.ip_hash : '';
  API_CLIENT_ = { ipHash: ipHash };

  var p = isPlainObject_(body.payload) ? body.payload : {};
  switch (body.action) {
    case 'public.data':
      return respond_(publicBundle_);
    case 'public.submit':
      return submitResource(p.form);
    case 'auth.login':
      return p.bootstrap === true ? apiLoginWithBootstrap_(p.email, p.password) : adminLogin(p.email, p.password);
    case 'auth.logout':
      return adminLogout(p.token);
    case 'admin':
      return adminApi(p.token, p.action, p.payload);
    case 'health':
      return { ok: true, data: { version: APP.VERSION } };
    case 'analytics.ingest':
      return respond_(function () { return analyticsIngest_(p); });
    default:
      return { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown action.' } };
  }
}

/**
 * Login + dashboard data in ONE execution (saves a whole Apps Script round trip, ~3–5 s).
 * The bootstrap goes through the normal adminDispatch_ path, so the same session,
 * role and must-change-password checks apply. If it fails, the login result is still
 * returned and the browser simply loads the dashboard with a second call as before.
 */
function apiLoginWithBootstrap_(email, password) {
  var res = adminLogin(email, password);
  if (!res.ok || !res.data || !res.data.token || !res.data.admin || res.data.admin.must_change_password) return res;
  var boot = adminDispatch_(res.data.token, 'bootstrap', {});
  if (boot && boot.ok) res.data.bootstrap = boot.data;
  return res;
}

/** Hashed client IP of the current API request, or '' (HTML Service requests have none). */
function apiClientIpHash_() {
  return API_CLIENT_ && API_CLIENT_.ipHash ? API_CLIENT_.ipHash : '';
}
