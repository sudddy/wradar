# Job Radar

Finds software engineering jobs in the US, Canada and remote, keeps only the ones that fit the resume, and shows how well each one matches.

No AI runs here. A Python script (standard library only) polls public job boards on a schedule and applies fixed rules.

## Viewing the dashboard

- **On GitHub:** data refreshes every 6 hours via GitHub Actions. Pull the repo and open `docs/index.html` in a browser.
- **GitHub Pages (optional):** Settings → Pages → Deploy from branch `main`, folder `/docs`. Needs a public repo or a paid GitHub plan. The page includes the candidate's name and skills, so think before making it public.
- **Locally:** `python3 fetch_jobs.py`, then open `docs/index.html`.

Refresh on demand: Actions tab → **Fetch jobs** → **Run workflow**. Editing `config.json`, `keywords.json` or `resume.txt` also triggers a refresh.

## What it shows

- Match score: share of the skills a posting names that are also on the resume
- Matched and missing keywords per job, plus a short fit summary (skills covered, years asked vs. years on the resume, gaps to address)
- Applicants: shown when a source provides it, otherwise "Not available" (public board APIs don't expose this)
- The skills most often missing across all listed jobs, and which sources were read on the last run

## Changing the rules

| File | What to change |
|---|---|
| `resume.txt` | Replace with another resume (plain text). Skills are detected from it automatically. |
| `config.json` | Candidate name, years of experience, allowed locations, max job age, minimum matched keywords, title include/exclude patterns, companies and feeds |
| `keywords.json` | The skill dictionary. Add a skill and its aliases; `=Alias` is case-sensitive, `re:` is a raw regex. |

Companies are career-board slugs (the part after `boards.greenhouse.io/`, `jobs.lever.co/` or `jobs.ashbyhq.com/`). The script tries all three, so you only need the slug. The dashboard's Sources panel lists any that couldn't be read.

## Sources

- Company boards on Greenhouse, Lever and Ashby (public posting APIs)
- Remotive, RemoteOK and Jobicy remote-job feeds (please keep the links back to them)

LinkedIn and Indeed aren't polled: they have no public jobs API and their terms forbid scraping.

## Tests

`python3 -m unittest`
