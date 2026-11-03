// Scan now relay: starts the Fetch jobs workflow for the site, at most once an hour.
// GITHUB_TOKEN is a Worker secret and goes to GitHub only.
const SITE = "https://sudddy.github.io";
const WORKFLOW = "https://api.github.com/repos/sudddy/wradar/actions/workflows/fetch-jobs.yml";
const MINUTE = 6e4, HOUR = 36e5;
const CORS = { "Access-Control-Allow-Origin": SITE, "Access-Control-Allow-Methods": "POST" };
let nextAt = 0, last = { at: -Infinity };  // in memory, so GitHub is asked about runs at most once a minute, however many clicks come

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const cooldown = () => reply(429, { state: "cooldown", retry_after: Math.ceil((nextAt - Date.now()) / 1000) });
const github = (path, token, init) => fetch(WORKFLOW + path, { ...init, headers: {
  Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "wradar-scan",
} }).catch(() => ({ ok: false }));

export default {
  async fetch(request, env) {
    if (request.headers.get("Origin") !== SITE) return reply(403, { state: "error" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return reply(405, { state: "error" });
    if (Date.now() - last.at >= MINUTE) {
      const list = await github("/runs?per_page=1", env.GITHUB_TOKEN);
      if (!list.ok) return reply(502, { state: "error" });
      last = { at: Date.now(), run: (await list.json()).workflow_runs[0] };
    }
    const { run } = last;
    if (run && run.status !== "completed") return reply(200, { state: "running", since: run.created_at });
    if (run) nextAt = Math.max(nextAt, Date.parse(run.created_at) + HOUR);  // kept from a dispatch in case GitHub lists the run late
    if (Date.now() < nextAt) return cooldown();
    const go = await github("/dispatches", env.GITHUB_TOKEN, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (!go.ok) return reply(502, { state: "error" });
    nextAt = Date.now() + HOUR;
    last = { at: Date.now(), run: { status: "queued", created_at: new Date().toISOString() } };  // the run just started, until GitHub lists it
    return reply(202, { state: "started" });
  },
};
