# wradar

A job radar for software engineers. Finds software engineering jobs in the US, Canada and remote, for every technology. Anyone can add their own resume to see how well each job fits them, and keep track of what they've saved and applied to.

No AI runs here. A Python script (standard library only) polls public job sources on a schedule and applies fixed rules.

## Using the app

The app is served from **https://sudddy.github.io/wradar/** once GitHub Pages is on (see [Setup](#setup-pages-and-scan-now)). It has six sections:

- **Jobs:** jobs posted in the last 30 days. A strip at the top shows the counts and a radar you can expand (each blip is a job, each wedge a role, closer to the center means a better match, or newer before you add a resume). Below it are the filters, the job list, and the selected job.
- **Older:** jobs posted 31 to 90 days ago, kept apart, with a warning above the list. Many are filled or closed, so check a job is still open before you spend time on it.
- **My jobs:** the jobs you've marked, under All, Saved, Applied and Hidden. A job that leaves the feed stays here, labeled "No longer listed".
- **My resume:** add your resume, see what was read from it, fix it, and see the skills jobs ask for most that you don't list, plus your best matches.
- **Insights:** most-requested skills and how the jobs break down by role, seniority, location and type.
- **Sources:** how jobs are found and which of the 332 sources were read in the 6 hours up to the last scan.

Jobs are kept for 90 days after posting. Past 30 days they move from Jobs to Older, and they stop counting in Insights, the radar and the hot match count.

Job data refreshes every 6 hours via GitHub Actions. To refresh sooner, use **Scan now** in the top bar, or the Actions tab → **Fetch jobs** → **Run workflow**. Editing `config.json`, `keywords.json`, `fetch_jobs.py`, `extract.py` or `scan_state.py` also triggers a refresh.

To run it on your own machine instead: `python3 fetch_jobs.py`, then open `docs/index.html`. On a Mac with Python from python.org, run `SSL_CERT_FILE=/etc/ssl/cert.pem python3 fetch_jobs.py` (or Python's Install Certificates command first), or every source fails its certificate check.

### Scan now

The button appears once `scan_url` is set in `config.json` (see [Setup](#setup-pages-and-scan-now)). It shows a running clock while the scan runs, and **New jobs ready. Reload** when the new data is out. Expect about 4 to 14 minutes (an estimate, not yet measured end to end). A scan can start at most once an hour, and the scheduled runs count, so the button may say "Next scan in 42 min" instead. If the scan can't be started it says "Scan didn't start" and how old the jobs on screen are.

Remotive, Workable, Workday, SmartRecruiters and Jobicy are read at most once per 6-hour slot, because of their limits or the number of calls they take. After a Scan now, their rows can be up to 6 hours old.

## Your resume

Click **Choose a file** (PDF, Word .docx or text), drop a file on the panel, or paste the text. The app reads it in the browser, with experience, skills, projects and education read separately. It works out your years from tech jobs, your level, role and degree, and whether each skill shows in your latest job, an older job or project, or is only listed.

My resume shows all of that. Add or remove skills and correct your years, and every score updates at once. **Replace** and **Remove** do what they say. Without a resume every filter except Match at least still works; the match numbers just stay empty. A resume saved by an earlier version keeps working, and the app asks you to add it again for better scores.

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
| Seniority | 15 | Full for the same level, less the further apart |
| Years | 15 | Full if you meet the ask, falling to 0 at 40% of it |
| Top must-haves | 36 | The five required skills that matter most for the role, weighted, with a skill named in the title counting most |
| Everything else | 10 | Other required skills, nice-to-haves and mentions |
| Degree | 4 | Full if met, half for a preferred one you don't have, none for a required one |

- **Hot** is 75 or more, **Warm** 65 to 74, **Cool** under 65.
- A skill counts fully from your latest job, .8 from an older job or project, and .5 if it's only listed, and a little less if unused for over 24 or 60 months. A skill you add by hand counts .8.
- Same-kind required skills count as one requirement, so "Go or Python" is met by either.
- Caps keep poor fits low whatever the other parts add up to. For example, a job whose title sits two levels above yours stops at 45, and one whose title names a skill that's not on your resume stops at 60.
- Each job shows why you fit (up to 4), gaps (up to 3) and what to do next (up to 3). If a cap held the score down, its reason comes first under gaps.

Only the skills in `keywords.json` are visible to the matcher, so a requirement outside it doesn't count for or against you.

## What it shows

- Filters: search, location (US, Canada, Remote), role (Backend, Full stack, Frontend, Data, DevOps / SRE…), seniority (Junior, Mid, Senior, Staff+) and work mode, plus **More filters**: minimum pay, job type, source, technologies (pick any or all, e.g. Java, Node.js), minimum match and new in 48 hours. Choices are remembered in the browser; **Clear filters** clears them.
- Pay and work mode filters leave out jobs that don't state them, and the count says how many. Pay is compared in each job's own currency, top of the range, with hourly pay counted as 2,080 hours a year.
- Rows: match, title, your mark, company, pay, work mode, place and age. Sort by best match or newest.
- The selected job: **Open posting**, **Applied**, **Save** and **Hide**, the score and its parts, why you fit, gaps, next steps, and the facts led by pay and work mode. After Open posting it asks "Did you apply?"
- Your marks: Applied rows show the date and stay in the list until you tick **Hide applied**. Hide removes the row, with an Undo. To bring a job back, select it under My jobs → Hidden and press Hide again.
- Moving around: arrow keys move through the list. On a phone, Previous and Next step through the jobs and Back closes the detail. `#jobs/<key>` links a job.
- Applicants: shown when a source provides it, otherwise "Not available" (public job APIs don't expose this)
- The skills most often asked for and, with a resume, the skills to add across the listed jobs, and which sources were read in the 6 hours up to the last scan

Role comes from the job title; a generic title like "Software Engineer" falls back to its skills. Seniority comes from the title too, and a title with no level word reads as Mid.

Job type comes from the posting's own field where the site has one (Lever, Ashby, SmartRecruiters, Workable, Workday, Amazon and most feeds). Otherwise it's read from the title or a plain statement in the description; if neither says, it shows "Not specified".

Pay comes from the posting's own field on Lever and Ashby, otherwise from the description. Work mode comes from the posting's own field (Lever, Ashby, SmartRecruiters), then the title and location, then a plain statement in the description. Workday only says "30+ days" for older postings, so those show as "30+ days ago".

## Sources (332)

| Kind | Count | How it's read |
|---|---|---|
| Greenhouse company boards | 154 | public job board API |
| Ashby company boards | 116 | public posting API |
| Lever company boards | 29 | public postings API |
| Workday career sites (NVIDIA, Salesforce, Capital One, TD, BMO…) | 15 | the career site's own JSON search, top 200 "software engineer" results |
| SmartRecruiters (ServiceNow, Canva, Freshworks…) | 7 | public postings API |
| Workable | 2 | public widget API |
| Job boards: Remotive, RemoteOK, Jobicy, Himalayas, We Work Remotely, Working Nomads, The Muse, HN "Who is hiring", Amazon Jobs | 9 | public APIs / RSS |

LinkedIn, Indeed and Glassdoor aren't polled: they have no public jobs API and their terms forbid scraping.

## Files

| Path | What it is |
|---|---|
| `fetch_jobs.py` | Polls the sources, applies the rules, writes `docs/jobs.js` and `docs/scan.json` |
| `extract.py` | Reads a posting's required skills, years, pay, work mode and degree |
| `scan_state.py` | What one scan keeps from the last: first-seen dates, Workday dates, slow-source rows |
| `config.json` / `keywords.json` | The rules and the skill dictionary |
| `docs/index.html`, `docs/app.css`, `docs/app.js` | The app (plain HTML, CSS and JavaScript, no build step) |
| `docs/match.js`, `docs/resume.js` | Scoring, and reading a resume |
| `docs/board.js`, `docs/tracker.js`, `docs/scan.js` | The job list and detail, Saved / Applied / Hidden, and the Scan now button |
| `docs/jobs.js`, `docs/scan.json` | Job data from the last run, and its timestamp and count |
| `worker/scan.js` | Cloudflare Worker behind Scan now |
| `.github/workflows/fetch-jobs.yml` | The 6-hourly schedule |
| `test_fetch_jobs.py`, `tests/` | Python and JavaScript tests |
| `CLAUDE.md` | Notes for working on the project with Claude Code |

## Changing the rules

| File | What to change |
|---|---|
| `config.json` | Allowed locations, max job age (90 days), title include/exclude patterns, boards and feeds, and `scan_url` |
| `keywords.json` | The skill dictionary used for both job postings and resumes. Add a skill and its aliases; `=Alias` is case-sensitive, `re:` is a raw regex (keep it valid in both Python and JavaScript). |

To add a company, find its careers page and put the slug under the matching platform in `config.json` → `boards` (the help text there shows each URL pattern). The app's Sources page lists any source that couldn't be read on the last run.

## Setup: Pages and Scan now

The repo owner does these once. Each needs the owner's own accounts.

1. Make the repo public. That gives free Pages and free Actions. Your commit email becomes visible.
2. In Settings → Pages, choose branch `main`, folder `/docs`. Do this before merging: the workflow's last step asks Pages to rebuild, and it fails while Pages is off.
3. Create a free Cloudflare account and a Worker named `wradar-scan`. Paste in `worker/scan.js`.
4. Create a fine-grained GitHub token with access to `wradar` only, Actions read and write, and a 366-day expiry. Add it to the Worker as the secret `GITHUB_TOKEN`, then deploy.
5. Put the Worker URL in `config.json` → `scan_url` and push to `main`. That push runs the workflow, which writes the URL into `docs/jobs.js`, and the button appears.

The Worker URL is not a secret: it's in `config.json` and in the page. The token is. It lives only as a Worker secret, never in this repo or the browser. When it expires, Scan now shows "Scan didn't start" until you add a new one.

The Worker accepts POST only from `https://sudddy.github.io`. It reads the latest Fetch jobs run: if one is running it says so, if the last one started under an hour ago it returns the time left, and otherwise it starts the workflow on `main`. On a fork, change `SITE` and `WORKFLOW` at the top of `worker/scan.js`.

## Tests

```
python3 -m unittest
node --test tests/*.test.js
```

Keep the glob: Node 22 fails on a bare `tests/`. The workflow runs the Python tests before every fetch and the JavaScript tests after it, before the commit, because they read the fresh `docs/jobs.js`. If the JavaScript tests fail, that scan isn't published.
