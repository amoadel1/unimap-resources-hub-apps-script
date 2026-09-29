# UniMAP Resources Hub — Google Apps Script edition

> **By Students, For Students**

UniMAP Resources Hub is an **independent student initiative** that helps students at Universiti Malaysia Perlis (UniMAP) find academic resources that other students have shared: Google Drive folders, OneDrive, Box, Telegram channels, websites and other useful links, organised by programme.

**This is not an official UniMAP system.** It is not owned, operated or endorsed by UniMAP. The "Official resources" section only links to UniMAP's own public websites (academic guide, programme structures, course lists, timetables). The hub itself is still a student project.

> **UniMAP Resources Hub is an independent student-built platform and is not an official UniMAP system.**

**Version 2.1 (Cloudflare frontend).** Google does not support Apps Script web apps for people signed in to several Google accounts at once: they can land on a `/u/2/` URL and see a Drive "Page not found". The public site and the dashboard are therefore also served from **Cloudflare**, which calls Apps Script server-to-server. Google Sheets remains the database, and the original Apps Script web app stays available as the fallback. Details: [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

This repository contains version 2 of the hub. It was rebuilt on **Google Apps Script + Google Sheets** so the platform can run without Supabase or Vercel and be managed completely from an admin dashboard. The original Next.js + Supabase version stays in its own repository ([amoadel1/unimap-resources-hub](https://github.com/amoadel1/unimap-resources-hub)) as a reference, and it was not modified.

About the author: I am an Electrical Engineering student at UniMAP. I designed and developed this initiative with the help of AI tools. It is a student project, maintained in my free time, not the work of a professional software team.

---

## Contents

- [What the platform does](#what-the-platform-does)
- [How resources work](#how-resources-work)
- [How students submit resources](#how-students-submit-resources)
- [How approval works](#how-approval-works)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Google Sheets database](#google-sheets-database)
- [Setup and deployment (short version)](#setup-and-deployment-short-version)
- [Using the admin dashboard](#using-the-admin-dashboard)
- [Security](#security)
- [Limitations](#limitations)
- [Development workflow](#development-workflow)
- [Documentation index](#documentation-index)

---

## What the platform does

**For students (public website)**

- A homepage with a short introduction, instant search, programme cards, the official links and a welcome message.
- **Instant search** across programme name and code, faculty, resource title, owner, intake, platform and notes. It runs in the browser, supports Arabic text, and needs no server request.
- A **page for each programme**, listing every shared resource with its owner, intake, platform, notes and a button to open the original link. You can filter by intake and platform, search within the programme, and sort the list.
- **Official UniMAP links**, grouped into collections such as *Academic Programme*, *Academic Courses* and *Class Timetable*. Each collection has a clear note that the hub itself is not official.
- A **submission form** for sharing a new link.
- An **About** page with contact details.
- **Arabic and English**. The whole interface switches, with proper right-to-left layout and an Arabic font, and the chosen language is remembered.
- **Designed for phones first**, and it also works on tablets and desktops. There is an optional dark mode.

**For admins (dashboard at `…/exec?p=admin`)**

- An overview with statistics, submissions waiting for review, and recent activity.
- A **review queue** for submissions: approve (optionally editing the details first) or reject, with admin notes.
- Management of **resources, programmes, official collections and platform names**: add, edit, show or hide, reorder and delete.
- **Admin accounts** with three roles (owner, admin, reviewer).
- **Settings** for every text on the site (in both languages), the contact details, and the submission rules.
- An **activity log** of every administrative action.

You never need to edit code for normal administration.

## How resources work

The hub **does not host files**. It stores a link to a resource that stays in its owner's account (Google Drive, OneDrive, Box, Telegram, a website…). When the owner adds or updates files in their folder, students see the latest version through the same link, and nothing needs to be uploaded again.

Each resource belongs to a programme (student resources) or is marked **official** (UniMAP links, optionally grouped in a collection). Resources can be hidden without being deleted.

## How students submit resources

1. The student opens **Submit** and chooses *Student resource* or *Official UniMAP link*.
2. They enter their full name (shown publicly as the owner), the programme, the intake, the platform, the link, and optional notes.
3. The server re-checks everything:
   - It validates every field and allows only safe `http(s)` links.
   - It blocks duplicates. The same Drive folder in a different URL shape counts as a duplicate.
   - It applies anti-spam checks: a hidden honeypot field, a minimum time to fill the form, and per-browser and site-wide hourly limits.
4. The submission is stored with status **pending**. Nothing becomes public yet.

## How approval works

1. An admin opens **Submissions → Pending** and clicks **Review**.
2. The dashboard shows the details and warns about possible duplicates. The admin can adjust the title, programme, type, collection or notes.
3. **Approve & publish** does three things:
   - It creates the resource with the same `programme_id`.
   - It marks the submission `approved`, with the reviewer, the date and the new resource ID.
   - It writes an entry to the activity log.

   Approval happens under a lock, so it cannot run twice and cannot create a duplicate.
4. **Reject** marks the submission `rejected`, with the reviewer, the date and optional notes. A rejected submission can be moved back to pending.

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | Apps Script HTML Service: plain HTML, CSS and JavaScript, with no framework and no build step |
| Backend | Google Apps Script (V8 runtime) |
| Database | Google Sheets (one tab per table) |
| Caching / sessions | Apps Script `CacheService` |
| Concurrency | Apps Script `LockService` |
| Secrets | Apps Script `PropertiesService` (Script Properties) |
| Hosting | Cloudflare Workers + static assets (public site and dashboard). The Apps Script Web App (versioned deployment) is the backend API and the fallback site. |
| Optional tooling | `clasp` for syncing with GitHub; Node + Playwright for local tests |

## Architecture

**Production path (v2.1):**

```
Browser ──same origin──▶ Cloudflare Worker (static site + /api/* proxy, HttpOnly admin cookie)
                              │ server-to-server, shared secret, allow-listed actions only
                              ▼
                         Apps Script doPost (Api.gs) ──▶ same backend code ──▶ Google Sheets
```

**Apps Script web app** (the original, still working, used as the fallback):

```
Browser (HTML Service page)                    Apps Script server                         Google Sheet
─────────────────────────────                  ─────────────────────────                  ─────────────
Index.html  ─ doGet() embeds public data  ◀──  Code.gs  (doGet, public API)       ──▶    Programmes
  Ui.html, I18n.html, PublicApp.html            Settings.gs / Programmes.gs /              Resources
  PublicSubmit.html                             Categories.gs / Platforms.gs /             Submissions
     │  google.script.run.submitResource ───▶   Resources.gs / Submissions.gs              Categories
Admin.html  (?p=admin)                          Admins.gs / Auth.gs                        Platforms
  AdminApp / AdminViews / AdminForms            AdminServer.gs (single authorised dispatcher)   Admins
     │  google.script.run.adminApi(token,…) ─▶  Database.gs (batched reads/writes, locks)  Settings
                                                Utils.gs  (validation, URLs, hashing)      ActivityLog
                                                Setup.gs / Seed.gs / Migrate.gs (owner-only)
```

- **Public pages need no server calls on first load.** `doGet()` embeds the cached public data in the page.
- **Admin actions all go through one entry point**, `adminApi(token, action, payload)`. It checks the session, the admin's current role in the sheet, and an allow-list of actions.
- **Every write runs under the script lock.** Inside the lock, data is re-read, validated, written with a single `setValues` call where possible, and logged.
- **The cache is refreshed after changes.** The public data is cached for up to 6 hours and cleared automatically after any content change.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Google Sheets database

The setup function creates all of these tabs, headers, formats and dropdowns. You never create columns by hand.

| Sheet | Purpose | Key columns |
|---|---|---|
| **Programmes** | Programme / faculty pages | `id, slug, code, name, name_ar, faculty, description, description_ar, is_active, sort_order, created_at, updated_at, created_by, updated_by` |
| **Resources** | Every public link | `id, programme_id, category_id, title, owner_name, intake, platform, url, url_key, notes, is_official, is_active, sort_order, source_submission_id, created_at, updated_at, created_by, updated_by` |
| **Submissions** | Student submissions and review history | `id, resource_type, full_name, programme_id, intake, platform, resource_url, url_key, notes, status, submitted_at, reviewed_at, reviewed_by, admin_notes, resource_id, client_ref` |
| **Categories** | Collections of official links | `id, slug, name, name_ar, description, description_ar, is_active, sort_order, created_at, updated_at` |
| **Platforms** | Editable platform names | `id, name, is_active, sort_order, created_at, updated_at` |
| **Admins** | Dashboard accounts | `id, name, email, role, is_active, password_hash, must_change_password, password_changed_at, created_at, updated_at, last_login, created_by` |
| **Settings** | Site texts and options | `key, value, description, updated_at, updated_by` |
| **ActivityLog** | Audit trail (append-only) | `id, timestamp, admin_email, action, entity_type, entity_id, details` |

- **IDs:** every row has a random, stable ID (e.g. `res_4f1c2a9be0d34c51a7b2`). Row numbers are never used as IDs.
- **Columns:** they are matched by header name, so reordering columns or adding your own notes columns will not break anything.
- **Timestamps:** they are stored as ISO 8601 text (UTC).

## Setup and deployment (short version)

Full, click-by-click instructions: **[docs/SETUP_AND_DEPLOYMENT.md](docs/SETUP_AND_DEPLOYMENT.md)**.

1. Create a new Google Sheet, then open **Extensions → Apps Script**.
2. Add the files from `src/`, either with `clasp push` or by copy-pasting them in the editor, including `appsscript.json`.
3. Choose `setup` in the editor toolbar, click **Run**, and authorize. The **Execution log** shows your temporary admin password.
4. Optionally, run `seedInitialData` to import the content of the previous website.
5. Go to **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**.
6. Open `<web app URL>?p=admin`, sign in, and choose your own password.
7. To publish code changes later, go to **Deploy → Manage deployments → Edit → Version: New version → Deploy**. The URL stays the same.

## Using the admin dashboard

See **[docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)**. The most common tasks:

| Task | Where |
|---|---|
| Approve / reject a submission | Submissions → Review |
| Add a resource manually | Resources → Add resource (or the **+** on a programme row) |
| Add an official UniMAP link | Resources → Add → Type: *Official UniMAP link* → choose a collection |
| Hide something temporarily | The eye icon on any row |
| Add / rename / reorder programmes | Programmes |
| Rename a platform everywhere | Platforms → Edit |
| Change homepage texts, notices, contact email | Settings |
| Add another admin | Admins → Add admin (owner only) |
| See who changed what | Activity log |

## Security

- **Server-side authentication.** Passwords are salted, iterated HMAC-SHA-256 hashes with a secret pepper that is kept in Script Properties, not in the sheet.
  - Sessions use random 256-bit tokens; only their SHA-256 is stored on the server. They expire after a period of inactivity and have a maximum lifetime.
  - Failed logins are throttled and lock the account for a while.
  - Temporary passwords must be changed at first login.
- **Authorization on every call.** The admin's current role and active status are re-read from the sheet each time. The browser's view of roles only hides buttons.
- **Small public surface.** On Apps Script, only six functions can be called from the browser, plus `doPost`, which stays disabled until a 32+ character shared secret is configured. Owner-only maintenance functions refuse to run for web visitors. Private functions end with `_`, which Apps Script blocks from `google.script.run`.
- **Cloudflare frontend.**
  - The Worker has fixed routes only (it is not an open proxy) and follows redirects only to `script.googleusercontent.com`.
  - It checks the Origin (CSRF) and limits request size.
  - The admin session lives in an `HttpOnly; Secure; SameSite=Strict` cookie that page JavaScript never sees.
  - The CSP allows no inline scripts.
  - Per-IP rate limits use a hashed IP.
- **Input validation and sanitisation on the server.** This covers lengths, allowed values, control and bidi-override characters, emails and numbers.
- **Strict URL validation.** Only `http(s)` links are accepted. `javascript:`, `data:`, `file:`, credentials in URLs, IP addresses, localhost/intranet hosts, quotes and whitespace are rejected.
- **Formula-injection protection.** Any value starting with `= + - @` is stored as plain text in Google Sheets.
- **XSS protection.** All dynamic HTML is built with an auto-escaping template helper, and JSON embedded in pages is escaped.
- **Anti-spam.** A honeypot field, a minimum fill time, per-browser and site-wide rate limits, and duplicate detection.
- **Concurrency safety.** `LockService` guards every write, and checks are repeated inside the lock (no double approval, no duplicate rows).
- **Safe errors.** Users see friendly messages; stack traces and internal details are only logged on the server.
- **No secrets in the browser.** The spreadsheet ID, the pepper and password hashes never leave the server.

Details and the threat model: [docs/ARCHITECTURE.md#security](docs/ARCHITECTURE.md#security).

## Limitations

- **Google banner, URL and multi-login (Apps Script site only).** On the original Apps Script site:
  - Google shows a notice: *"This application was created by a Google Apps Script user."*
  - The URL is a long `script.google.com/…/exec` address.
  - Multi-account browsers can hit Google's `/u/N/` problem.

  The Cloudflare frontend avoids all three.
- **Cloudflare free plan.**
  - 100,000 `/api/*` requests per day; static pages are unlimited.
  - No inactivity pause is documented (see [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md#cloudflare-free-plan-inactivity-and-limits)).
  - Public changes can take up to about 60 s to appear on every Cloudflare instance.
- **Rate limiting by IP only on Cloudflare.** Apps Script cannot see IP addresses. On the Cloudflare site the Worker adds per-IP limits (using a hashed IP). The fallback Apps Script site only has per-browser and site-wide limits.
- **Speed.** Each dashboard action is one round trip to Google, typically 0.5–2 seconds. Public pages load quickly because their data is embedded and cached. The first request after a quiet period can be slower (cold start).
- **Scale.** Google Sheets comfortably handles thousands of resources. The design reads each sheet once per request and caches public data. For tens of thousands of rows, a real database would be more suitable.
- **Sessions can end early.** Sessions live in `CacheService`, which Google may clear early, so an admin occasionally has to sign in again.
- **Password hashing** uses the strongest primitive available in Apps Script (iterated HMAC-SHA-256 with a pepper). This is weaker than bcrypt or Argon2, which Apps Script does not provide.
- **Manual sheet edits** take effect on the public site when the cache expires, or immediately after running `clearAppCache()` or using **My account → Clear public cache**. Keep IDs intact when editing by hand.
- **The admin dashboard is in English.** The public site is fully bilingual.
- **Local testing only.** The automated tests run the real code against a local emulation of Apps Script and Google Sheets. They do not replace a final check on your real deployment (see [docs/TESTING.md](docs/TESTING.md)).

## Development workflow

```
unimap-resources-hub-apps-script/
├── cloudflare/          ← Cloudflare Worker + build of the static frontend (from src/*.html)
│   ├── src/worker.js    ← /api/* proxy (allow-listed routes, cookie sessions)
│   ├── web/             ← google.script adapter, boot scripts, _headers (CSP), favicon
│   ├── build.mjs        ← generates dist/ from ../src
│   └── wrangler.jsonc   ← Worker config (no secrets)
├── src/                 ← everything that goes into the Apps Script project
│   ├── appsscript.json
│   ├── *.gs             ← server code (one module per concern)
│   └── *.html           ← page templates, styles and browser scripts
├── tests/
│   ├── gas-mock.js      ← local emulation of SpreadsheetApp, CacheService, LockService…
│   ├── dev-server.js    ← runs the real app locally at http://localhost:8787
│   ├── server.test.js   ← backend integration tests (incl. doPost API)
│   ├── e2e.test.js      ← browser tests of the Apps Script site (Playwright)
│   └── cloudflare.e2e.test.js ← browser tests through the real Worker (wrangler dev)
├── docs/
├── .clasp.json.example
└── package.json
```

- **Run locally:** `npm install && npm run dev`, then open `http://localhost:8787` (and `/?p=admin`). The temporary owner password is printed in the terminal.
- **Run the tests:** `npm test` runs 44 backend tests, 13 Apps Script UI tests and 13 Cloudflare end-to-end tests.
- **Run the Cloudflare version locally:** `npm run dev:cf`, then open `http://localhost:8787`.
- **Sync with Apps Script (optional):** use `clasp`. See [docs/SETUP_AND_DEPLOYMENT.md#option-b--clasp-recommended-for-github](docs/SETUP_AND_DEPLOYMENT.md#option-b--clasp-recommended-for-github).
- **Branch workflow:** make changes on a branch, run `npm test`, then `clasp push`. Test with **Deploy → Test deployments**, then update the production deployment with a **new version**.

## Documentation index

- [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md): Cloudflare frontend, including architecture, deployment, secrets, the free-plan and inactivity analysis, testing, recovery and troubleshooting.
- [docs/SETUP_AND_DEPLOYMENT.md](docs/SETUP_AND_DEPLOYMENT.md): create the project, run setup, authorize, deploy and update.
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md): day-to-day administration.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): code structure, data model, caching, security.
- [docs/MIGRATION.md](docs/MIGRATION.md): what changed from the Next.js/Supabase version, and how to import live data.
- [docs/TESTING.md](docs/TESTING.md): automated tests and the manual test checklist.

## License

MIT. Shared resources belong to their respective owners; the hub claims no ownership of any linked content.
