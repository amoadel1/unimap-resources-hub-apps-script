# Testing

## Automated tests (local)

The real `src/` files run in Node on top of `tests/gas-mock.js`, a local emulation of the Apps Script services the hub uses: SpreadsheetApp, CacheService, LockService, PropertiesService, Utilities, Session, HtmlService templates, and `google.script.run` / `google.script.history`. The emulation deliberately reproduces important Google behaviour:

- Strings starting with `=` become formulas unless they are escaped.
- CacheService rejects values larger than 100 KB.
- Functions ending in `_` can't be called from the browser.
- Every spreadsheet call is counted.

```bash
npm install          # installs Playwright (browser tests)
npm test             # all tests (builds the Cloudflare frontend first)
npm run test:cf      # Cloudflare end-to-end tests (real Worker in wrangler dev + real Apps Script code)
npm run test:server  # backend only (fast, no browser)
npm run test:e2e     # browser tests (Chromium, phone / tablet / desktop sizes)
npm run dev          # run the app locally at http://localhost:8787
```

### What is covered

**Setup and database** (`server.test.js`)

- Setup creates all sheets, headers, settings, platforms and exactly one owner.
- Setup is idempotent and repairs missing columns.
- Owner-only functions are refused for web visitors, and private functions are not callable.
- Seed data is imported with correct programme IDs, and IDs are unique and stable.
- Manually re-ordered columns keep working.
- Rows keep their IDs after other rows are deleted.
- Supabase CSV import works and is idempotent.

**Public site**

- Only active and public data is exposed: no emails, hashes or private settings.
- The public data is cached, and the cache is invalidated after admin changes.
- `doGet` embeds data safely (a `</script>` payload is escaped), and deep links are sanitised.
- A missing database gives a friendly error.

**Submissions**

- A valid submission is stored as pending with the correct `programme_id` and ISO timestamps.
- Required, too-short, too-long and invalid-option errors return the right field.
- 20 dangerous or invalid URLs are rejected (`javascript:`, `data:`, localhost, IPs, credentials, quotes…).
- Honeypot and too-fast submissions are silently discarded.
- Duplicate links are caught in different URL shapes, both pending and already listed.
- Per-browser and site-wide rate limits apply, and they reset the next hour.
- Formula injection is neutralised, and values round-trip exactly.
- Closing submissions, https-only mode and official links without a programme all work.
- A held lock gives a friendly BUSY error and writes nothing.

**Authentication and authorisation**

- Login errors don't reveal whether an account exists.
- 5 failures lock the account, even against the correct password.
- Missing, malformed and forged tokens are rejected.
- A temporary password must be changed first. The change revokes all old sessions, and weak passwords are rejected.
- Logout, idle timeout and the absolute session lifetime work.
- Deactivating or resetting an admin revokes their sessions immediately.
- Each restricted action returns FORBIDDEN for reviewers and admins; unknown and prototype actions are rejected.
- No response ever contains password hashes.

**Admin features**

- Programme CRUD, duplicate names, slugs and codes, reordering, and the delete protection.
- Resource CRUD, duplicates, official and student rules, show/hide, bulk actions and delete.
- Collections, and the platform rename cascade and safety rules.
- Approval:
  - creates the resource with the same `programme_id`, records the reviewer, date and notes, and is public immediately;
  - can't run twice;
  - approval with overrides works;
  - approving a duplicate is blocked without creating anything.
- Reject, reopen and delete of submissions.
- Admin management safety: can't demote yourself, there is always one owner, deleted admins are signed out.
- Settings validation, permissions and effect on the public site.
- The activity log records the actor and timestamp.

**Efficiency and errors**

- Bounded numbers of sheet reads and writes per request.
- 3,000 extra resources are still served from a chunked cache.
- Unexpected errors don't leak internal details.

**Browser** (`e2e.test.js`, real Chromium)

- The homepage renders with **zero** server calls.
- Instant search works by programme, intake, platform and notes.
- Programme page: navigation, filters, deep links, not-found page, safe external links (`noopener`).
- Official collections show the independence notice.
- Arabic/English switching with RTL/LTR, and the language is remembered.
- **No horizontal scrolling** on every public page, in both languages, at 375 px, 820 px and 1440 px.
- Submission form: client and server validation errors (including an Arabic error), then success.
- Admin:
  - unauthorised access is rejected, and a wrong password gives an error;
  - login, forced password change, then **approving a submission makes it appear on the public page**;
  - programme create, duplicate error and hide, reflected publicly;
  - a stored XSS attempt is shown as text and never executed;
  - every dashboard page fits a phone screen, and settings saved from a phone appear publicly.

**Cloudflare** (`cloudflare.e2e.test.js`): see [CLOUDFLARE.md](CLOUDFLARE.md#testing). Also, `server.test.js` covers the `doPost` API:
- it is disabled without a secret, and bad or short secrets are refused;
- only allow-listed actions run;
- its data is identical to `getPublicData`;
- per-IP submission and login limits apply;
- admin roles are enforced;
- the HTML Service site is unchanged.

For the Cloudflare site, also run the [real-world checklist in CLOUDFLARE.md](CLOUDFLARE.md#real-world-checklist-after-deployment), including the multi-Google-account test.

## Manual checklist for the real deployment

The local emulation can't prove Google's real servers behave identically, so do this once after deploying (about 15 minutes). Use a phone for at least half of it.

**Public**

- [ ] The `/exec` URL loads the homepage; programme cards and official collections appear.
- [ ] Search for a name, a year (e.g. `2023`) and `Drive`; results appear instantly.
- [ ] Open a programme; filters work; **Open resource** opens the Drive or OneDrive link in a new tab.
- [ ] Switch to العربية: the layout flips right-to-left, the text is Arabic, and a reload keeps Arabic.
- [ ] The browser's back button works between pages; copying a programme page URL and opening it in a new tab shows the same page.
- [ ] In an incognito window (not signed in to Google), the site still works for anonymous visitors.

**Submission**

- [ ] Submit with empty fields: errors are shown.
- [ ] Submit `javascript:alert(1)` as the link: it is rejected.
- [ ] Submit a real test link: the thank-you message appears.
- [ ] Submit the same link again: you are told it is already waiting for review.

**Admin**

- [ ] `?p=admin`: a wrong password is rejected.
- [ ] The test submission appears in **Submissions → Pending**; approve it and it appears on the programme page.
- [ ] Submit another test link and reject it with a note; the **Rejected** tab shows the reviewer and date.
- [ ] Add, edit, hide and delete a test programme and a test resource.
- [ ] Change the announcement text in **Settings**; it appears on the homepage.
- [ ] **Activity log** shows all of the above.
- [ ] **My account → Run health check** reports everything good.
- [ ] Add a reviewer account (your second email); sign in in another browser. The reviewer can approve submissions, but gets "You do not have permission" when trying to edit programmes.
- [ ] Open the spreadsheet: rows have IDs, timestamps are filled, and the approved submission has a `resource_id`.

Finally, delete the test data from the dashboard.
