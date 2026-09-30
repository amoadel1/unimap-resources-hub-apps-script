# UniMAP Resources Hub

> **By Students, For Students**

An independent student-built platform for organizing and discovering academic resources shared by UniMAP students.

> **UniMAP Resources Hub is an independent student initiative. It is not an official UniMAP system** and is not owned, operated, sponsored or endorsed by Universiti Malaysia Perlis.

**Project status:** Production

---

## Contents

- [Overview](#overview)
- [Current production](#current-production)
- [Features](#features)
- [Submission workflow](#submission-workflow)
- [Admin dashboard](#admin-dashboard)
- [Security](#security)
- [Data storage](#data-storage)
- [Technology stack](#technology-stack)
- [Deployment](#deployment)
- [Limitations](#limitations)
- [Development workflow](#development-workflow)
- [Documentation index](#documentation-index)
- [Legacy version](#legacy-version)
- [License](#license)

---

## Overview

UniMAP Resources Hub helps UniMAP students find academic resources that other students have shared (drives, notes, past exams, lab materials and useful links), organised by programme.

- **The platform does not host files.** It stores links. Each resource stays in its owner's account on Google Drive, OneDrive, Box, Telegram, a website or another external service, so students always see the owner's latest version.
- Every public resource has been reviewed by an admin or reviewer before it appears.
- The **Official UniMAP links** section only points to UniMAP's own public websites (academic guide, programme structures, course lists, timetables, library services). The hub itself remains a student project.

About the author: I am an Electrical Engineering student at UniMAP. I designed and developed this initiative with the help of AI tools. It is a student project maintained in my free time, not the work of a professional software team.

## Current production

**Production URL:** <https://unimap-resources-hub.unimaphub.workers.dev>

```
User browser
    │  same origin: static site + /api/*
    ▼
Cloudflare Worker          (static frontend, API proxy, HttpOnly admin session cookie)
    │  server-to-server, shared secret, allow-listed actions only
    ▼
Google Apps Script API     (doPost, all business logic, validation, auth)
    │
    ▼
Google Sheets              (database)
```

- No Vercel, Supabase or other database/backend is part of the production system.
- The original Apps Script web app (`/exec`) is kept as an emergency fallback.
- Serving the site from Cloudflare avoids Google's multi-account (`/u/N/`) problem with Apps Script web apps.

## Features

**Public website**

- **Global instant search** across programme name and code, faculty, resource title, owner, intake, platform and notes. It runs in the browser and supports Arabic text.
- **Programme browsing** and a **page for each programme** with filters (intake, platform), in-programme search and sorting.
- **Official UniMAP links** in four collections: *Academic Programme*, *Academic Courses*, *Class Timetable* and *Library & Digital Services* (UniMAP Library EZproxy, the DSpace digital repository and room reservation), plus general links such as the UniMAP Academic Guide. Every official link uses the same card with its collection, an *Official* badge, a description and the platform.
- **Resource submission** with server-side validation and **duplicate prevention**. The same Drive folder in a different URL shape counts as a duplicate.
- **Arabic and English** with proper **RTL/LTR** layout; the chosen language is remembered.
- **Responsive, mobile-first UI** with an optional dark mode.
- External links always open in a new tab with safe `rel` attributes.

## Submission workflow

```
Student → Submission → Server-side validation → Duplicate check → Pending
        → Admin / Reviewer review → Approval → Public resource
```

1. The student opens **Submit** and chooses *Student resource* or *Official UniMAP link*, then enters their name (shown publicly as the owner), programme, intake, platform, link and optional notes.
2. The server re-checks every field, allows only safe `http(s)` links, blocks duplicates, and applies anti-spam checks (honeypot field, minimum fill time, per-IP, per-browser and site-wide hourly limits).
3. The submission is stored as **pending**. Nothing is public yet.
4. An admin or reviewer reviews it (with duplicate warnings) and can adjust the details.
   - **Approve** creates the resource, marks the submission `approved` and writes to the activity log, all under a lock so it cannot run twice.
   - **Reject** marks it `rejected` with optional notes. It can be reopened later.

## Admin dashboard

Available at `/admin` on the production site.

- **Secure login** with forced change of temporary passwords, and **logout** that revokes the session on the server.
- Overview with statistics, pending submissions and recent activity.
- **Submission review**: approve, reject, reopen, notes, delete.
- **Resource management** (student and official links): add, edit, show/hide, bulk actions, delete.
- **Programme**, **official collection** and **platform** management, including reordering.
- **Admin management** with three roles:
  - **Owner:** everything, including admins and security settings.
  - **Admin:** content and settings.
  - **Reviewer:** reviews submissions.
- **Settings** for every public text (both languages), contact details and submission rules.
- **Activity log** of every administrative action.

### Common tasks

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

Full guide: [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md).

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

## Data storage

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

## Technology stack

| Layer | Technology |
|---|---|
| Public frontend and API proxy | **Cloudflare Workers** with static assets |
| Frontend code | Plain **HTML, CSS and JavaScript** (no framework); a small Node build script assembles the static site from the same templates the Apps Script app uses |
| Backend | **Google Apps Script** (V8 runtime) |
| Database | **Google Sheets** (one tab per table) |
| Caching / sessions | Apps Script `CacheService` (plus a short in-memory cache in the Worker) |
| Concurrency | Apps Script `LockService` |
| Secrets | Apps Script Script Properties and Cloudflare Worker secrets |
| Tooling | `wrangler` (deploy the Worker), `clasp` (sync Apps Script), Node + Playwright (tests) |

## Deployment

Production has two parts. **No secret values are stored in this repository.**

**1. Google Apps Script (backend)**

- The code in `src/` is pushed to the Apps Script project with `clasp push`.
- A dedicated **API web-app deployment** serves `doPost`. It is updated in place: *Manage deployments → Edit → New version*, so the URL never changes.
- Secrets live in **Script Properties** (the spreadsheet ID, the password pepper and the proxy shared secret).

**2. Cloudflare Worker (frontend and proxy)**

- Build and deploy with `node cloudflare/build.mjs`, then `cd cloudflare && npx wrangler deploy`.
- The Apps Script API URL and the shared secret are Worker **secrets** (`wrangler secret put …`), never part of the code.

Step-by-step instructions, including recovery and rollback: [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) and [docs/SETUP_AND_DEPLOYMENT.md](docs/SETUP_AND_DEPLOYMENT.md).

### Apps Script backend (short version)

Full, click-by-click instructions: **[docs/SETUP_AND_DEPLOYMENT.md](docs/SETUP_AND_DEPLOYMENT.md)**.

1. Create a new Google Sheet, then open **Extensions → Apps Script**.
2. Add the files from `src/`, either with `clasp push` or by copy-pasting them in the editor, including `appsscript.json`.
3. Choose `setup` in the editor toolbar, click **Run**, and authorize. The **Execution log** shows your temporary admin password.
4. Optionally, run `seedInitialData` to import the content of the previous website.
5. Go to **Deploy → New deployment → Web app**, with **Execute as: Me** and **Who has access: Anyone**.
6. Open `<web app URL>?p=admin`, sign in, and choose your own password.
7. To publish code changes later, go to **Deploy → Manage deployments → Edit → Version: New version → Deploy**. The URL stays the same.

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
- **Speed.** Each dashboard action is one round trip to Google Apps Script, typically 1–5 seconds; opening the dashboard takes about 3–5 seconds. Sign-in and the dashboard data come back in one call. Public pages load quickly because their data is cached in the Worker and in the browser.
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
- **Run the tests:** `npm test` runs 46 backend tests, 13 Apps Script UI tests and 14 Cloudflare end-to-end tests (73 in total).
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

## Legacy version

The original version of UniMAP Resources Hub was built with **Next.js, React, TypeScript, Tailwind CSS, Supabase (PostgreSQL) and Vercel**.

That implementation remains available in the old repository: [amoadel1/unimap-resources-hub](https://github.com/amoadel1/unimap-resources-hub).

It is the **legacy implementation** and is **not** the current production architecture. What changed and how the data was migrated: [docs/MIGRATION.md](docs/MIGRATION.md).

## License

[MIT](LICENSE). Shared resources belong to their respective owners; the hub claims no ownership of any linked content.
