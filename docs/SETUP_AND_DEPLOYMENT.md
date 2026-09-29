# Setup and deployment

This guide takes you from nothing to a live web app. It assumes a normal Google account (gmail.com works) and no programming experience beyond copying files.

Estimated time: 20–30 minutes the first time.

---

## 1. Create the Google Sheet (the database)

1. Go to <https://sheets.new> (or Google Drive → New → Google Sheets).
2. Rename it to **UniMAP Resources Hub — Database** (click "Untitled spreadsheet" at the top left).
3. Leave it empty. Setup creates every tab and column for you.

> Keep this spreadsheet private. Do **not** share it publicly. The website reads it through the script, and visitors never need access to the sheet itself.

## 2. Create the Apps Script project

1. In the spreadsheet, open **Extensions → Apps Script**. A new tab opens with the script editor. This project is now *bound* to the spreadsheet.
2. Click **Untitled project** at the top and rename it to **UniMAP Resources Hub**.
3. Click the gear icon (**Project Settings**) on the left:
   - Tick **Show "appsscript.json" manifest file in editor**.
   - Set **Time zone** to *(GMT+08:00) Kuala Lumpur*.

Now add the code. Choose **one** of the two options.

### Option A — copy and paste in the editor (no tools needed)

In the editor's **Files** panel:

1. Delete the default `Code.gs` content. You will replace it.
2. For every file in `src/`, create a file with **exactly the same name, without the extension**, and paste the full content:
   - **Script files:** click **+ → Script** and type the name without `.gs`. The files are `Admin`, `Admins`, `Api`, `Auth`, `Categories`, `Code`, `Config`, `Database`, `Migrate`, `Platforms`, `Programmes`, `Resources`, `Seed`, `Settings`, `Setup`, `Submissions`, `Utils`.
   - **HTML files:** click **+ → HTML** and type the name without `.html`. The files are `Admin`, `AdminApp`, `AdminForms`, `AdminStyles`, `AdminViews`, `I18n`, `Index`, `PublicApp`, `PublicSubmit`, `Styles`, `Ui`.
   - **`appsscript.json`:** open it and replace its content with `src/appsscript.json`.
3. Click **Save project** (the disk icon, or Ctrl/Cmd + S).

File names matter. The templates call `include_('Styles')` and so on, so `Styles.html` must be called **Styles**, not *styles* or *Styles.html.html*.

### Option B — clasp (recommended for GitHub)

[`clasp`](https://github.com/google/clasp) is Google's command-line tool. It pushes the `src/` folder to Apps Script so the code on GitHub and in Apps Script stay identical.

```bash
npm install -g @google/clasp
clasp login                                  # opens a browser to authorise clasp
```

1. Enable the Apps Script API for your account: <https://script.google.com/home/usersettings> → **Google Apps Script API: On**.
2. In the Apps Script editor, open **Project Settings → IDs** and copy the **Script ID**.
3. In this repository, run:

   ```bash
   cp .clasp.json.example .clasp.json          # then paste your Script ID into .clasp.json
   clasp push                                  # uploads everything in src/ (answer "y" to overwrite the manifest)
   ```

4. Reload the Apps Script editor. You should see all the `.gs` and `.html` files.

`.clasp.json` is listed in `.gitignore` on purpose: your script ID is not secret, but it is specific to your project.

## 3. (Optional) Choose the first admin email

By default, setup creates the first admin with the email of the Google account that runs it. To use a different email:

- Open **Project Settings → Script Properties → Add script property**.
- Set **Property** to `INITIAL_ADMIN_EMAIL` and **Value** to the email you want.

## 4. Run the initial setup

1. In the editor toolbar, choose **`setup`** from the function dropdown next to **Run** (it lists functions from the file that is open, so open `Setup.gs` first).
2. Click **Run**.
3. **Authorize the script** (first run only):
   1. Click **Review permissions** and choose your Google account.
   2. You will see *"Google hasn't verified this app."* This is normal for your own scripts. Click **Advanced → Go to UniMAP Resources Hub (unsafe)**.
   3. Review the permissions and click **Allow**. They are:
      - **See, edit, create and delete your spreadsheets:** needed to use the Sheet as a database.
      - **See your primary email address:** used by setup to create the first admin and to protect owner-only functions.
4. When it finishes, open **Execution log** (bottom panel). You will see something like:

   ```
   ✓ Created sheet Programmes
   …
   FIRST ADMIN CREATED (role: owner)
     Email:              you@gmail.com
     Temporary password: Kp7m-Qx2r-Vd9s-Hb4n
   ```

   **Copy the temporary password now.** It is shown only once. If you lose it, run `recoverOwnerAccess` (see [Recovery](#recovery)).

What setup did:

- Created the 8 sheets with headers, a frozen header row, plain-text formatting (so `2020` stays text), and TRUE/FALSE, status and role dropdowns.
- Stored the spreadsheet ID and a random password *pepper* in **Script Properties**.
- Added all default settings and the default platforms (Google Drive, OneDrive, Box, Telegram, Website, Other).
- Created your owner account with a temporary password.

Running `setup` again is safe. It only adds what is missing (for example, new columns after an update) and never creates a second admin or deletes data.

## 5. Import content

**Content from the previous website (recommended).** Run **`seedInitialData`** (it lives in `Seed.gs`). It imports:

- the 8 programmes;
- the 20 student drives;
- the UniMAP Academic Guide;
- the 17 official links from the old `/official/...` pages, organised into 3 collections.

It is safe to run more than once.

**Data added to the live Supabase site after that.** See [MIGRATION.md](MIGRATION.md#importing-live-data-from-supabase) and run `importFromSupabase`.

## 6. Check the structure

Run **`validateSetup`**. The log should end with `ALL GOOD`, and every line should have a ✓.

## 7. Deploy the web app (production)

1. Click **Deploy → New deployment**.
2. Click the gear icon next to *Select type* and choose **Web app**.
3. Fill in:
   - **Description:** `v1 production`
   - **Execute as:** **Me (your account)**. The app reads the private Sheet with your permission.
   - **Who has access:** **Anyone**. Students can use it without signing in to Google.
4. Click **Deploy**, then authorize again if asked.
5. Copy the **Web app URL**. It ends in **`/exec`**. This is your production address.

| Setting | Value | Why |
|---|---|---|
| Execute as | **Me** | Visitors never need access to the spreadsheet |
| Who has access | **Anyone** | Public site; "Anyone with Google account" would force students to sign in |

> Use the **`/exec`** URL for production. The **`/dev`** URL (Deploy → Test deployments) always runs the latest *saved* code and only works for you. It is for testing, never for sharing.

## 8. First sign-in

1. Open `<your /exec URL>?p=admin`.
2. Sign in with the admin email and the temporary password.
3. Choose a new password: at least 10 characters, with letters and numbers.
4. Open **My account** and set your display name.
5. Open **Settings** and check the contact email, maintainer name and texts.

The public site is at the plain `/exec` URL. The dashboard is also linked in the footer (**Admin**).

## 9. Updating the production deployment after code changes

The goal is to keep the **same URL**. Do this:

1. Update the code: `clasp push`, or edit and save in the editor.
2. Test it with **Deploy → Test deployments →** open the `/dev` URL.
3. Go to **Deploy → Manage deployments**, select your production deployment, and click the **pencil (Edit)** icon.
4. Set **Version** to **New version**, give it a description (e.g. `v2 — added X`), and click **Deploy**.

The `/exec` URL does not change. **Don't** click *New deployment* for updates, because that creates a *different* URL.

With clasp:

```bash
clasp deployments                                   # find your production deployment ID (AKfy…)
clasp push
clasp deploy -i <deploymentId> -d "v2 — description" # updates that deployment in place
```

If a code change adds new columns or settings, run `setup` once after pushing. It adds them without touching existing data.

## 10. Test the live deployment

Use the checklist in [TESTING.md](TESTING.md#manual-checklist-for-the-real-deployment). It takes about 15 minutes, and it is the only way to confirm Google's real servers behave like the local tests.

## Recovery

| Problem | Fix |
|---|---|
| Lost the temporary password / locked out | Editor → run **`recoverOwnerAccess`**. It resets *your* (the script owner's) admin account, makes it an active owner, and prints a new temporary password in the log. It also clears the login lockout. |
| Edited the sheet by hand and the site hasn't updated | Dashboard → **My account → Clear public cache**, or run **`clearAppCache`** |
| Something looks wrong with the sheets | Run **`validateSetup`**, then **`setup`** to repair missing columns |
| "The database is not available yet" on the site | `setup` was not run, or the `SPREADSHEET_ID` script property points to a deleted sheet. Run `setup`. |
| Moved to a new Google account | Make a copy of the spreadsheet (this copies the bound script too), run `setup` in the copy, and deploy again. Passwords will need resetting, because the pepper lives in Script Properties. |

## Cloudflare frontend

To serve the site from Cloudflare (this fixes the multi-Google-account problem), follow [CLOUDFLARE.md](CLOUDFLARE.md). It uses a **separate** API deployment and leaves this production deployment untouched.

## Using the old domain (optional)

Apps Script web apps can't use a custom domain directly. If you want `unimap-resources-hub.vercel.app` to keep working, replace the old Vercel project with a single redirect (for example, a `vercel.json` with a redirect rule to your `/exec` URL). Only do this once the new version is verified. Until then, keep the old site running.
