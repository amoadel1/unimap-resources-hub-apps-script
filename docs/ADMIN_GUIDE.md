# Admin guide

The dashboard lives at `<web app URL>?p=admin`. It works on phones: tap ☰ to open the menu.

## Roles

| Role | Can do |
|---|---|
| **Reviewer** | View everything, approve or reject submissions, add notes |
| **Admin** | Everything a reviewer can do, plus manage resources, programmes, collections, platforms and content settings; reopen or delete reviewed submissions |
| **Owner** | Everything, including admins, security settings (rate limits, session timeout, https-only), the health check and cache clearing |

There is always at least one active owner. You can't demote, deactivate or delete yourself.

## Daily work: reviewing submissions

1. Open **Submissions**. The **Pending** tab shows the oldest submission first, and the sidebar badge shows how many are waiting.
2. Click **Review**.
3. Check the link: click it and make sure it opens for students (the sharing setting is *Anyone with the link*, or UniMAP accounts).
4. Read the **Possible duplicate** warning if it appears.
5. Adjust the details under **Resource that will be published** if needed:
   - make the title clearer;
   - fix the programme;
   - change the type to *Official UniMAP link* and pick a collection.
6. Optionally, write an **admin note**. It is internal and never shown publicly.
7. Click **Approve & publish** or **Reject**.

Approved resources appear on the public site immediately. The **Approved** and **Rejected** tabs keep the history, including who reviewed each submission and when. A rejected submission can be moved back to pending, and reviewed submissions can be deleted (for example, spam).

## Resources

- **Add resource:** choose the type.
  - *Student resource* must belong to a programme.
  - *Official UniMAP link* can go in a collection. It can optionally also appear on a programme page.
- **Eye icon:** show or hide on the public site. Hidden resources stay in the database.
- **Checkboxes:** select several resources, then choose **Show**, **Hide** or **Delete** in the bar at the bottom.
- **Filters:** by type, programme, platform and status, plus search.
- **Sort order:** a lower number appears first on a programme page. Most people can leave it at 0.

The hub never copies files. If a student updates their Drive folder, nothing needs to change here.

## Programmes

- **Add programme:** enter an English name, and optionally an Arabic name, code, faculty and descriptions.
  - The **URL name** (slug) is generated automatically. The programme's page is `…/exec?p=programme&s=<url-name>`.
  - If you change the URL name later, old shared links to that page stop working.
- **Up/down arrows:** change the order of the homepage cards. Clear any search or filter first.
- **Eye icon:** hide a programme. This also hides all its student resources from the public.
- **Delete** only works when the programme has no resources and no pending submissions. Otherwise, move or delete those first, or simply hide the programme. This prevents orphaned data.

## Official collections

Collections group official UniMAP links, such as *Academic Programme*, *Academic Courses* and *Class Timetable*. Each has a public page at `…/exec?p=official&c=<url-name>`.

- The **+** on a collection row opens the resource form, already set to *Official* and that collection.
- Official links that are not in any collection appear in the **General** list.
- Every official section tells students that the hub itself is an independent student initiative.

## Platforms

These are the names students choose from (Google Drive, OneDrive…).

- **Renaming** a platform updates every resource and submission that uses it.
- **Deactivating** removes it from the forms, but existing resources keep it.
- **Delete** only works when nothing uses it.

## Admins (owners only)

- **Add admin:** enter a name, email and role. A **temporary password** is shown once.
  - Send it privately.
  - The new admin must choose their own password at first sign-in.
- **Key icon:** reset a password. This signs the person out everywhere and gives you a new temporary password.
- **Deactivate:** the person is signed out immediately and can't sign in.

## Settings

Every public text is here, in English and Arabic:

- site name and tagline;
- homepage introduction;
- announcement banner (leave it empty to hide it);
- UniMAP-login notice;
- independence disclaimer;
- official-section introduction;
- welcome message (separate paragraphs with an empty line);
- maintainer name, role and contact email;
- default language.

Submission options:

- Turn submissions off temporarily (**Submissions enabled**).
- *Owner only:* accept https links only, per-browser and site-wide hourly limits.

Security (*owner only*):

- **Session idle minutes:** an admin who is inactive this long must sign in again.

Change fields, then click **Save changes** in the bar at the bottom.

## Activity log

Every administrative action is recorded: sign-ins, approvals, rejections, creates, edits, deletes, settings changes, imports. New submissions are recorded too, with the actor *public*. Use the search and the type filter; **Load older entries** loads up to 300.

## My account

- Change your display name and password. Changing your password signs out your other devices.
- *Owner:*
  - **Run health check** verifies the sheet structure.
  - **Clear public cache** is only needed after editing the spreadsheet by hand.

## Editing the spreadsheet directly (advanced)

You *can* edit the sheets by hand, but the dashboard is safer. If you do:

- Never change or delete values in the `id` column. IDs link programmes, resources and submissions together.
- Use `TRUE` / `FALSE` for yes/no columns (there are dropdowns).
- New rows need a unique `id`. It is easier to add rows through the dashboard.
- Afterwards, click **My account → Clear public cache**. Otherwise the public site may show old data for up to 6 hours.
- The **Admins** sheet (red tab) contains password hashes. Never share the spreadsheet.
