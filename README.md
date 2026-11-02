# Job Radar

Finds software engineering jobs in the US, Canada and remote, for every technology. Anyone can add their own resume in the dashboard to see how well each job matches them.

No AI runs here. A Python script (standard library only) polls public job sources on a schedule and applies fixed rules.

## Using the app

Open **https://sudddy.github.io/job-radar/** (GitHub Pages). It has four sections:

- **Jobs:** filters on the left, the job list in the middle, the selected job on the right with its link, your match and the skills you have or are missing.
- **My resume:** add your resume, fix the skills it found, and see the skills jobs ask for most that you don't list, plus your best matches.
- **Insights:** most-requested skills and how the jobs break down by role, seniority, location and type.
- **Sources:** how jobs are found and which of the 332 sources were read on the last run.

Job data refreshes every 6 hours via GitHub Actions. To refresh now: Actions tab → **Fetch jobs** → **Run workflow**. Editing `config.json` or `keywords.json` also triggers a refresh.

To run it on your own machine instead: `python3 fetch_jobs.py`, then open `docs/index.html`.

## Your resume

Click **Choose file** (PDF, Word .docx or text) or paste the text. The dashboard reads it in the browser, finds the skills it lists and the years of experience, and scores every job against them. Nothing is uploaded: only the file name, the detected skills and the years are remembered, in that browser. **Edit skills** adds or removes skills by hand; **Replace** and **Remove** do what they say. Without a resume every filter still works; the match columns just stay empty.

PDF and Word files are read with PDF.js and Mammoth, loaded from cdnjs the first time they're needed, so that step needs an internet connection. Pasting text works offline.

## What it shows

- Filters: role (Backend, Full stack, Frontend, Data, DevOps / SRE…), seniority (Junior, Mid, Senior, Staff+), technologies (pick any or all, e.g. Java, Node.js), US / Canada / Remote, Full-time / Part-time / Contract, minimum resume match, source, new only. Choices are remembered in the browser; Reset filters clears them.
- Match score: share of the skills a posting names that are also on your resume
- The skills you have and the ones you're missing per job, plus a short fit summary (skills covered, years asked vs. your years, gaps to address)
- Applicants: shown when a source provides it, otherwise "Not available" (public job APIs don't expose this)
- The skills most often asked for (or, with a resume, most often missing) across the listed jobs, and which sources were read on the last run

Role and seniority come from the job title; a title like "Software Engineer, Payments" falls back to its skills.

Job type comes from the posting's own field where the site has one (Lever, Ashby, SmartRecruiters, Workable, Workday, Amazon and most feeds). Otherwise it's read from the title or a plain statement in the description; if neither says, it shows "Not specified".

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
| `fetch_jobs.py` | Polls the sources, applies the rules, writes `docs/jobs.js` |
| `config.json` / `keywords.json` | The rules and the skill dictionary |
| `docs/index.html`, `docs/app.css`, `docs/app.js` | The app (plain HTML, CSS and JavaScript, no build step) |
| `docs/jobs.js` | Job data from the last run |
| `.github/workflows/fetch-jobs.yml` | The 6-hourly schedule |

## Changing the rules

| File | What to change |
|---|---|
| `config.json` | Allowed locations, max job age, title include/exclude patterns, boards and feeds |
| `keywords.json` | The skill dictionary used for both job postings and resumes. Add a skill and its aliases; `=Alias` is case-sensitive, `re:` is a raw regex (keep it valid in both Python and JavaScript). |

To add a company, find its careers page and put the slug under the matching platform in `config.json` → `boards` (the help text there shows each URL pattern). The dashboard's Sources panel lists any source that couldn't be read on the last run.

## Tests

`python3 -m unittest`
