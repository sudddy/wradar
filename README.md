# wradar

A job radar for every field. Finds jobs in the US, Canada and remote, from interns to C-level, in engineering, sales, finance, marketing, design, people, legal, healthcare and more. Anyone can add their own resume to see how well each job fits them, and keep track of what they've saved and applied to.

No AI runs here. A Python script (standard library only) polls public job sources on a schedule and applies fixed rules.

## Using the app

The app is served from **https://sudddy.github.io/wradar/** once GitHub Pages is on (see [Setup](#setup-pages-and-scan-now)). The step bar in the top bar is the navigation, and a first visit with no saved resume opens step 1:

1. **Your resume:** a welcome with a drop box for a file, or paste the text. Once it's read, it shows what was found, which you can fix, plus your best matches and the skills jobs ask for most that you don't list. **Browse jobs without a resume** skips ahead.
2. **Matching jobs:** the filters, the job list and the selected job, shown as cards. **Posted** picks jobs from the last 2, 3, 7 or 30 days, or **Over 30 days ago**: jobs posted 31 to 90 days ago, with a warning above the list, as many are filled or closed, so check a job is still open before you spend time on it. Without a resume the list asks for one.
3. **Applications:** the jobs you've marked, under All, Saved, Applied and Hidden. A job that leaves the feed stays here, labeled "No longer listed".

The footer links to **Insights** (most-requested skills and how the jobs break down by role, seniority, location and type) and **How it works and privacy** (how jobs are found and which of the 333 sources were read in the 6 hours up to the last scan).

Jobs are kept for 90 days after posting. Past 30 days they move to Over 30 days ago, and they stop counting in Insights and the hot match count. The scan writes the last 30 days to `docs/jobs.js` and the rest to `docs/older.js`, which the page loads after it first appears.

Job data refreshes every 6 hours via GitHub Actions. To refresh sooner, use **Scan now** in the top bar, or the Actions tab → **Fetch jobs** → **Run workflow**. Editing `config.json`, `keywords.json`, `fetch_jobs.py`, `sources.py`, `rules.py`, `extract.py` or `scan_state.py` also triggers a refresh.

To run it on your own machine instead: `python3 fetch_jobs.py`, then open `docs/index.html`. On a Mac with Python from python.org, run `SSL_CERT_FILE=/etc/ssl/cert.pem python3 fetch_jobs.py` (or Python's Install Certificates command first), or every source fails its certificate check.

### Scan now

The button appears once `scan_url` is set in `config.json` (see [Setup](#setup-pages-and-scan-now)). It shows a running clock while the scan runs, and **New jobs ready. Reload** when the new data is out. Expect about 4 to 14 minutes (an estimate, not yet measured end to end). A scan can start at most once an hour, and the scheduled runs count, so the button may say "Next scan in 42 min" instead. If the scan can't be started it says "Scan didn't start" and how old the jobs on screen are.

Remotive, Workable, Workday, SmartRecruiters, Jobicy and Adzuna are read at most once per 6-hour slot, because of their limits or the number of calls they take. After a Scan now, their rows can be up to 6 hours old.

## Your resume

Click **Choose a file** (PDF, Word .docx or text), drop a file on the panel, or paste the text. The app reads it in the browser, with experience, skills, projects and education read separately. It works out your years in the field of your latest job, your level, role and degree (professional degrees such as JD and MD included), and whether each skill shows in your latest job, an older job or project, or is only listed.

Your resume shows all of that. Add or remove skills and correct your years, and every score updates at once. **Replace** and **Remove** do what they say. Without a resume every filter except Match at least still works; the match numbers just stay empty. A resume saved by an earlier version keeps working, and the app asks you to add it again for better scores.

PDF and Word files are read with PDF.js and Mammoth, loaded from cdnjs the first time they're needed, so that step needs an internet connection. Pasting text works offline.

## What stays in your browser

Nothing is uploaded and there are no accounts. Three things are kept in that browser's `localStorage`, and nothing else:

| Key | What it holds |
|---|---|
| `wradar-resume` | Derived facts only: a label such as "PDF resume", your skills, each skill's evidence (where it shows, years of use, months since last used), and your total years, level, role and degree. Never the resume text, your name, your employers or the file name. Skills come from a fixed list, so a company named like one, such as Stripe, can show up as a skill. |
| `wradar-tracker` | Each Saved, Applied or Hidden job: the mark, when you made it, and the job's title, company, link and location. A hidden job also keeps the mark it had before, so showing it again brings that back. |
| `wradar-filters` | Your filter and sort choices. |

Tracking lives in one browser. It doesn't follow you to another device, and clearing site data removes it.

## How matching works

Each job gets a score out of 100 from six parts. It's the points earned out of the points available, so a part the posting doesn't state drops out. The score is a ranking rather than a percentage, so it shows as a plain number.

| Part | Points | How it's scored |
|---|---|---|
| Role | 20 | Full for the same family, part for an adjacent one, little otherwise |
| Seniority | 15 | Full for the same level, less the further apart. Levels run from Intern to C-level on two tracks, individual and manager |
| Years | 15 | Full if you meet the ask, falling to 0 at 40% of it |
| Top must-haves | 36 | The five required skills that matter most for the role, weighted, with a skill named in the title counting most |
| Everything else | 10 | Other required skills, nice-to-haves and mentions |
| Degree | 4 | Full if met, half for a preferred one you don't have, none for a required one |

- **Hot** is 75 or more, **Warm** 65 to 74, **Cool** under 65.
- A skill counts fully from your latest job, .8 from an older job or project, and .5 if it's only listed, and a little less if unused for over 24 or 60 months. A skill you add by hand counts .8.
- Moving from an individual role to a manager one costs, less so when your resume shows people you managed. A licence a field asks for (RN, CPA, bar admission) counts fully when you hold it, and a posting that requires one you don't hold stops at Warm.
- Same-kind required skills count as one requirement, so "Go or Python" is met by either.
- Caps keep poor fits low whatever the other parts add up to. For example, a job whose title sits two levels above yours stops at 45, and one whose title names a skill that's not on your resume stops at 60.
- Each job shows why you fit (up to 4), gaps (up to 3) and what to do next (up to 3). If a cap held the score down, its reason comes first under gaps.

Only the skills in `keywords.json` (about 480 across every field) are visible to the matcher, so a requirement outside it doesn't count for or against you.

## What it shows

- Filters, in one panel: search (title, company, skill, role or field); **Posted** (the last 2, 3, 7 or 30 days, or over 30 days ago); location (US, Canada, Remote), role (grouped by field, such as All Sales, All Finance or Backend), level (Intern to C-level) and work mode; plus **More filters**: minimum pay, job type, source, technologies (pick any or all, e.g. Java, Node.js) and minimum match. Choices are remembered in the browser; **Clear filters** clears them.
- Pay and work mode filters leave out jobs that don't state them, and the count says how many. Pay is compared in each job's own currency, top of the range, with hourly pay counted as 2,080 hours a year.
- Rows: match, title, your mark, company, pay, work mode, place and age. Sort by best match or newest.
- The selected job: its pay, work mode, place and age, then **Apply on company site**, **Applied**, **Save** and **Hide**, then the score and its parts, why you fit, gaps and next steps, the skills it asks for (must-haves, nice to have, also mentioned) each marked as on or not on your resume, and the rest of its facts. After Apply on company site it asks "Did you apply?"
- Your marks: Applied rows show the date and stay in the list until you tick **Hide applied**. Hide removes the row, with an Undo. To bring a job back, select it under Applications → Hidden and press Hide again.
- Moving around: arrow keys move through the list, and Previous and Next above the selected job step through it. On a phone the job opens full screen and Back closes it. `#jobs/<key>` links a job.
- Applicants: shown when a source provides it, otherwise "Not available" (public job APIs don't expose this)
- The skills most often asked for and, with a resume, the skills to add across the listed jobs, and which sources were read in the 6 hours up to the last scan

Role comes from the job title, then the board's department; a generic title like "Software Engineer" falls back to its skills. After a resume is read, Role is set to your field (you can clear it). Level comes from the title too, and a title with no level word reads as Mid. An Account Director is a senior seller, not a Director.

Job type comes from the posting's own field where the site has one (Lever, Ashby, SmartRecruiters, Workable, Workday, Amazon and most feeds). Otherwise it's read from the title or a plain statement in the description; if neither says, it shows "Not specified".

Pay comes from the posting's own field on Lever and Ashby, and on Adzuna when the ad states it (Adzuna's own estimates are left out), otherwise from the description. Work mode comes from the posting's own field (Lever, Ashby, SmartRecruiters), then the title and location, then a plain statement in the description. Workday only says "30+ days" for older postings, so those show as "30+ days ago".

## Sources (333)

| Kind | Count | How it's read |
|---|---|---|
| Greenhouse company boards | 154 | public job board API |
| Ashby company boards | 116 | public posting API |
| Lever company boards | 29 | public postings API |
| Workday career sites (NVIDIA, Salesforce, Capital One, TD, BMO…) | 15 | the career site's own JSON search, the newest 200 jobs |
| SmartRecruiters (ServiceNow, Canva, Freshworks…) | 7 | public postings API |
| Workable | 2 | public widget API |
| Job boards: Remotive, RemoteOK, Jobicy, Himalayas, We Work Remotely, Working Nomads, The Muse, HN "Who is hiring", Amazon Jobs | 9 | public APIs / RSS |
| Adzuna: contract and part-time jobs in every field, gathered from across the web, in the US and Canada | 1 | public search API with a free key (see [Setup: Adzuna](#setup-adzuna)), the newest 250 contract and 250 part-time jobs per country |

LinkedIn, Indeed and Glassdoor aren't polled: they have no public jobs API and their terms forbid scraping.

## Files

| Path | What it is |
|---|---|
| `fetch_jobs.py` | Runs the scan and writes `docs/jobs.js`, `docs/older.js` and `docs/scan.json` |
| `sources.py`, `rules.py` | One adapter per source type; the rules (levels, role families, fields, skills) and `evaluate()` |
| `extract.py` | Reads a posting's required skills, years, pay, work mode and degree |
| `scan_state.py` | What one scan keeps from the last: first-seen dates, Workday dates, slow-source rows |
| `config.json` / `keywords.json` | The rules and the skill dictionary |
| `docs/index.html`, `docs/app.css`, `docs/app.js` | The app (plain HTML, CSS and JavaScript, no build step) |
| `docs/match.js`, `docs/resume.js` | Scoring, and reading a resume |
| `docs/board.js`, `docs/tracker.js`, `docs/scan.js` | The job list and detail, Saved / Applied / Hidden, and the Scan now button |
| `docs/jobs.js`, `docs/older.js`, `docs/scan.json` | Job data from the last run (the last 30 days, and older), and its timestamp and count |
| `worker/scan.js` | Cloudflare Worker behind Scan now |
| `.github/workflows/fetch-jobs.yml` | The 6-hourly schedule |
| `test_*.py`, `tests/` | Python and JavaScript tests |
| `CLAUDE.md` | Notes for working on the project with Claude Code |

## Changing the rules

| File | What to change |
|---|---|
| `config.json` | Allowed locations, max job age (90 days), title include/exclude patterns, boards and feeds, Adzuna's call budget (`adzuna`), and `scan_url` |
| `keywords.json` | The skill dictionary used for both job postings and resumes. Add a skill and its aliases; `=Alias` is case-sensitive, `re:` is a raw regex (keep it valid in both Python and JavaScript). |

To add a company, find its careers page and put the slug under the matching platform in `config.json` → `boards` (the help text there shows each URL pattern). The app's How it works page lists any source that couldn't be read on the last run.

## Setup: Pages and Scan now

The repo owner does these once. Each needs the owner's own accounts.

1. Make the repo public. That gives free Pages and free Actions. Your commit email becomes visible.
2. In Settings → Pages, choose branch `main`, folder `/docs`. Do this before merging: the workflow's last step asks Pages to rebuild, and it fails while Pages is off.
3. Create a free Cloudflare account and a Worker named `wradar-scan`. Paste in `worker/scan.js`.
4. Create a fine-grained GitHub token with access to `wradar` only, Actions read and write, and a 366-day expiry. Add it to the Worker as the secret `GITHUB_TOKEN`, then deploy.
5. Put the Worker URL in `config.json` → `scan_url` and push to `main`. That push runs the workflow, which writes the URL into `docs/jobs.js`, and the button appears.

The Worker URL is not a secret: it's in `config.json` and in the page. The token is. It lives only as a Worker secret, never in this repo or the browser. When it expires, Scan now shows "Scan didn't start" until you add a new one.

The Worker accepts POST only from `https://sudddy.github.io`. It reads the latest Fetch jobs run: if one is running it says so, if the last one started under an hour ago it returns the time left, and otherwise it starts the workflow on `main`. On a fork, change `SITE` and `WORKFLOW` at the top of `worker/scan.js`.

## Setup: Adzuna

Adzuna is a job aggregator, and it adds contract and part-time jobs in every field. It needs a free key, which only the repo owner can get:

1. Sign up at https://developer.adzuna.com/signup and choose **Publishing Adzuna ad listings** as what you'll use the API for.
2. Copy the **app_id** and **app_key** from your Adzuna account.
3. In the repo's Settings → Secrets and variables → Actions, add them as two repository secrets, `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`.

The first scan in the next 6-hour slot reads Adzuna. Until both secrets exist the scan skips it: no calls, and nothing about it on How it works.

Each slot asks Adzuna for contract jobs and for part-time jobs, in the US and in Canada, newest first. `adzuna.pages` in `config.json` sets the calls per slot, four per page: the default 5 pages make 20 calls a slot and at most 80 a day, of `adzuna.per_page` (50) jobs each, and a search that runs out early stops early. The free key's limits aren't published; they show in your Adzuna account, so check them there before raising `pages`.

A job's type comes from Adzuna's own fields (a part-time contract shows as Contract, and a permanent full-time job as Full-time even when the contract search found it), else from the search that found it. Adzuna gives only a snippet of each posting, so its jobs show fewer skills than jobs from a company's own board, and when a job is on both, the company board's copy is the one kept.

The key stays secret: it lives only in the repo secrets and the fetch step's environment, and goes only into the request to Adzuna. It never reaches the data files, the logs or an error message; a refused call shows on How it works as its code, such as "HTTP 429". Adzuna's job links may carry the app_id as a tracking parameter; the app_id isn't secret, only the app_key is.

Adzuna's terms cover this use as publishing Adzuna ad listings, which asks for an "Adzuna" link label on each job shown. Rows from Adzuna have the source `Adzuna`, the app shows that label on them, and each links to Adzuna's own page for the job.

## Tests

```
python3 -m unittest
node --test tests/*.test.js
```

Keep the glob: Node 22 fails on a bare `tests/`. The workflow runs the Python tests before every fetch and the JavaScript tests after it, before the commit, because they read the fresh `docs/jobs.js`. If the JavaScript tests fail, that scan isn't published.
