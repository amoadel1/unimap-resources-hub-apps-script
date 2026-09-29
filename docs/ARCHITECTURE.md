# Architecture

## File structure (`src/`)

### Server (`.gs`)

All `.gs` files share one global scope in Apps Script.

| File | Responsibility |
|---|---|
| `Config.gs` | App constants, the **sheet schemas** (column names and types), roles, and **setting definitions** (type, default, who may edit, public or private) |
| `Utils.gs` | Error objects and responses, text sanitisation, field validation, **URL validation and normalisation**, hashing helpers, chunked CacheService helpers |
| `Database.gs` | Google Sheets data layer: batched reads per table, header-based column mapping, insert/update/delete/column updates, `withLock_`, change tracking (delta), activity log append, cache invalidation |
| `Auth.gs` | Password hashing, sessions, login/logout, role checks, password policy, temporary passwords |
| `Settings.gs` | Reading/merging settings, public vs admin views, validated saving |
| `Programmes.gs` | Programme CRUD and the generic `reorder_` helper |
| `Categories.gs` | Official-collection CRUD |
| `Platforms.gs` | Platform CRUD, rename cascade |
| `Resources.gs` | Resource validation (shared with approval), CRUD, bulk actions |
| `Submissions.gs` | Public submission (validation, honeypot, rate limit, duplicates), approve, reject, reopen, notes, delete |
| `Admins.gs` | Admin account management, own profile |
| `Admin.gs` | **The single authorised dispatcher** (`adminDispatch_`), the action allow-list with minimum roles, bootstrap payload |
| `Code.gs` | `doGet`, template include, public bundle, and the browser-callable functions |
| `Api.gs` | `doPost` JSON API for the Cloudflare Worker (shared secret, allow-listed actions, hashed client IP). See [CLOUDFLARE.md](CLOUDFLARE.md). |
| `Setup.gs` | `setup`, `validateSetup`, `recoverOwnerAccess`, `clearAppCache`, and the owner guard |
| `Seed.gs` | Import of the previous site's content (`seedInitialData`) |
| `Migrate.gs` | Import of live Supabase CSV exports (`importFromSupabase`) |

### Browser (`.html`)

| File | Contents |
|---|---|
| `Index.html` | Public page template (data embedded by `doGet`) |
| `Admin.html` | Dashboard page template (no data embedded; loads after login) |
| `Styles.html` | Design tokens, components, public layout (light and dark) |
| `AdminStyles.html` | Dashboard layout (sidebar/drawer, responsive tables, forms) |
| `Ui.html` | Shared helpers: auto-escaping `html` template tag, icons, toasts, dialogs/drawers, `rpc()` wrapper, storage wrappers |
| `I18n.html` | Public interface strings in English and Arabic |
| `PublicApp.html` | Public single-page app: routing, home, search, programme, official, about |
| `PublicSubmit.html` | Submission form |
| `AdminApp.html` | Dashboard core: session, API calls, delta application, shell, login, forced password change |
| `AdminViews.html` | Dashboard pages |
| `AdminForms.html` | Form helpers and the add/edit/review drawers |

Naming rule: **functions ending in `_` are private.** Apps Script refuses to call them from `google.script.run`.

## Request flows

**Public page load**

```
GET /exec?p=programme&s=… → doGet()
  → publicBundle_()   (CacheService hit: 0 sheet reads; miss: 5 reads, then cached for 6 h)
  → Index.html with the bundle embedded (safely escaped JSON)
Browser renders everything locally; search and filters make no server calls.
```

**Submission**

```
google.script.run.submitResource(form)
  → validate all fields → honeypot / timing → rate-limit counters (CacheService)
  → withLock_: re-read Resources + Submissions, duplicate checks, insert one row, log
```

**Admin action**

```
google.script.run.adminApi(token, 'resources.save', payload)
  → requireSession_(token): hash lookup in CacheService, then re-read the admin row
      (active? role? password changed since login?)
  → action must exist in the allow-list; admin role ≥ minimum role
  → handler (validation; withLock_ for writes)
  → response { ok, data, delta } — delta = rows inserted/updated/removed (hashes stripped)
  → public cache invalidated automatically if content tables changed
```

The dashboard downloads everything once (`bootstrap`). After that, each action returns only the changed rows (the *delta*). The browser merges them, so the dashboard never has to reload all data.

## Data layer

- **One read per table per request.** `getDataRange().getValues()` is memoised for the execution. Inside `withLock_` the memo is cleared, so writes always act on fresh data.
- **Header-based mapping.** Columns are found by their header name. Extra, manually added columns are preserved on update.
- **Stable IDs.** IDs are random with a type prefix (`prg_`, `res_`, `sub_`, `cat_`, `plt_`, `adm_`, `log_`). Row numbers are looked up from the ID at write time and never exposed.
- **Batching.**
  - Inserts of many rows use one `setValues`.
  - An update writes exactly one row.
  - Reorders, bulk hide/show and platform renames write one column in one call.
  - Deletes of adjacent rows are grouped.
- **Types.** Booleans are stored as `TRUE`/`FALSE`, numbers as numbers, and timestamps as ISO 8601 UTC text. All columns are formatted as plain text, so Sheets never auto-converts values like intakes (`2020`).
- **Activity log is append-only.** It uses `appendRow`, and reading takes only the last *N* rows (`db_tail_`). A large log never slows the site down.

## Caching

| Cache key | Content | Lifetime | Invalidated when |
|---|---|---|---|
| `pub_bundle_v1` (chunked) | Public programmes, collections, resources, platforms, settings | 6 h | Any change to Programmes, Resources, Categories, Platforms or Settings (automatic), or `clearAppCache` |
| `settings_v1` | Settings map | 6 h | Settings change |
| `sess:<sha256(token)>` | Session (admin ID, created, last active) | Idle timeout (≤ 6 h), sliding | Logout, expiry, password change, deactivation (checked against the sheet) |
| `lf:*` | Failed login counters | 15 min | Successful login |
| `rl:*` | Submission rate counters (hourly windows) | ~1 h | — |

Values larger than 100 KB (the CacheService limit) are split into chunks automatically. 3,000+ resources were tested.

## Quotas and performance

Apps Script quotas that matter for a consumer account: roughly 6 minutes per execution, about 30 simultaneous executions, and daily limits on various services. The design keeps every request small:

- A public page is one execution with 0–5 sheet reads.
- Search and filtering run in the browser.
- A submission is about 2 reads and 2 writes (the row plus the log).
- An approval is about 3 reads and 3 writes.
- The dashboard loads with one call (about 8 reads), then one call per action.

The local test suite asserts these limits (`efficiency: bounded spreadsheet calls per request`).

## Security

### Threat model and mitigations

| Threat | Mitigation |
|---|---|
| Someone calls admin functions directly | Only `adminApi` exposes admin operations. Every call checks the session token, the current admin row (active? role?), and an allow-list of actions with minimum roles. Private functions end in `_`, which Apps Script blocks from `google.script.run`. |
| Someone runs `setup`/`recoverOwnerAccess` from the browser | `assertEditor_()` requires the active user to equal the script owner. Anonymous visitors have no active user. |
| Password guessing | Per-email lockout (5 failures → 15 minutes), global slow-down, identical error message for unknown emails, constant-time comparison, and a dummy hash for unknown accounts (same timing) |
| Stolen spreadsheet copy | Hashes are HMAC-SHA-256 × 1000 with a random per-user salt **and a pepper stored in Script Properties**, which is not in the sheet |
| Stolen session token | 256-bit random token; only its SHA-256 is stored; idle timeout plus 12 h absolute limit; revoked by logout, password change, reset or deactivation. The token is kept in `sessionStorage`, so it is cleared when the tab closes. |
| Temporary password misuse | Must be changed before any other action (`PASSWORD_CHANGE_REQUIRED`) |
| XSS through submitted text | All rendering uses the auto-escaping `html` tag. Only reviewed constants go through `raw()`. Links go through `safeUrl()` (http/https only). JSON embedded in pages escapes `<`, `>`, `&`, U+2028 and U+2029. Tested with `<img onerror>` and `</script>` payloads. |
| Dangerous links | `validateUrl_` accepts only `http(s)` URLs with a public-looking host. It rejects `javascript:`, `data:`, `file:`, `vbscript:`, credentials in URLs, IPs, localhost/intranet names, whitespace, quotes and angle brackets. |
| Spreadsheet formula injection | Values starting with `= + - @`, tab or CR are stored with a leading apostrophe, so Sheets treats them as text |
| Spam | Hidden honeypot field, minimum fill time, per-browser and site-wide hourly limits, duplicate detection, manual review before anything is public |
| Race conditions / duplicate records | Every write runs inside `LockService`. Checks (duplicates, "still pending?") are repeated inside the lock. |
| Information leaks | Unexpected errors return a generic message; details go to the Apps Script execution log. The spreadsheet ID, pepper and hashes are never sent to the browser. Admin payloads strip `password_hash`. |
| Clickjacking | `XFrameOptionsMode.DEFAULT` |
| Manipulated browser role checks | They only hide buttons. The server re-checks every call (tested for every restricted action). |

### Known trade-offs

- Apps Script can't read client IP addresses, so rate limiting is per browser (a random ID in `localStorage`) and site-wide.
- `bcrypt`/`Argon2` are not available in Apps Script. Iterated HMAC with a pepper is the practical alternative. The iteration count is stored inside each hash, so it can be raised later (`APP.HASH_ITERATIONS`) without breaking existing passwords.
- Anyone with **edit access to the spreadsheet or the script** is effectively an owner. Share neither.
