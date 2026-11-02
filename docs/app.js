"use strict";
// Job Radar: jobs come from jobs.js (written by fetch_jobs.py); resume matching happens here, in the browser.
const D = window.JOB_DATA;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 864e5;
const ago = iso => { if (!iso) return "—"; const d = (Date.now() - new Date(iso)) / DAY; return d < 1 ? "today" : d < 2 ? "yesterday" : Math.floor(d) + "d ago"; };
const isNew = j => Date.now() - new Date(j.first_seen) < 2 * DAY;
const tier = s => s == null ? "low" : s >= 70 ? "strong" : s >= 50 ? "good" : "low";
const list = a => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const store = {  // per-browser memory; the app works the same without it
  get: k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const wide = () => matchMedia("(min-width: 761px)").matches;
const LEVELS = ["Junior", "Mid", "Senior", "Staff+"];
const DEFAULTS = { q: "", role: "", level: "", type: "", where: "", min: 0, src: "", fresh: false, sort: "score", techs: [], mode: "any" };
const state = { ...DEFAULTS, ...(store.get("job-radar-filters") || {}), limit: 50, sel: null };
let me = store.get("job-radar-resume");  // { name, skills, years }; the resume text itself is never kept
let pasting = false, status = "", reads = 0;

// ---- Resume reading and matching ----
const rxEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SKILLS = Object.entries(D?.keywords || {}).map(([name, aliases]) => [name, aliases.map(a => a.startsWith("re:")
  ? new RegExp(a.slice(3))
  : new RegExp("(?<![A-Za-z0-9])" + rxEscape(a.replace(/^=/, "")) + "(?![A-Za-z0-9+#])", a.startsWith("=") ? "" : "i"))]);
const ALL_SKILLS = SKILLS.map(([n]) => n);
const findSkill = v => ALL_SKILLS.find(x => x.toLowerCase() === v.trim().toLowerCase());
const detectSkills = text => SKILLS.filter(([, rxs]) => rxs.some(r => r.test(text))).map(([n]) => n);
const detectYears = text => { const m = text.match(/(\d{1,2})\s*\+?\s*years?(?:\s+of)?(?:\s+[\w\/&-]+){0,5}?\s+experience/i); return m ? +m[1] : null; };
const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
const loadScript = src => new Promise((ok, fail) => {
  if (document.querySelector(`script[src="${src}"]`)) return ok();
  document.head.append(Object.assign(document.createElement("script"), { src, onload: ok,
    onerror: () => fail(new Error("Couldn't load the file reader. Check the internet connection, or paste the text instead.")) }));
});

async function readFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    // Loading the worker as a plain script lets PDF.js run on the main thread, so no worker file is needed.
    await loadScript(CDN + "pdf.js/3.11.174/pdf.min.js");
    await loadScript(CDN + "pdf.js/3.11.174/pdf.worker.min.js");
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map(t => t.str).join(" ") + "\n";
    return text;
  }
  if (ext === "docx") {
    await loadScript(CDN + "mammoth/1.6.0/mammoth.browser.min.js");
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  if (["txt", "md", "text"].includes(ext) || file.type.startsWith("text/")) return file.text();
  throw new Error("That file type isn't supported. Use a PDF, Word (.docx) or text file, or paste the text.");
}

function useResume(name, text) {
  const skills = detectSkills(text);
  if (!skills.length) { status = "No skills were recognized in that resume. Check it's the right file, or paste the text."; return refresh(); }
  me = { name, skills, years: detectYears(text) };
  status = ""; pasting = false; state.sort = "score";
  store.set("job-radar-resume", me);
  refresh();
}

async function onFile(file) {
  if (!file) return;
  const read = ++reads;  // if another file is picked meanwhile, only the latest one counts
  status = `Reading ${file.name}…`; renderMe();
  try { const text = await readFile(file); if (read === reads) useResume(file.name, text); }
  catch (e) { if (read === reads) { status = e.message || "Couldn't read that file. Try a PDF, .docx or .txt, or paste the text."; renderMe(); } }
}

function saveMe() { store.set("job-radar-resume", me); refresh(); }

function score() {
  const mine = new Set(me?.skills || []);
  D.jobs.forEach(j => {
    j.matched = j.skills.filter(k => mine.has(k));
    j.missing = j.skills.filter(k => !mine.has(k));
    j.score = !me ? null : j.skills.length ? Math.round(100 * j.matched.length / j.skills.length) : 0;
  });
}

function why(j) {
  const n = j.matched.length, t = j.skills.length;
  if (!t) return "This posting doesn't name any skills Job Radar recognizes, so it can't be scored. Open it to read the details.";
  const label = { strong: "Strong fit", good: "Good fit", low: "Stretch" }[tier(j.score)];
  let s = `<b class="${tier(j.score)}">${label}.</b> Your resume covers ${n} of the ${t} skills this posting names`
    + (n ? `, including ${esc(list(j.matched.slice(0, 4)))}. ` : ". ");
  if (j.years_required == null) s += "No explicit years-of-experience requirement found. ";
  else if (!me.years) s += `It asks for ${j.years_required}+ years. `;
  else if (me.years >= j.years_required) s += `It asks for ${j.years_required}+ years; you have ${me.years}+. `;
  else s += `It asks for ${j.years_required}+ years against your ${me.years}+, so lead with scope and impact. `;
  return s + (j.missing.length ? `To close the gap, add ${esc(list(j.missing.slice(0, 3)))} to your resume if you've used them, or cover them in a note.`
                               : "No skill gaps against this posting.");
}

// ---- Jobs view ----
function hasTech(j) {
  if (!state.techs.length) return true;
  return state.mode === "all" ? state.techs.every(t => j.skills.includes(t)) : state.techs.some(t => j.skills.includes(t));
}

function filtered(withTech = true) {
  const q = state.q.toLowerCase();
  const out = D.jobs.filter(j => (!me || j.score >= state.min)
    && (!withTech || hasTech(j))
    && (!state.role || j.role === state.role)
    && (!state.level || j.level === state.level)
    && (!state.where || j.where.includes(state.where))
    && (!state.type || j.type === state.type)
    && (!state.src || j.source === state.src)
    && (!state.fresh || isNew(j))
    && (!q || [j.title, j.company, j.location, ...j.skills].join(" ").toLowerCase().includes(q)));
  const newest = (a, b) => new Date(b.posted || b.first_seen) - new Date(a.posted || a.first_seen);
  return out.sort(me && state.sort === "score" ? (a, b) => b.score - a.score || b.matched.length - a.matched.length || newest(a, b) : newest);
}

const chips = (a, cls = "") => a.map(k => `<span class="chip ${cls}">${esc(k)}</span>`).join("") || '<span class="na">None</span>';

function item(j) {
  return `<li><button type="button" class="jitem" data-i="${j.i}" aria-current="${state.sel === j.i}">
    <span class="score ${tier(j.score)}" aria-label="${me ? j.score + "% match" : "No resume yet"}">${me ? j.score + "%" : "—"}</span>
    <span class="jbody"><b>${esc(j.title)}${isNew(j) ? '<em class="new">New</em>' : ""}</b>
      <span class="co">${esc(j.company)}</span>
      <span class="jmeta">${esc(j.where.join(" / "))} · ${esc(j.level)} ${esc(j.role)} · ${esc(j.type)} · ${ago(j.posted)}</span></span>
  </button></li>`;
}

function detail(j) {
  if (!j) return '<div class="empty">No job selected. Pick one from the list.</div>';
  const link = /^https?:\/\//.test(j.url)
    ? `<a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>`
    : '<span class="na">No link for this posting</span>';
  const pill = (label, v) => `<span class="pill">${label} <b>${v}</b></span>`;
  return `<button type="button" class="btn ghost back" id="back">← Back to jobs</button>
    <div class="dhead"><h2 id="dtitle">${esc(j.title)}</h2><p>${esc(j.company)}</p></div>
    <div class="pills">${pill("Where", esc(j.where.join(" / ")))}${pill("Type", esc(j.type))}${pill("Level", esc(j.level))}${pill("Role", esc(j.role))}
      ${pill("Posted", ago(j.posted))}${pill("Applicants", j.applicants == null ? "Not available" : esc(j.applicants))}${pill("Source", esc(j.source))}</div>
    <div class="row">${link}</div>
    ${me ? `<div class="fit"><div class="score ${tier(j.score)}">${j.score}%</div><p>${why(j)}</p></div>
        <div><h3>You have (${j.matched.length})</h3><div class="chips">${chips(j.matched, "hit")}</div></div>
        <div><h3>Missing (${j.missing.length})</h3><div class="chips">${chips(j.missing, "miss")}</div></div>`
      : `<div class="nudge"><span>Add your resume to see how well you match this job.</span><a class="btn" href="#resume">Add resume</a></div>
        <div><h3>Skills in this posting (${j.skills.length})</h3><div class="chips">${chips(j.skills)}</div></div>`}
    <div><h3>Location</h3><p>${esc(j.location || "Not listed")}${j.years_required ? ` · asks for ${j.years_required}+ years` : ""}</p></div>`;
}

function activeFilters() {
  return ["q", "role", "level", "type", "where", "src"].filter(k => state[k]).length + (state.fresh ? 1 : 0)
    + (state.min && me ? 1 : 0) + (state.techs.length ? 1 : 0);
}

function renderTechs() {
  const counts = {};
  filtered(false).forEach(j => j.skills.forEach(k => counts[k] = (counts[k] || 0) + 1));
  const shown = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 20);
  state.techs.forEach(t => shown.includes(t) || shown.unshift(t));
  $("#techs").innerHTML = shown.map(k => `<button type="button" class="tchip" data-k="${esc(k)}" aria-pressed="${state.techs.includes(k)}">${esc(k)}<span>${counts[k] || 0}</span></button>`).join("");
}

function renderJobs() {
  const { limit, sel, ...keep } = state;
  store.set("job-radar-filters", keep);
  renderTechs();
  const jobs = filtered();
  if (!jobs.some(j => j.i === state.sel)) state.sel = wide() && jobs.length ? jobs[0].i : null;
  const n = activeFilters();
  $("#nfilters").textContent = n ? `(${n})` : "";
  $("#minlabel").classList.toggle("off", !me);
  $("#min").disabled = !me;
  $("#nudge").innerHTML = me ? "" : '<div class="nudge"><span>Add your resume to see your match on every job.</span><a class="btn" href="#resume">Add resume</a></div>';
  $("#count").textContent = (jobs.length !== D.jobs.length ? `${jobs.length} of ${plural(D.jobs.length, "job")}` : plural(jobs.length, "job"))
    + (state.techs.length ? ` · ${state.mode === "all" ? "all of" : "any of"} ${state.techs.join(", ")}` : "");
  $("#list").innerHTML = jobs.slice(0, state.limit).map(item).join("") || '<li class="empty">No jobs match these filters. Try removing one.</li>';
  $("#more").hidden = jobs.length <= state.limit;
  $("#detail").innerHTML = detail(D.jobs[state.sel]);
}

function openJob(i) {
  state.sel = i;
  renderJobs();
  $("#jobs").classList.add("showing");
  if (!wide()) $("#detail").scrollTop = 0;
  $("#detail").focus({ preventScroll: wide() });
}

// ---- My resume view ----
function renderMe() {
  const err = status && !status.startsWith("Reading");
  const statusLine = status ? `<p class="status${err ? " err" : ""}" role="status">${esc(status)}</p>` : "";
  if (!me) {
    $("#me").innerHTML = `<h2>Add your resume</h2>
      <div class="drop" id="drop">
        <p>Drop a PDF, Word (.docx) or text file here, or choose one.</p>
        <div class="row"><button class="btn" type="button" id="pick">Choose file</button>
          <button class="linkbtn" type="button" id="pastebtn">${pasting ? "Hide paste box" : "Paste text instead"}</button></div>
        ${pasting ? `<textarea id="pastetext" aria-label="Resume text" placeholder="Paste your resume text here"></textarea>
          <button class="btn ghost" type="button" id="usepaste">Use this text</button>` : ""}
        ${statusLine}
      </div>`;
    return;
  }
  $("#me").innerHTML = `<div class="row" style="justify-content:space-between">
      <div><h2>${esc(me.name)}</h2><span class="mestats">${plural(me.skills.length, "skill")} · ${me.years ? me.years + "+ years" : "years not found"}</span></div>
      <div class="row"><button class="btn ghost" type="button" id="pick">Replace</button><button class="linkbtn" type="button" id="forget">Remove</button></div>
    </div>
    ${statusLine}
    <div class="row"><label>Years of experience <input type="number" id="years" min="0" max="50" value="${me.years ?? ""}"></label>
      <label>Add a skill <input id="addskill" list="techlist" placeholder="e.g. Go"></label></div>
    <div><h3 class="flabel" style="margin:0 0 8px">Skills found (click × to remove)</h3>
      <div class="chips">${me.skills.map(k => `<span class="xchip">${esc(k)}<button type="button" data-k="${esc(k)}" aria-label="Remove ${esc(k)}">×</button></span>`).join("")}</div></div>`;
}

function bars(entries, empty = "Nothing to show yet.") {
  const max = entries[0]?.[1] || 1;
  return entries.map(([k, n]) => `<li>${esc(k)}<span>${n}</span><i style="--w:${Math.round(100 * n / max)}%"></i></li>`).join("")
    || `<li class="na">${empty}</li>`;
}
const tally = (jobs, pick) => {
  const t = {};
  jobs.forEach(j => [].concat(pick(j)).forEach(k => t[k] = (t[k] || 0) + 1));
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
};

function renderResume() {
  renderMe();
  $("#mygaps").className = "bars gap";
  $("#mygaps").innerHTML = me ? bars(tally(D.jobs, j => j.missing).slice(0, 10)) : '<li class="na">Add your resume to see this.</li>';
  const best = me ? [...D.jobs].sort((a, b) => b.score - a.score || b.matched.length - a.matched.length).slice(0, 6) : [];
  $("#mybest").innerHTML = best.map(j => `<li><button type="button" data-i="${j.i}"><span class="score ${tier(j.score)}">${j.score}%</span>
      <span><b>${esc(j.title)}</b><small>${esc(j.company)} · ${esc(j.where.join(" / "))}</small></span></button></li>`).join("")
    || '<li class="na">Add your resume to see this.</li>';
}

// ---- Insights view ----
function renderInsights() {
  const scores = D.jobs.map(j => j.score).filter(s => s != null).sort((a, b) => a - b);
  const tiles = [
    [D.jobs.length, "jobs found"],
    [D.jobs.filter(isNew).length, "new in the last 48h"],
    [me ? D.jobs.filter(j => j.score >= 70).length : "—", "strong fits for you (70%+)"],
    [scores.length ? scores[Math.floor(scores.length / 2)] + "%" : "—", "your median match"],
  ];
  $("#tiles").innerHTML = tiles.map(([v, l]) => `<div class="tile"><b>${v}</b><small>${l}</small></div>`).join("");
  const card = (title, note, entries, cls = "") => `<section class="card"><h2>${title}</h2><p class="note">${note}</p><ol class="bars ${cls}">${bars(entries)}</ol></section>`;
  $("#charts").innerHTML = [
    card("Most-requested skills", "Share of jobs naming each skill.", tally(D.jobs, j => j.skills).slice(0, 12)),
    me ? card("Skills you're missing most", "Jobs that name a skill your resume doesn't list.", tally(D.jobs, j => j.missing).slice(0, 12), "gap")
       : card("Skills you're missing most", "Add your resume to see this.", []),
    card("Jobs by role", "From the job title, or its skills when the title is generic.", tally(D.jobs, j => j.role)),
    card("Jobs by seniority", "From the job title.", LEVELS.map(l => [l, D.jobs.filter(j => j.level === l).length]).filter(([, n]) => n)),
    card("Jobs by location", "A remote job open to the US and Canada counts in each.", tally(D.jobs, j => j.where)),
    card("Jobs by type", "From the posting's own field, its title, or a plain statement in the text.", tally(D.jobs, j => j.type)),
  ].join("");
}

// ---- Sources view ----
function renderSources() {
  const rules = D.rules || { max_age_days: 30 };
  const steps = [
    [`Poll ${D.sources.length} sources`, "Every 6 hours a scheduled job reads company career boards (Greenhouse, Ashby, Lever, Workday, SmartRecruiters, Workable) and job boards such as The Muse, Himalayas and HN Who's Hiring."],
    ["Apply the rules", `Keeps software engineering roles in the US, Canada or remote posted in the last ${rules.max_age_days} days, and tags each with its skills, role, seniority and job type.`],
    ["Match your resume", "Add your resume and every job gets a match %, the skills you have and the ones you're missing. It all happens in your browser."],
    ["Pick what you want", "Filter by role, seniority, technology, location or job type. Your resume and filters are remembered on this device."],
  ];
  $("#steps").innerHTML = steps.map(([t, d]) => `<li><b>${esc(t)}</b>${esc(d)}</li>`).join("");
  const ok = D.sources.filter(s => s.ok), bad = D.sources.filter(s => !s.ok), kinds = {};
  ok.forEach(s => kinds[s.kind] = (kinds[s.kind] || 0) + 1);
  $("#srcsum").textContent = `${ok.length} of ${D.sources.length} read on the last run: `
    + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ") + ". Jobs kept / seen per source:";
  $("#srcok").innerHTML = ok.map(s => `<li><a href="${/^https?:\/\//.test(s.url) ? esc(s.url) : "#"}" target="_blank" rel="noopener">${esc(s.name)}</a><span>${s.kept}/${s.seen}</span></li>`).join("");
  $("#srcbadwrap").hidden = !bad.length;
  $("#srcbadwrap summary").textContent = `${bad.length} couldn't be read`;
  $("#srcbad").innerHTML = bad.map(s => `<li>${esc(s.name)}<span>${esc(s.error)}</span></li>`).join("");
}

// ---- Routing ----
const VIEWS = { jobs: renderJobs, resume: renderResume, insights: renderInsights, sources: renderSources };
const current = () => VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "jobs";
function route() {
  const v = current();
  Object.keys(VIEWS).forEach(x => { $("#view-" + x).hidden = x !== v; });
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-current", a.getAttribute("href") === "#" + v ? "page" : "false"));
  VIEWS[v]();
}
function refresh() { score(); route(); }

// ---- Wiring ----
function init() {
  if (!D) {
    $("#list").innerHTML = '<li class="empty">No job data yet. Run <code>python3 fetch_jobs.py</code>, then reload.</li>';
    return;
  }
  D.jobs.forEach((j, i) => { j.i = i; });
  $("#updated").textContent = `Updated ${ago(D.generated_at)}`;
  $("#updated").title = new Date(D.generated_at).toLocaleString();
  [...new Set(D.jobs.map(j => j.source))].sort().forEach(s => $("#src").insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`));
  tally(D.jobs, j => j.role).forEach(([r, n]) => $("#role").insertAdjacentHTML("beforeend", `<option value="${esc(r)}">${esc(r)} (${n})</option>`));
  LEVELS.filter(l => D.jobs.some(j => j.level === l)).forEach(l => $("#level").insertAdjacentHTML("beforeend", `<option>${l}</option>`));
  $("#techlist").innerHTML = ALL_SKILLS.map(k => `<option value="${esc(k)}"></option>`).join("");

  // Filters
  const press = (group, v) => $(group).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v));
  const sync = () => {
    ["q", "role", "level", "type", "src", "sort"].forEach(k => { $("#" + k).value = state[k]; state[k] = $("#" + k).value; });
    $("#min").value = state.min; $("#minv").textContent = state.min + "%";
    $("#fresh").checked = state.fresh;
    press("#where", state.where); press("#mode", state.mode);
  };
  const set = (k, v) => { state[k] = v; state.limit = 50; renderJobs(); };
  $("#q").addEventListener("input", e => set("q", e.target.value));
  ["role", "level", "type", "src", "sort"].forEach(k => $("#" + k).addEventListener("change", e => set(k, e.target.value)));
  $("#min").addEventListener("input", e => { $("#minv").textContent = e.target.value + "%"; set("min", +e.target.value); });
  $("#fresh").addEventListener("change", e => set("fresh", e.target.checked));
  $("#where").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { press("#where", b.dataset.v); set("where", b.dataset.v); } });
  $("#mode").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { press("#mode", b.dataset.v); set("mode", b.dataset.v); } });
  $("#techs").addEventListener("click", e => {
    const b = e.target.closest(".tchip"); if (!b) return;
    set("techs", state.techs.includes(b.dataset.k) ? state.techs.filter(t => t !== b.dataset.k) : [...state.techs, b.dataset.k]);
  });
  const addTech = () => { const k = findSkill($("#techq").value); if (k) { $("#techq").value = ""; if (!state.techs.includes(k)) set("techs", [...state.techs, k]); } };
  $("#techq").addEventListener("change", addTech);
  $("#techq").addEventListener("keydown", e => { if (e.key === "Enter") addTech(); });
  $("#reset").addEventListener("click", () => { Object.assign(state, DEFAULTS, { techs: [] }); sync(); set("limit", 50); });
  $("#filtersbtn").addEventListener("click", e => {
    const open = $("#rail").classList.toggle("open");
    e.currentTarget.setAttribute("aria-expanded", open);
  });
  $("#more").addEventListener("click", () => { state.limit += 50; renderJobs(); });
  $("#list").addEventListener("click", e => { const b = e.target.closest(".jitem"); if (b) openJob(+b.dataset.i); });
  $("#detail").addEventListener("click", e => { if (e.target.id === "back") { $("#jobs").classList.remove("showing"); $(`.jitem[data-i="${state.sel}"]`)?.focus(); } });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#jobs").classList.contains("showing")) $("#jobs").classList.remove("showing"); });

  // My resume (re-rendered, so listen on the container)
  $("#file").addEventListener("change", e => { onFile(e.target.files[0]); e.target.value = ""; });
  $("#me").addEventListener("click", e => {
    const id = e.target.id;
    if (id === "pick") $("#file").click();
    if (id === "pastebtn") { pasting = !pasting; renderMe(); }
    if (id === "usepaste") { const t = $("#pastetext").value; t.trim() ? useResume("Pasted resume", t) : (status = "Paste your resume text first.", renderMe()); }
    if (id === "forget") { me = null; status = ""; store.set("job-radar-resume", null); refresh(); }
    const k = e.target.closest(".xchip button")?.dataset.k;
    if (k) { me.skills = me.skills.filter(s => s !== k); saveMe(); }
  });
  $("#me").addEventListener("change", e => {
    if (e.target.id === "years") { me.years = +e.target.value || null; saveMe(); }
    if (e.target.id === "addskill") {
      const k = findSkill(e.target.value);
      if (k && !me.skills.includes(k)) { me.skills = ALL_SKILLS.filter(s => s === k || me.skills.includes(s)); saveMe(); $("#addskill")?.focus(); }
    }
  });
  $("#me").addEventListener("dragover", e => { if (!me) { e.preventDefault(); $("#drop")?.classList.add("over"); } });
  $("#me").addEventListener("dragleave", () => $("#drop")?.classList.remove("over"));
  $("#me").addEventListener("drop", e => { if (!me) { e.preventDefault(); $("#drop")?.classList.remove("over"); onFile(e.dataTransfer.files[0]); } });
  $("#mybest").addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (b) { state.sel = +b.dataset.i; $("#jobs").classList.add("showing"); location.hash = "#jobs"; } });

  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
  sync();
  refresh();
}
init();
