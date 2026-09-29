# Migration from the Next.js + Supabase version

The original project ([amoadel1/unimap-resources-hub](https://github.com/amoadel1/unimap-resources-hub)) was inspected in full before this version was written. It was **not modified**. Keep it (and its Vercel deployment) running until the new version has been checked on real Google servers.

## What the old version did

- **Pages:**
  - home: hero, founder card, stats, English and Arabic welcome text, search, official links;
  - `/programmes/[slug]`;
  - `/submit`, `/about`, `/contact`;
  - `/admin/login`, `/admin`;
  - about 20 hard-coded `/official/...` pages.
- **Data:** Supabase tables `profiles`, `programmes`, `resources`, `submissions`, `rate_limits`, protected by row-level security.
- **Security:** zod validation, `http(s)`-only links, a honeypot, 5 submissions per IP per hour, security headers in `middleware.ts`.
- **Admin:** a single page with statistics, add forms, the pending queue (approve/reject), and every programme and resource shown as an editable form.

## Feature mapping

| Old (Next.js / Supabase) | New (Apps Script / Sheets) |
|---|---|
| Supabase Postgres tables | Google Sheets tabs with the same core columns, plus stable prefixed IDs |
| Row-level security | Server-side authorisation on every `adminApi` call; the sheet is private |
| Supabase Auth (email/password) + `profiles.is_admin` | Own email/password auth (salted, peppered hashes), `Admins` sheet with 3 roles |
| Promote an admin with SQL | **Admins** page in the dashboard |
| `rate_limits` table, per IP | CacheService counters per browser and site-wide (Apps Script has no visitor IP) |
| zod schemas | `field_()` / `validateUrl_()` validation on the server |
| `middleware.ts` headers / CSP | Not configurable in Apps Script; replaced by escaping, strict URL validation and `XFrameOptionsMode.DEFAULT` |
| Hard-coded `/official/...` pages and title → page mapping in `resource-card.tsx` | **Categories** sheet (official collections) managed in the dashboard |
| Hard-coded platform enum | **Platforms** sheet (editable, with rename cascade) |
| Owner name/email and welcome texts in `lib/constants.ts` | **Settings** sheet, editable in the dashboard |
| Dark mode toggle | Kept (follows the system setting, with a toggle in the footer) |
| Bilingual welcome text | Full English/Arabic interface with RTL layout |
| — | New: activity log, admin notes, reviewer and date on submissions, reopen, bulk actions, reordering, health check |

## Problems found in the old version (fixed here)

These are based on the code in the repository. Your live database may differ from `supabase/schema.sql`.

1. **Submissions probably failed.**
   - The insert spread `resource_type` and `website` into the `submissions` table, which has no such columns.
   - Official submissions sent `programme_id: ""` into a `NOT NULL uuid` column.

   *New:* only known fields are stored, and official submissions are supported without a programme.
2. **Hidden items disappeared from the admin page.** The admin page reused the public queries (`is_active = true`), so a deactivated programme or resource could not be re-activated from the dashboard. *New:* the dashboard sees everything and has explicit show/hide.
3. **No duplicate checks on approval**, and `reviewed_at` was never set. *New:*
   - Links are normalised, so Drive `u/0` and `?usp=` variants count as the same link.
   - Duplicates are checked at submission and at approval, inside a lock.
   - Reviewer, date, notes and the resulting resource ID are recorded.
4. **Deleting a programme** left its resources orphaned and deleted its submissions (`on delete cascade`). *New:* deletion is blocked while anything depends on the programme; hide it instead.
5. **Inconsistent contact email** between `lib/constants.ts` (`adelaljaale@gmail.com`) and `docs/admin-setup.md` (`adelalj3le@gmail.com`). *New:* it is a single setting. The default is the one shown on the old public site. **Check it in Settings.**

## Importing the content

- `seedInitialData()` imports everything from `supabase/schema.sql` and the official pages:
  - 8 programmes with Arabic names;
  - 20 student drives;
  - the Academic Guide;
  - 17 official links in 3 collections.

### Importing live data from Supabase

If students or admins added content on the live site after `schema.sql` was written, import it too:

1. In the Supabase dashboard, open **Table editor**, then for each of `programmes`, `resources` and `submissions` choose **… → Export → CSV**.
2. In the hub spreadsheet, go to **File → Import → Upload** and choose the CSV. Set **Import location** to **Insert new sheet(s)**.
3. Rename the new tabs to exactly `import_programmes`, `import_resources` and `import_submissions`. You don't need all three.
4. In the Apps Script editor, run **`importFromSupabase`** and read the log. It reports:
   - programmes matched (by slug or name) and created;
   - resources created and duplicates skipped;
   - submissions imported;
   - new platforms created;
   - any rows skipped, with the reason.
5. Check the dashboard. When everything looks right, delete the `import_*` tabs.

Running it again is safe. Nothing is imported twice.

Admin accounts are **not** migrated, because Supabase passwords can't be converted. Add admins again from the **Admins** page.

## Switching over

1. Deploy the new version and complete the [manual checklist](TESTING.md#manual-checklist-for-the-real-deployment).
2. Share the new `/exec` URL, or point the old domain at it with a redirect (see [SETUP_AND_DEPLOYMENT.md](SETUP_AND_DEPLOYMENT.md#using-the-old-domain-optional)).
3. Keep the Supabase project for a while as a backup. Only pause or delete it once you are confident.
