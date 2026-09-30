# Anonymous analytics

The admin dashboard has an **Analytics** page (owners and admins; reviewers cannot see it). It shows privacy-friendly, anonymous usage statistics for the public website. No new service is involved: the data flows through the existing Cloudflare Worker and Apps Script backend into the same Google Sheet.

```
Browser (Cloudflare site only)
   │  small anonymous events, batched, same-origin POST /api/collect
   ▼
Cloudflare Worker
   │  drops bots · reduces data to coarse categories · adds everything up in memory
   │  about once a minute: ONE aggregated batch (action "analytics.ingest", proxy secret)
   ▼
Apps Script  (src/Analytics.gs)
   │  validates · counts daily unique visitors · merges into today's rows
   ▼
Google Sheets — tab "Analytics"   date | metric | key | count
```

## What is counted

| Counter (`metric`) | Meaning | `key` |
|---|---|---|
| `visit` | A visit: the first page of a browser tab session | — |
| `pageview` | Every page shown, including in-app navigation | — |
| `uniques` | Unique visitors that day (see below) | — |
| `page` | Page views by page type | `home`, `search`, `programme`, `official`, `official:<collection>`, `submit`, `about`, `notfound` |
| `programme` | Views of each programme page | programme ID |
| `click` | Opens of each resource link (student and official) | resource ID |
| `search` / `search_empty` | Number of searches, and how many had no results | — |
| `device` | Device type, per visit | `mobile`, `tablet`, `desktop` |
| `browser` | Browser family, per visit | `chrome`, `safari`, `firefox`, `edge`, `samsung`, `opera`, `other` |
| `country` | Country, per visit, from Cloudflare | 2-letter code, e.g. `MY` |
| `referrer` | Where the visit came from, per visit | host name only, e.g. `google`, `facebook`, or `direct` |

The dashboard shows:

- **Period cards:** today, this week (from Monday), this month and the total.
- **Charts:** a 30-day daily chart and top lists for the last 30 days.

Times use Malaysia time (UTC+8).

## What is NOT collected

- No IP addresses (full or partial), user-agent strings, names, emails, Google accounts, passwords or cookies.
- No search text. Only the fact that a search happened, and whether it found anything.
- No full URLs or exact locations. Referrers are reduced to a host name, and locations to a country code.
- No admin activity: the dashboard does not send analytics.
- No third-party trackers, advertising or fingerprinting. Nothing is shared or sold.

## Unique visitors

For a visit, the Worker computes a keyed hash of *(date, IP, user agent)* using a Worker secret.

- **It changes every day.** It cannot be reversed or linked across days.
- **It only prevents double counting.** Apps Script keeps it in `CacheService` for about a day and **never writes it to the sheet**.
- **Consequence:** the same person visiting on two days counts as two daily unique visitors. That is why the dashboard labels week, month and total uniques as sums of daily uniques.

## Opting out and accuracy

- **Opting out:** browsers with **Do Not Track** or **Global Privacy Control** enabled send nothing. Automated clients (bots, crawlers, link previews, headless browsers) are ignored.
- **Accuracy:** figures are **estimates**:
  - Events wait in the Worker's memory for up to about a minute. If Cloudflare recycles that instance first, the batch is lost.
  - Ad blockers may block the request.
  - The daily unique cache can occasionally expire early.
- **Abuse:** a determined person could inflate the numbers. The Worker limits events per hashed IP, and nothing else is affected.
- **Apps Script fallback site:** the original site (`/exec`) does not collect analytics.

## Retention

- **One row per day per counter**, never one row per visitor.
- **Rows older than 400 days** (about 13 months) are deleted automatically, at most once a day, during normal collection.
- **The "Total" card** covers this retained period and shows the start date.
- **Changing the retention:** edit `ANALYTICS_RETENTION_DAYS_` in `src/Analytics.gs`.

## Performance and quotas

- **Pages never wait for analytics:**
  - The browser queues events and sends one small request every few seconds, or when the page is hidden (`fetch` with `keepalive`).
  - The Worker answers `204` immediately.
  - The Worker sends its batch to Apps Script in the background (`ctx.waitUntil`).
- **Apps Script load:** about **one execution per minute per active Cloudflare instance** while people are using the site, and none when it is quiet. Each execution does one read of the last rows and one write.
- **Sheet size:** roughly 50–150 rows per day, so about 20,000–60,000 rows after a year of retention. That is far below Google Sheets' 10 million cell limit.
- **Worker quota:** the extra request counts towards the free 100,000 requests/day. For a site of this size, that is about 1–3 extra requests per visit.
- **Busy days:** a single day is capped at 1,500 rows; extra keys are counted under `other`.

## Setup

Nothing to configure. The **Analytics** tab is created automatically the first time data arrives. The optional Worker secret `IP_HASH_SECRET` is used for the hashes if set; otherwise, the proxy secret is.

## Security

- **Writing:** only through the Worker, with the proxy shared secret (`analytics.ingest`). It is not callable from the browser (`google.script.run`) and every value is validated against an allow-list.
- **Reading:** only through the admin action `analytics.summary`, which requires a valid session and the **admin** or **owner** role. There is no public read endpoint.
- **Collection endpoint:** `/api/collect` accepts only same-site JSON requests (same Origin/CSRF checks as the other endpoints) and returns no data.
