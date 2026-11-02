# Job Radar

Finds software engineering jobs in the US, Canada and remote, for every technology, and shows how well each one matches the resume.

No AI runs here. A Python script (standard library only) polls public job sources on a schedule and applies fixed rules.

## Viewing the dashboard

- **On GitHub:** data refreshes every 6 hours via GitHub Actions. Pull the repo and open `docs/index.html` in a browser.
- **GitHub Pages (optional):** Settings → Pages → Deploy from branch `main`, folder `/docs`. Needs a public repo or a paid GitHub plan. The page includes the candidate's name and skills, so think before making it public.
- **Locally:** `python3 fetch_jobs.py`, then open `docs/index.html`.

Refresh on demand: Actions tab → **Fetch jobs** → **Run workflow**. Editing `config.json`, `keywords.json` or `resume.txt` also triggers a refresh.

## What it shows

- Filters: role (Backend, Full stack, Frontend, Data, DevOps / SRE…), seniority (Junior, Mid, Senior, Staff+), technologies (pick any or all, e.g. Java, Node.js), US / Canada / Remote, Full-time / Part-time / Contract, minimum resume match, source, new only. Choices are remembered in the browser; Reset filters clears them.
- Match score: share of the skills a posting names that are also on the resume
- Matched and missing keywords per job, plus a short fit summary (skills covered, years asked vs. years on the resume, gaps to address)
- Applicants: shown when a source provides it, otherwise "Not available" (public job APIs don't expose this)
- The skills most often missing across the listed jobs, and which sources were read on the last run

Role and seniority come from the job title; a title like "Software Engineer, Payments" falls back to its skills. To only collect jobs that fit the resume, set `min_matched_keywords` in `config.json` (0 keeps every technology).

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

## Changing the rules

| File | What to change |
|---|---|
| `resume.txt` | Replace with another resume (plain text). Skills are detected from it automatically. |
| `config.json` | Candidate name, years of experience, allowed locations, max job age, minimum matched keywords, title include/exclude patterns, boards and feeds |
| `keywords.json` | The skill dictionary. Add a skill and its aliases; `=Alias` is case-sensitive, `re:` is a raw regex. |

To add a company, find its careers page and put the slug under the matching platform in `config.json` → `boards` (the help text there shows each URL pattern). The dashboard's Sources panel lists any source that couldn't be read on the last run.

## Tests

`python3 -m unittest`
