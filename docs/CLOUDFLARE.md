# Cloudflare frontend (v2.1)

> UniMAP Resources Hub is an independent student-built platform and is not an official UniMAP system.

## Why this exists

Google documents that *"Multi-login, or being logged into multiple Google Accounts at once, isn't supported for Apps Script, add-ons, or web apps"* ([Apps Script troubleshooting](https://developers.google.com/apps-script/guides/support/troubleshooting)).

Students who are signed in to several Google accounts can be sent to `/macros/u/N/s/…/exec`, which ends in a Google Drive "Page not found". Incognito works, but students shouldn't have to use it.

The fix is to move only the user-facing frontend to Cloudflare. The browser then never loads anything from Google. Apps Script + Google Sheets stay the backend and the database, unchanged.

## Architecture

```
Student's browser
   │  same-origin requests only (no CORS, no Google cookies involved)
   ▼
Cloudflare Worker  "unimap-resources-hub"  (https://unimap-resources-hub.<subdomain>.workers.dev)
   ├─ static assets (dist/): index.html, admin.html, CSS/JS          ← free & unlimited requests
   └─ /api/*  (src/worker.js)                                        ← counts toward 100k/day
         • fixed routes only, Origin/CSRF checks, size limits
         • admin session in an HttpOnly cookie
         • hashed client IP for rate limiting
         │  server-to-server POST with a shared secret
         ▼
Google Apps Script — separate "API" deployment of the SAME project → doPost() (src/Api.gs)
         │  same functions as before: publicBundle_, submitResource, adminLogin, adminLogout, adminApi
         ▼
Google Sheets "UniMAP Resources Hub Database" (unchanged)
```

The **existing production `/exec` deployment is not touched**. It stays pinned to its current version and keeps serving the old HTML site as the emergency fallback.

### API routes (Worker)

| Route | Purpose | Backend action |
|---|---|---|
| `GET /api/public` | Programmes, resources, collections, platforms, public settings | `public.data` |
| `POST /api/submit` | Student submission `{form}` | `public.submit` |
| `POST /api/admin/login` | `{email, password}`. Sets the session cookie; the token is never returned. | `auth.login` |
| `POST /api/admin/logout` | Revokes the session and clears the cookie | `auth.logout` |
| `POST /api/admin/call` | `{action, payload}`. `action` must be one of 32 allow-listed dashboard actions. | `admin` → `adminApi` |
| `GET /api/health` | Checks that the Worker can reach Apps Script | `health` |

Anything else under `/api/` returns 404; a wrong HTTP method returns 405. The Worker never fetches a URL taken from the request.

### How a request reaches Google

Google documents that Content Service responses are redirected to a one-time URL on `script.googleusercontent.com`, and that clients must follow that redirect ([Content Service](https://developers.google.com/apps-script/guides/content)). The Worker handles it like this:

1. It POSTs to the API deployment's `/exec` URL with `redirect: 'manual'`.
2. It follows the `Location` header with a GET, **only if the host is `script.googleusercontent.com`**. At most 3 hops are allowed.
3. It accepts only a JSON body of the form `{ ok: boolean, … }`.

This is also why the browser can't call Apps Script directly: the cross-origin redirect would break CORS.

### Sessions (changed from the Apps Script site)

| | Old Apps Script site | Cloudflare site |
|---|---|---|
| Where the token lives | `sessionStorage` (readable by page JavaScript) | `__Host-urh_admin` cookie: `HttpOnly; Secure; SameSite=Strict; Path=/` |
| New tab | Sign in again | Stays signed in |
| CSRF protection | n/a (token parameter) | `SameSite=Strict`, plus an `Origin` = site check, `Sec-Fetch-Site` check and JSON-only bodies |
| Server checks | Session + admin row + role + allow-list on every call | **Identical**: the same `adminApi` code |

After a password change, the Worker rotates the cookie. Any backend `AUTH_REQUIRED` response clears it. Logout revokes the session in Apps Script before clearing the cookie.

### Caching

- **Browser.** The public page renders instantly from the last copy stored in the browser (`localStorage`, public data only, at most 7 days old), then refreshes from `/api/public`.
- **Worker.** Keeps the public data in memory for 60 s per instance.
  - If Apps Script is temporarily unreachable, it serves the last good copy for up to 6 h.
  - A successful admin change clears that instance's copy immediately.
  - Other Worker instances pick up changes within 60 s.
  - The Cloudflare Cache API is **not** used: it has no effect on `*.workers.dev` ([Cache API docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)).
- **Apps Script.** CacheService is unchanged: 6 h, invalidated on every admin change.
- **Admin dashboard.** Never uses cached data.

### Rate limiting / anti-spam

Everything from the Apps Script version still applies:

- honeypot;
- minimum fill time;
- per-browser and site-wide hourly limits;
- duplicate-link detection;
- URL validation;
- formula-injection protection;
- output escaping;
- LockService.

New, because Cloudflare can see the client IP and Apps Script can't:

- **Per-IP submission limit:** 20/hour. It is higher than the per-browser limit because campus Wi-Fi shares IPs.
- **Per-IP login lockout:** 20 failed attempts per 15 minutes.

The Worker sends Apps Script only an HMAC hash of the IP, never the IP itself.

## Cloudflare free plan: inactivity and limits

This analysis was checked in September 2026 against Cloudflare's official documentation. It is not a guarantee: providers can change their terms.

| Question | Finding (official docs) |
|---|---|
| Are Workers or static sites paused or suspended after inactivity? | **No such mechanism is documented.** The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) pages describe quotas that reset daily, not inactivity pauses. This is unlike the Supabase free-tier pause. |
| Static asset requests | *"Requests to static assets are free and unlimited"* ([static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). The HTML/CSS/JS never touches the Worker quota. |
| Worker requests (`/api/*`) | Free: **100,000 per day**, reset at 00:00 UTC. When exceeded, requests fail with error 1027 or 429 until the reset. |
| CPU | **10 ms per request.** The proxy's own work is a small fraction of that. Waiting for Google does not count as CPU time. |
| Subrequests | 50 per request. We use 2 (the POST plus the redirect GET). |
| Pages vs Workers | Cloudflare recommends *"If you are starting a new project, use Workers instead of Pages"* ([best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)). Pages is still supported. |
| Apps Script side | Consumer accounts: 30 simultaneous executions per user, 1,000 per script, 6 min per execution ([quotas](https://developers.google.com/apps-script/guides/services/quotas)). The Worker and browser caches keep public traffic far below this. |

**Rough budget.** One public page view costs at most one `/api/public` Worker request. Many are served from the Worker's memory, and repeat visitors render from the browser copy first. 100,000 per day is far beyond the expected traffic of a UniMAP student site.

## Deploying

You need a free Cloudflare account and Node.js 18+ on your computer. **Nothing below touches the production Apps Script deployment.**

### Step 1 — Update the Apps Script project code

Saving code in the editor or with `clasp push` changes only the project's *head* (the `/dev` test URL). Existing deployments are pinned to versions and are not affected.

Add or replace these files (all additive or backwards-compatible):

| File | Change |
|---|---|
| `Api.gs` | **New.** `doPost` JSON API |
| `Config.gs` | New constants (secret property name, per-IP limits); version 2.1.0 |
| `Auth.gs` | Per-IP login lockout (only when a hashed IP is present) |
| `Submissions.gs` | Per-IP submission limit (only when a hashed IP is present) |
| `Setup.gs` | New owner-only `generateProxySecret()` |
| `Code.gs` | Comment only |
| `AdminApp.html`, `AdminForms.html`, `PublicApp.html` | Support for the Cloudflare build: cookie mode, admin URL, data refresh, no inline `onclick`. The Apps Script site behaves exactly as before. |

With clasp: `clasp push`. Or copy the files in the editor (+ → Script → `Api`, and so on).

### Step 2 — Create the shared secret

In the editor, open `Setup.gs`, select **`generateProxySecret`** and click **Run**. Then open **Project Settings → Script Properties** and copy the value of `PROXY_SHARED_SECRET`. You need it in step 4.

Never paste it into code, docs, chats or Git.

### Step 3 — Create a separate API deployment

1. Go to **Deploy → New deployment**, click the gear icon and choose **Web app**.
2. Fill in:
   - **Description:** `API for Cloudflare — v2.1.0`
   - **Execute as:** Me
   - **Who has access:** Anyone. The Worker has no Google account; the shared secret protects the API.
3. Click **Deploy** and copy the new URL (`…/exec`). This is `GAS_API_URL`. Treat it as private.

Your old production deployment still exists with its own URL and version. Check **Deploy → Manage deployments**: there are now two.

### Step 4 — Deploy the Worker

```bash
cd cloudflare
npm install
npx wrangler login                    # opens the browser to authorise Wrangler with your Cloudflare account
npm run deploy                        # builds dist/ from ../src and deploys the Worker
#   on the first deploy Wrangler asks you to choose your workers.dev subdomain
npx wrangler secret put GAS_API_URL        # paste the API deployment /exec URL (step 3)
npx wrangler secret put GAS_PROXY_SECRET   # paste PROXY_SHARED_SECRET (step 2)
npx wrangler secret put IP_HASH_SECRET     # any long random string (e.g. from a password manager)
```

Secrets take effect immediately; no redeploy is needed. Check the setup:

- `https://unimap-resources-hub.<subdomain>.workers.dev/api/health` should return `{"ok":true,"data":{"backend":"ok","version":"2.1.0",…}}`.
- `https://unimap-resources-hub.<subdomain>.workers.dev/` is the public site.
- `…/admin` is the dashboard.

### Environment variables and secrets

| Name | Where | Secret? | Purpose |
|---|---|---|---|
| `GAS_API_URL` | Cloudflare secret | Yes (private URL) | Apps Script **API deployment** `/exec` URL. Must match `https://script.google.com/macros/s/…/exec`. |
| `GAS_PROXY_SECRET` | Cloudflare secret | **Yes** | Same value as the Script Property `PROXY_SHARED_SECRET` (at least 32 characters) |
| `IP_HASH_SECRET` | Cloudflare secret | Yes | Key for hashing client IPs (optional; falls back to `GAS_PROXY_SECRET`) |
| `DEV_BACKEND` | `.dev.vars` only | — | `1` allows a `http://localhost` backend for local development. **Never set it in production.** |
| `PROXY_SHARED_SECRET` | Apps Script Script Properties | **Yes** | Enables `doPost`. Without it the API answers `API_DISABLED`. |

`wrangler.jsonc` contains no secrets. `.dev.vars`, `dist/` and `.wrangler/` are git-ignored.

### Updating later

| What changed | Do this |
|---|---|
| Frontend only (`src/*.html`) | `cd cloudflare && npm run deploy`. Also `clasp push` if you want the fallback site's code head in sync. |
| Worker (`cloudflare/src/worker.js`) | `npm run deploy` |
| Apps Script backend code | `clasp push`, then **Deploy → Manage deployments → the *API* deployment → Edit → Version: New version → Deploy**. The API URL stays the same. |
| Promote v2.1 to the old production URL too (optional, only after all tests pass) | Manage deployments → the *production* deployment → Edit → New version. v2.1 is backwards-compatible. |

## Local development

```bash
npm install                    # at the repo root (Playwright for tests)
cd cloudflare && npm install   # wrangler
cd .. && npm run dev:cf        # Apps Script emulation on :8788 + wrangler dev on :8787
```

Open `http://localhost:8787` and `http://localhost:8787/admin`. The terminal prints the temporary owner password of the local emulation.

The local backend runs the real `src/*.gs` code, including `doPost`, and imitates Google's 302 → one-time URL redirect.

## Testing

`npm test` runs everything: 46 backend + 13 Apps Script UI + 14 Cloudflare end-to-end tests (73). See [TESTING.md](TESTING.md).

The Cloudflare end-to-end tests run the **real Worker in `wrangler dev` (workerd)** against the **real Apps Script code**, in Chromium. They cover:

- **No requests to Google:** the browser makes no requests to Google domains.
- **Security headers:** CSP without inline scripts, and the other headers.
- **Public site:** search, programme pages, deep links, and English/Arabic with RTL/LTR at 375 / 820 / 1440 px with no horizontal scroll; mobile navigation; offline render from the browser copy.
- **Submissions:** validation, duplicate links, success written to the Sheet; honeypot, fill-time check and per-IP rate limit.
- **Not an open proxy:** cross-site, no-Origin, wrong content type, oversized, unknown routes and unknown actions are all refused.
- **Sessions:** HttpOnly cookie, token invisible to JavaScript, new-tab session.
- **Admin workflow:** approve → public update, edit, delete → gone publicly, reject, add programme → programme page, settings → public UI, activity log.
- **Admin accounts:** reviewer created and restricted even via direct API calls; deactivation revokes access; forged cookie; password change rotates the cookie; logout.
- **Phone dashboard:** the admin dashboard works on a phone.
- **Fallback:** the original Apps Script HTML site still works alongside.

**Not verifiable locally:** Google's real servers, Cloudflare's real edge, and real browsers signed in to several Google accounts. Use the checklist below after deploying.

### Real-world checklist (after deployment)

Open the **workers.dev URL** in each of these:

- [ ] **A.** Chrome signed in to **one** Google account
- [ ] **B.** Chrome signed in to **two or more** Google accounts. The URL must never change to `/u/1/` or `/u/2/`, and there must be no Drive "Page not found".
- [ ] **C.** Incognito
- [ ] **D.** A browser with no Google login
- [ ] **E.** A phone (Android Chrome, and iPhone Safari if available)

In each one, check:

- the homepage;
- search;
- a programme page;
- **Open resource** (it opens Drive or OneDrive);
- an official collection;
- العربية / English;
- submitting a test link, then submitting it again (duplicate message).

Admin, in one browser:

- [ ] wrong password, then correct password;
- [ ] dashboard;
- [ ] approve the test link → it appears publicly within about a minute;
- [ ] edit it, then delete it → it disappears;
- [ ] reject another test submission;
- [ ] change a setting → the public site updates;
- [ ] admin management;
- [ ] activity log;
- [ ] logout;
- [ ] open `/admin` in a new tab while signed in → still signed in;
- [ ] sign out → the new tab is signed out on its next action.

Also:

- [ ] Open the **Google Sheet** and confirm the rows, statuses and timestamps.
- [ ] Open the **old production `/exec` URL** and confirm it still works.

## Backup and recovery

| Problem | Recovery |
|---|---|
| Cloudflare site broken after a deploy | `cd cloudflare && npx wrangler rollback` (or Dashboard → Workers → unimap-resources-hub → Deployments → Rollback). Meanwhile, share the old `/exec` URL. |
| Cloudflare unavailable or account problem | Share the old production `/exec` URL (unchanged fallback). Data is unaffected because it lives in Google Sheets. |
| `/api/health` says `NOT_CONFIGURED` | A Cloudflare secret is missing or malformed. Re-run `wrangler secret put …`. |
| Public site shows "temporarily unavailable" / `BACKEND_UNAVAILABLE` | Check the Apps Script **API** deployment: access must be **Anyone** and execute as **Me**; the secrets must match; look for errors under Apps Script → Executions. |
| Apps Script API deployment broken by a code change | Manage deployments → API deployment → Edit → pick the previous **version** → Deploy. Production `/exec` is unaffected. |
| Secret leaked or suspected | Run `generateProxySecret()` again, then `wrangler secret put GAS_PROXY_SECRET` with the new value. |
| Google Sheet accidentally modified | Sheets → **File → Version history** to restore, or copy rows back from **UniMAP Resources Hub Database — Backup 30 Sep 2026**. Then clear the cache: **Dashboard → My account → Clear public cache**. |
| Admin locked out | Run `recoverOwnerAccess()` in the Apps Script editor. |

## Troubleshooting

- **Login works but every admin action says "Please sign in".** The browser is blocking the cookie. Check that you are on the `https://…workers.dev` URL, not an embedded preview.
- **`FORBIDDEN – Cross-site request refused`.** The request didn't come from the site itself: a browser extension, a bookmarklet, or a different domain.
- **Changes take up to a minute to appear publicly.** Other Worker instances refresh every 60 s. This is expected.
- **Occasional "temporarily unavailable" while Apps Script → Executions shows the call *Completed* in a few seconds.** Google's front end sometimes never delivers the answer (seen on 30 Sep 2026: `TimeoutError` in `wrangler tail`, script finished in about 3 s). Since the Worker update of 30 Sep 2026 the Worker handles this:
  - Each step has its own timeout: the POST gets 15 s for reads and login, 28 s for writes; fetching the script output gets 10 s.
  - A stalled output fetch is repeated once.
  - Read actions and login are re-sent once. Writes are **never** re-sent, because they may already have been applied. If a write shows this error, reload and check before repeating it.
  - Calls slower than 8 s are logged as `Slow backend call`. Failures are logged as `[action phase ms]`, visible in `wrangler tail`.
- **Error 1027 / 429.** The daily free Worker quota (100,000 `/api/*` requests) is used up. It resets at 00:00 UTC (08:00 Malaysia time). The static pages still load.

## Custom domain (later)

Not required. When wanted: add the domain to Cloudflare, then **Workers → unimap-resources-hub → Settings → Domains & Routes → Add custom domain**. With a custom domain, the Cloudflare Cache API also becomes available if we later want edge caching.
