# wradar — notes for Claude Code

A job radar for software engineers. A scheduled Python script collects software engineering jobs (US, Canada, remote) from 332 public sources; a static web app on GitHub Pages lets anyone browse them, score them against their own resume in the browser, and track what they save or apply to.

## How it fits together

```
config.json + keywords.json
        │
fetch_jobs.py + extract.py + scan_state.py  ──(GitHub Actions, every 6h or Scan now)──▶  docs/jobs.js   (window.JOB_DATA = {...})
                                                                                         docs/scan.json (what Scan now polls)
                                                     │
       docs/index.html + app.css + match.js, resume.js, board.js, tracker.js, scan.js, app.js  (GitHub Pages, branch main, folder /docs)
                                                     │
                                  resume matching in the browser (nothing uploaded)

Scan now button ──POST──▶ worker/scan.js (Cloudflare Worker, holds the GitHub token) ──dispatch──▶ Fetch jobs workflow
```

- `fetch_jobs.py`: standard library only. One adapter per source type returns raw jobs; `evaluate()` applies the rules cheapest-first (title → age → location → description) and tags skills, role, level and job type. Adapters may return functions for `location` / `type` / `description` so detail pages are fetched only for jobs that pass the cheap rules (SmartRecruiters, Workday).
- `extract.py`: standard library only. Reads a posting's structure, once per job. `rich_text()` keeps block tags as line breaks and `split_sections()` finds the required and preferred text; `tier_skills()`, `years_min()`, `salary()`, `work_mode()` and `degree()` fill the row fields from that.
- `scan_state.py`: what one scan keeps from the last: `first_seen`, Workday dates, and the rows of slow sources between slots. `merge()` keeps one row per job, matching company and title by `same_job()`: spacing, punctuation and a legal suffix ("Samsara Inc.") don't count, so a role repeated per city or listed by two sources is one row. The row kept is the one the last scan had, else the company's own board's, so its link and tracker key hold still.
- `docs/app.js`: no framework, no build. Compiles `keywords` into regexes the same way Python does, reads uploaded resumes (PDF.js / Mammoth from cdnjs, loaded on demand), wires the page, and renders the hash-routed views: `#jobs`, `#older`, `#mine`, `#resume`, `#insights`, `#sources`. `#jobs/<key>` links one job. The step bar in the top bar is the navigation (`renderSteps()`): 1 Your resume `#resume`, 2 Matching jobs `#jobs` / `#older` (a Last 30 days | Older switch), 3 Applications `#mine`. A bare address with no saved resume opens `#resume`, the welcome. Insights and How it works (`#sources`) are footer links.
- `docs/match.js`: `window.wmatch`. `score(profile, job, stats)` gives a number out of 100 from Role 20, Seniority 15, Years 15, Top must-haves 36, Everything else 10, Degree 4. Parts a posting doesn't state drop out, and caps keep bad fits low. Hot is 75+, Warm 65-74, Cool under 65. It's a ranking, so the app shows a plain number, never `%`. The fit text never mentions scores, caps or weights, and never says "you lack".
- `docs/resume.js`: `window.wresume`. `parseResume()` splits the text into sections, reads job dates, counts years from tech jobs only, and builds each skill's evidence. `pdfLines()` rebuilds lines from PDF.js text positions.
- `docs/board.js`: the list, detail and moving between jobs, shared by Matching jobs (Last 30 days and Older) and Applications. Its first half never touches the page, so `tests/board.test.js` can load it; `tests/page.test.js` loads the whole page on a stub DOM.
- `docs/tracker.js`: Saved, Applied and Hidden, one per job, the Applications view (`#mine`) and the Undo toast.
- `docs/scan.js`: the Scan now button. It stays hidden until `rules.scan_url` is set, and polls `scan.json` every 30 s after a click. New data arrives by page reload.
- `worker/scan.js`: Cloudflare Worker. POST only, from `https://sudddy.github.io` only; `Origin` can be spoofed, so the cooldown is the real limit. It reads the latest workflow run: if running it says so, if started under an hour ago it returns the time left (scheduled runs count), otherwise it dispatches the workflow on `main`. It asks GitHub at most once a minute per isolate, and answers running from memory for a minute after a dispatch.
- `keywords.json`: shared by Python and JavaScript. `=Alias` is case-sensitive, `re:` is a raw regex and must be valid in both languages. `tests/keywords.test.js` compiles every alias and exported rule in JavaScript.

Scripts are classic and load in order: `jobs.js`, `match.js`, `resume.js`, `board.js`, `tracker.js`, `scan.js`, `app.js`, which calls `init()` last. `match.js` and `resume.js` are IIFEs because their names clash with `app.js`.

`init()` splits the rows: `D.all` is everything, `D.jobs` is up to 30 days old (`FRESH_DAYS`), `D.older` is the rest. Insights and the hot counts read `D.jobs`; scoring and job lookup read `D.all`. Older rows are never dropped in the browser; `max_age_days` (90) in `config.json` sets when they leave the data.

### Data contract

`docs/jobs.js`: `{generated_at, slow_fetched_at, keywords, rules, sources[], jobs[]}`.

- `slow_fetched_at`: when the slow sources last ran. See the gate under source quirks.
- `rules`: `max_age_days, locations, scan_url, levels, families, backend, frontend`. The last four are Python's level and role rules, exported so the resume reader reuses them; their regexes must be valid in JavaScript too.
- Each job: `title, company, where[], location, url, posted, first_seen, source, type, level, role, applicants, skills[], must[], nice[], years_required, salary, mode, degree, posted_approx`.
  - `skills[]` is the full list, so filters and Insights read only that. `must[]` and `nice[]` are required and preferred skills beside it; `init()` defaults them to `[]` so older data still loads.
  - `salary`: `{min, max, cur, per}` with `per` as `year` or `hour`, or null.
  - `mode`: `Remote`, `Hybrid`, `On-site` or null.
  - `degree`: `{level, req}` with `level` as `bachelor`, `master` or `phd` and `req` as `required` or `preferred`, or null.
  - `posted_approx`: true when Workday only said "30+ days"; the app shows "30+ days ago".
  - A job's identity is lowercased `company|title` (`job_key()` in Python, `jobKey()` in `board.js`), because a role's URL can change between scans. `first_seen` and the tracker both use it.

`docs/scan.json`: `{generated_at, jobs}`, where `jobs` is the row count. Scan now compares `generated_at` with the loaded data.

## Commands

- Python tests: `python3 -m unittest` (rules, location parsing, job types, extraction and the main source parsers against payload shapes captured from the live APIs in `test_fetch_jobs.py`; carry-over, dedupe and the slow-source gate in `test_scan_state.py`)
- JavaScript tests: `node --test tests/*.test.js` (matching, resume reading, the board, keyword compilation, the Worker against a mocked GitHub, and the Scan now button). Keep the glob: Node 22 fails on a bare `tests/`. They read `docs/jobs.js`, so the workflow runs them after the fetch and before the commit: rows that break them are never published, and a change to the data shape can land before its first scan.
- Local run: `python3 fetch_jobs.py`, then open `docs/index.html` (or `python3 -m http.server -d docs`). With python.org's Python on a Mac, prefix `SSL_CERT_FILE=/etc/ssl/cert.pem`, or every source fails its certificate check.
- Refresh the live site: Actions → Fetch jobs → Run workflow, or Scan now once `scan_url` is set. Pushing a change to `config.json`, `keywords.json`, `fetch_jobs.py`, `extract.py` or `scan_state.py` also triggers it.

## Working rules

- Smallest complete change. Reuse what's here before adding anything; no new dependencies for a few lines; no build step for the front end. New parsing or rule logic gets a test in `test_fetch_jobs.py` (scan state in `test_scan_state.py`); new browser logic gets one in `tests/`.
- Commits are authored as Sudharsan or Claude, nobody else. Use descriptive branch names (`feature/…`, `fix/…`), never random ones. Work on a branch and merge into `main`; `main` is what Pages serves and where the schedule runs.
- The resume never leaves the browser. `localStorage` key `wradar-resume` holds derived facts only, the keys in `wresume.STORED_KEYS`: `name` (a label such as "PDF resume", never the file name), `skills`, `evidence` (per skill: `strength`, `years`, `recent` in months), `years`, `level`, `role`, `degree`. Never the text, the person's name or employers. `tests/resume.test.js` holds this in place. Keep it that way.
- `localStorage` key `wradar-tracker` holds `{key: {s, at, title, company, url, where}}`, where `s` is `saved`, `applied` or `hidden`; a hidden entry also holds `was`, the entry it replaced, so showing the job again restores an Applied or Saved mark. The snapshot lets a job that leaves the feed still show. Tracking stays in the browser: no accounts, no database. `wradar-filters` holds the filter choices.
- The GitHub token lives only as the Worker secret `GITHUB_TOKEN`, never in the repo or the browser. The Worker URL in `scan_url` is not a secret.
- No AI at runtime and no scraping of sites that forbid it (LinkedIn, Indeed, Glassdoor). Only public APIs, RSS and career-site JSON.
- Don't commit generated data by hand; the workflow commits `docs/jobs.js` and `docs/scan.json` as `github-actions[bot]`.

## Source quirks worth knowing

- Greenhouse `content` is HTML escaped twice; `text()` and `rich_text()` handle it. `company_name` in the API is the real company name.
- Ashby sets `isRemote: true` on hybrid jobs; trust `workplaceType` first.
- Lever `country` and SmartRecruiters `location.country` are ISO codes (`CA` is Canada there, but `, CA` in a US address is California).
- SmartRecruiters and Workday list endpoints have no description; the detail call is lazy. Workday returns `total` only on the first page.
- Workday dates are relative to the scan, so `carry()` keeps the oldest `posted` it has seen.
- Slow-source gate: Remotive, Workable, Workday, SmartRecruiters and Jobicy run at most once per 6-hour UTC slot (`slot_open()` against `slow_fetched_at` in `scan_state.py`). A scan in a slot where they already ran carries over their last rows and source entries (`held_over()`), so those rows can be up to 6 hours old. Remotive asks for at most 4 calls a day, Workable rate-limits hard (429s), and Workday and SmartRecruiters make a detail call per job, so Scan now must not bypass this.
- GitHub's docs say pushes made with `GITHUB_TOKEN` don't trigger a Pages build, so the workflow's last step requests one. That step fails while Pages is off.
- Board slugs in `config.json` were verified against each platform's API. To add a company, confirm the slug returns jobs first; the app's How it works page lists anything that failed on the last run.
- No public API exposes applicant counts, so `applicants` is null and the app shows "Not available".

## Ideas not built yet

Best first:

1. Application stages and notes: Applied, Interview, Offer, Rejected, plus a note per job.
2. Company watchlist: pin companies and see their new jobs first.
3. "Posted since" date filter.
4. Shareable filter links: a URL that opens a saved search.
5. Email or WhatsApp digest of new hot matches. It needs a small server, so it needs a privacy decision first.

Also: more Workday tenants, and Adzuna / Jooble feeds behind API keys stored as Actions secrets.

Passed on for now: visa and clearance flags (only 1-4% of postings state them) and a tracker backup file.
