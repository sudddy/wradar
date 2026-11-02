# wradar — notes for Claude Code

A job radar for software engineers. A scheduled Python script collects software engineering jobs (US, Canada, remote) from 332 public sources; a static web app on GitHub Pages lets anyone browse them and score them against their own resume, in the browser.

## How it fits together

```
config.json + keywords.json
        │
fetch_jobs.py  ──(GitHub Actions, every 6h)──▶  docs/jobs.js   (window.JOB_DATA = {...})
                                                     │
                       docs/index.html + app.css + app.js  (GitHub Pages, branch main, folder /docs)
                                                     │
                                  resume matching in the browser (nothing uploaded)
```

- `fetch_jobs.py`: standard library only. One adapter per source type returns raw jobs; `evaluate()` applies the rules cheapest-first (title → age → location → description) and tags skills, role, level and job type. Adapters may return functions for `location` / `type` / `description` so detail pages are fetched only for jobs that pass the cheap rules (SmartRecruiters, Workday).
- `docs/jobs.js`: `{generated_at, keywords, rules, sources[], jobs[]}`. Each job: `title, company, where[], location, url, posted, first_seen, source, type, level, role, applicants, skills[], years_required`. `first_seen` is carried over between runs by URL.
- `docs/app.js`: no framework, no build. Compiles `keywords` into regexes the same way Python does, reads uploaded resumes (PDF.js / Mammoth from cdnjs, loaded on demand), scores jobs, renders four hash-routed views: `#jobs`, `#resume`, `#insights`, `#sources`. The radar is an inline SVG built in `renderScope()`.
- `keywords.json`: shared by Python and JavaScript. `=Alias` is case-sensitive, `re:` is a raw regex and must be valid in both languages.

## Commands

- Tests: `python3 -m unittest` (rules, location parsing, job types, and every source parser against payload shapes captured from the live APIs)
- Local run: `python3 fetch_jobs.py`, then open `docs/index.html` (or `python3 -m http.server -d docs`)
- Refresh the live site: Actions → Fetch jobs → Run workflow. Pushing a change to `config.json`, `keywords.json` or `fetch_jobs.py` also triggers it.

## Working rules

- Smallest complete change. Reuse what's here before adding anything; no new dependencies for a few lines; no build step for the front end. New parsing or rule logic gets a test in `test_fetch_jobs.py`.
- Commits are authored as Sudharsan or Claude, nobody else. Use descriptive branch names (`feature/…`, `fix/…`), never random ones. Work on a branch and merge into `main`; `main` is what Pages serves and where the schedule runs.
- The resume never leaves the browser. Only the file name, detected skills and years go in `localStorage`. Keep it that way.
- No AI at runtime and no scraping of sites that forbid it (LinkedIn, Indeed, Glassdoor). Only public APIs, RSS and career-site JSON.
- Don't commit generated data by hand; the workflow commits `docs/jobs.js` as `github-actions[bot]`.

## Source quirks worth knowing

- Greenhouse `content` is HTML escaped twice; `text()` handles it. `company_name` in the API is the real company name.
- Ashby sets `isRemote: true` on hybrid jobs; trust `workplaceType` first.
- Lever `country` and SmartRecruiters `location.country` are ISO codes (`CA` is Canada there, but `, CA` in a US address is California).
- SmartRecruiters and Workday list endpoints have no description; the detail call is lazy. Workday returns `total` only on the first page.
- Remotive asks for at most 4 calls a day, hence the 6-hour schedule. Workable rate-limits hard (429s).
- Board slugs in `config.json` were verified against each platform's API. To add a company, confirm the slug returns jobs first; the app's Sources page lists anything that failed on the last run.
- No public API exposes applicant counts, so `applicants` is null and the app shows "Not available".

## Ideas not built yet

Saved or hidden jobs per browser, more Workday tenants, Adzuna / Jooble feeds behind API keys stored as Actions secrets, email or WhatsApp digests of new hot matches.
