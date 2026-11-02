"use strict";
// wradar: jobs come from jobs.js (written by fetch_jobs.py); resume matching happens here, in the browser.
const D = window.JOB_DATA;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 864e5;
const age = j => (Date.now() - new Date(j.posted || j.first_seen)) / DAY;
const ago = iso => { if (!iso) return "date unknown"; const d = (Date.now() - new Date(iso)) / DAY; return d < 1 ? "today" : d < 2 ? "yesterday" : Math.floor(d) + " days ago"; };
const isNew = j => Date.now() - new Date(j.first_seen) < 2 * DAY;
const tier = s => s == null ? "none" : s >= 70 ? "hot" : s >= 50 ? "warm" : "cool";
const TIER = { hot: "Hot match", warm: "Warm match", cool: "Cool match" };
const list = a => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
const plural = (n, w, ws = w + "s") => `${n.toLocaleString()} ${n === 1 ? w : ws}`;
const store = {  // per-browser memory; the app works the same without it
  get: k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const wide = () => matchMedia("(min-width: 821px)").matches;
const LEVELS = ["Junior", "Mid", "Senior", "Staff+"];
const ROLE_ORDER = ["Backend", "Full stack", "Frontend", "Mobile", "Data", "ML / AI", "DevOps / SRE", "Security", "QA / Test", "Embedded", "General"];
const DEFAULTS = { q: "", role: "", level: "", type: "", where: "", min: 0, src: "", fresh: false, sort: "score", techs: [], mode: "any" };
const state = { ...DEFAULTS, ...(store.get("wradar-filters") || {}), limit: 40, sel: null };
let me = store.get("wradar-resume");  // { name, skills, years }; the resume text itself is never kept
let pasting = false, status = "", reads = 0, booted = false;

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
  store.set("wradar-resume", me);
  refresh();
}

async function onFile(file) {
  if (!file) return;
  const read = ++reads;  // if another file is picked meanwhile, only the latest one counts
  status = `Reading ${file.name}…`; renderMe();
  try { const text = await readFile(file); if (read === reads) useResume(file.name, text); }
  catch (e) { if (read === reads) { status = e.message || "Couldn't read that file. Try a PDF, .docx or .txt, or paste the text."; renderMe(); } }
}

function saveMe() { store.set("wradar-resume", me); refresh(); }

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
  if (!t) return "This posting doesn't name any skills wradar recognizes, so it can't be scored. Open it to read the details.";
  let s = `<b>${TIER[tier(j.score)]}.</b> Your resume covers ${n} of the ${t} skills this posting names`
    + (n ? `, including ${esc(list(j.matched.slice(0, 4)))}. ` : ". ");
  if (j.years_required == null) s += "It doesn't state a years-of-experience requirement. ";
  else if (!me.years) s += `It asks for ${j.years_required}+ years of experience. `;
  else if (me.years >= j.years_required) s += `It asks for ${j.years_required}+ years and you have ${me.years}+. `;
  else s += `It asks for ${j.years_required}+ years against your ${me.years}+, so lead with scope and impact. `;
  return s + (j.missing.length ? `If you've used ${esc(list(j.missing.slice(0, 3)))}, add them to your resume or cover them in your note.`
                               : "Nothing it asks for is missing from your resume.");
}

// ---- Filtering ----
function hasTech(j) {
  if (!state.techs.length) return true;
  return state.mode === "all" ? state.techs.every(t => j.skills.includes(t)) : state.techs.some(t => j.skills.includes(t));
}

function filtered({ tech = true, role = true } = {}) {
  const q = state.q.toLowerCase();
  const out = D.jobs.filter(j => (!me || j.score >= state.min)
    && (!tech || hasTech(j))
    && (!role || !state.role || j.role === state.role)
    && (!state.level || j.level === state.level)
    && (!state.where || j.where.includes(state.where))
    && (!state.type || j.type === state.type)
    && (!state.src || j.source === state.src)
    && (!state.fresh || isNew(j))
    && (!q || [j.title, j.company, j.location, ...j.skills].join(" ").toLowerCase().includes(q)));
  const newest = (a, b) => age(a) - age(b);
  return out.sort(me && state.sort === "score" ? (a, b) => b.score - a.score || b.matched.length - a.matched.length || newest(a, b) : newest);
}

// ---- Radar scope ----
const jitter = (i, salt) => (((i + 1) * 2654435761 + salt * 40503) >>> 0) % 1000 / 1000;
function renderScope(jobs) {
  const C = 230, R = 172, roles = ROLE_ORDER.filter(r => D.jobs.some(j => j.role === r));
  const span = 2 * Math.PI / roles.length, maxAge = D.rules?.max_age_days || 30;
  const pt = (a, r) => [C + r * Math.sin(a), C - r * Math.cos(a)].map(v => v.toFixed(1));  // 0 rad is straight up, clockwise
  const frac = j => me ? (100 - j.score) / 100 : Math.min(1, age(j) / maxAge);
  const rings = me ? [[.25, "75%"], [.5, "50%"], [.75, "25%"], [1, "0%"]] : [[7 / maxAge, "1 wk"], [14 / maxAge, "2 wk"], [21 / maxAge, "3 wk"], [1, `${maxAge} d`]];
  let svg = `<defs><linearGradient id="swg" gradientUnits="userSpaceOnUse" x1="${C}" y1="${C - R}" x2="${pt(-0.7, R)[0]}" y2="${pt(-0.7, R)[1]}">
      <stop offset="0" stop-color="var(--signal)" stop-opacity=".45"/><stop offset="1" stop-color="var(--signal)" stop-opacity="0"/></linearGradient></defs>`;
  if (state.role) {
    const s = roles.indexOf(state.role), [x1, y1] = pt(s * span, R), [x2, y2] = pt((s + 1) * span, R);
    svg += `<path class="r-wedge on" d="M${C} ${C}L${x1} ${y1}A${R} ${R} 0 0 1 ${x2} ${y2}Z"/>`;
  }
  rings.forEach(([f, label], k) => {
    svg += `<circle class="r-ring${k === rings.length - 1 ? " edge" : ""}" cx="${C}" cy="${C}" r="${(10 + f * (R - 10)).toFixed(1)}"/>`;
    svg += `<text class="r-ringlabel" x="${C + 5}" y="${(C - 10 - f * (R - 10) + 13).toFixed(1)}">${label}</text>`;
  });
  roles.forEach((role, s) => {
    const [x, y] = pt(s * span, R);
    svg += `<line class="r-spoke" x1="${C}" y1="${C}" x2="${x}" y2="${y}"/>`;
    const mid = (s + 0.5) * span, [lx, ly] = pt(mid, R + 20), sin = Math.sin(mid);
    const anchor = sin > 0.2 ? "start" : sin < -0.2 ? "end" : "middle";
    svg += `<text class="r-role${state.role === role ? " on" : ""}" x="${lx}" y="${ly}" text-anchor="${anchor}" dominant-baseline="middle" data-role="${esc(role)}" tabindex="0" role="button" aria-pressed="${state.role === role}">${esc(role)}</text>`;
  });
  svg += `<g class="r-sweep"><path d="M${C} ${C}L${C} ${C - R}A${R} ${R} 0 0 0 ${pt(-0.7, R).join(" ")}Z" fill="url(#swg)"/><line x1="${C}" y1="${C}" x2="${C}" y2="${C - R}" stroke="var(--signal)" stroke-width="1.5"/></g>`;
  const shown = jobs.slice(0, 600);
  shown.forEach(j => {
    const s = roles.indexOf(j.role), a = (s + 0.1 + 0.8 * jitter(j.i, 1)) * span;
    const r = 10 + frac(j) * (R - 10) + (jitter(j.i, 2) - 0.5) * 6;
    const [x, y] = pt(a, Math.max(4, Math.min(R - 2, r)));
    const cls = me ? tier(j.score) : "plain", sel = j.i === state.sel;
    if (sel) svg += `<circle class="r-selring" cx="${x}" cy="${y}" r="9"/>`;
    svg += `<circle class="blip ${cls}${sel ? " sel" : ""}" cx="${x}" cy="${y}" r="${sel ? 5 : 3.6}" data-i="${j.i}" style="--d:${(a / (2 * Math.PI) * 2).toFixed(2)}s"><title>${esc(j.title)} at ${esc(j.company)}${me ? `, ${j.score}% match` : ""}</title></circle>`;
  });
  const el = $("#radar");
  el.innerHTML = svg;
  if (!booted) { booted = true; el.classList.add("boot"); setTimeout(() => el.classList.remove("boot"), 3000); }
  $("#radar-legend").textContent = (me ? "Closer to the center means a better match for your resume." : "Closer to the center means newer.")
    + " Each wedge is a role." + (jobs.length > shown.length ? ` Showing the first ${shown.length} of ${jobs.length.toLocaleString()} jobs.` : "");
  el.setAttribute("aria-label", `Radar of ${jobs.length} jobs by role`);
}

function renderBand(jobs) {
  const N = D.jobs.length, hot = me ? D.jobs.filter(j => j.score >= 70).length : 0;
  $("#headline").textContent = `${plural(N, "software role")} on the scope`;
  $("#subline").textContent = `Pulled from ${D.sources.filter(s => s.ok).length} company career sites and job boards across the US, Canada and remote. ${D.jobs.filter(isNew).length.toLocaleString()} are new in the last two days.`;
  $("#youline").innerHTML = me
    ? `<span><span class="tier hot">${plural(hot, "hot match", "hot matches")}</span> for <b>${esc(me.name)}</b></span><a class="btn onnavy" href="#resume">Change resume</a>`
    : `<span>Add your resume to see which of these fit you.</span><a class="btn" href="#resume">Add your resume</a>`;
  const counts = {};
  filtered({ role: false }).forEach(j => counts[j.role] = (counts[j.role] || 0) + 1);
  $("#sectors").innerHTML = ROLE_ORDER.filter(r => D.jobs.some(j => j.role === r))
    .map(r => `<button type="button" class="sector" data-role="${esc(r)}" aria-pressed="${state.role === r}">${esc(r)}<b>${(counts[r] || 0).toLocaleString()}</b></button>`).join("");
  renderScope(jobs);
}

// ---- Jobs list and detail ----
const chips = (a, cls = "") => a.map(k => `<span class="chip ${cls}">${esc(k)}</span>`).join("") || '<span class="na">None</span>';
const matchNum = j => me ? `<span class="match ${tier(j.score)}">${j.score}<small>%</small></span>` : '<span class="match none" aria-label="No resume yet">–</span>';

function item(j) {
  return `<li><button type="button" class="jitem" data-i="${j.i}" aria-current="${state.sel === j.i}">
    ${matchNum(j)}
    <span class="jtext"><span class="jtitle">${esc(j.title)}</span><span class="jco">${esc(j.company)}</span>
      <span class="jfacts"><span>${esc(j.where.join(" / "))}</span><span>${esc(j.level)} ${esc(j.role)}</span><span>${esc(j.type)}</span>
        ${isNew(j) ? '<span class="fresh">New</span>' : `<span>${ago(j.posted)}</span>`}</span></span>
  </button></li>`;
}

function gauge(j) {
  const c = 2 * Math.PI * 32, v = j.score / 100 * c;
  return `<div class="gauge ${tier(j.score)}" style="color:var(--${tier(j.score)})">
    <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true"><circle class="g-track" cx="42" cy="42" r="32" fill="none" stroke-width="7"/>
      <circle class="g-val" cx="42" cy="42" r="32" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${v.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 42 42)"/>
      <text x="42" y="48" text-anchor="middle" class="match ${tier(j.score)}" fill="currentColor" font-size="17">${j.score}%</text></svg>
    <small>${TIER[tier(j.score)]}</small></div>`;
}

function detail(j) {
  if (!j) return '<div class="empty">Pick a job from the list to see the details.</div>';
  const link = /^https?:\/\//.test(j.url)
    ? `<a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">Open posting</a>`
    : '<span class="na">No link for this posting</span>';
  const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  return `<button type="button" class="btn quiet back" id="back">Back to jobs</button>
    <div class="dtop"><div><p class="dco">${esc(j.company)}</p><h2 id="dtitle">${esc(j.title)}</h2></div>${me ? gauge(j) : ""}</div>
    <div class="row">${link}</div>
    <dl class="facts">${fact("Where", esc(j.where.join(" / ")))}${fact("Job type", esc(j.type))}${fact("Seniority", esc(j.level))}${fact("Role", esc(j.role))}
      ${fact("Posted", ago(j.posted))}${fact("Experience asked", j.years_required ? j.years_required + "+ years" : "Not stated")}
      ${fact("Applicants", j.applicants == null ? '<span class="na">Not available</span>' : esc(j.applicants))}${fact("Found on", esc(j.source))}</dl>
    ${me ? `<p class="why">${why(j)}</p>
        <div class="dsec"><h3>On your resume (${j.matched.length})</h3><div class="chips">${chips(j.matched, "have")}</div></div>
        <div class="dsec"><h3>Missing from your resume (${j.missing.length})</h3><div class="chips">${chips(j.missing, "miss")}</div></div>`
      : `<div class="nudge"><p>Add your resume to see how well you match this job.</p><a class="btn" href="#resume">Add your resume</a></div>
        <div class="dsec"><h3>Skills this posting names (${j.skills.length})</h3><div class="chips">${chips(j.skills)}</div></div>`}
    <div class="dsec"><h3>Location as posted</h3><p>${esc(j.location || "Not listed")}</p></div>`;
}

function activeFilters() {
  return ["q", "role", "level", "type", "where", "src"].filter(k => state[k]).length + (state.fresh ? 1 : 0)
    + (state.min && me ? 1 : 0) + (state.techs.length ? 1 : 0);
}

function renderTechs() {
  const counts = {};
  filtered({ tech: false }).forEach(j => j.skills.forEach(k => counts[k] = (counts[k] || 0) + 1));
  const shown = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 18);
  state.techs.forEach(t => shown.includes(t) || shown.unshift(t));
  $("#techs").innerHTML = shown.map(k => `<button type="button" class="tchip" data-k="${esc(k)}" aria-pressed="${state.techs.includes(k)}">${esc(k)}<span>${(counts[k] || 0).toLocaleString()}</span></button>`).join("");
}

function renderJobs() {
  const { limit, sel, ...keep } = state;
  store.set("wradar-filters", keep);
  renderTechs();
  const jobs = filtered();
  if (!jobs.some(j => j.i === state.sel)) state.sel = wide() && jobs.length ? jobs[0].i : null;
  renderBand(jobs);
  const n = activeFilters();
  $("#nfilters").textContent = n ? `(${n} on)` : "";
  $("#minlabel").classList.toggle("off", !me);
  $("#min").disabled = !me;
  $("#count").textContent = jobs.length === D.jobs.length ? plural(jobs.length, "job") : `${jobs.length.toLocaleString()} of ${plural(D.jobs.length, "job")}`;
  $("#list").innerHTML = jobs.slice(0, state.limit).map(item).join("") || '<li class="empty">No jobs match these filters. Try clearing one.</li>';
  $("#more").hidden = jobs.length <= state.limit;
  $("#detail").innerHTML = detail(D.jobs[state.sel]);
}

function openJob(i) {
  state.sel = i;
  const at = filtered().findIndex(j => j.i === i);
  if (at >= state.limit) state.limit = at + 1;
  renderJobs();
  $("#board").classList.add("showing");
  if (wide()) $(`.jitem[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  else $("#detail").scrollTop = 0;
  $("#detail").focus({ preventScroll: true });
}

// ---- My resume ----
function renderMe() {
  const err = status && !status.startsWith("Reading");
  const statusLine = status ? `<p class="status${err ? " err" : ""}" role="status">${esc(status)}</p>` : "";
  if (!me) {
    $("#me").innerHTML = `<div class="drop" id="drop">
        <h2>Drop your resume here</h2>
        <p>PDF, Word (.docx) or plain text. wradar finds the skills and years of experience it lists, then scores every job against them.</p>
        <div class="row"><button class="btn" type="button" id="pick">Choose a file</button>
          <button class="linkbtn" type="button" id="pastebtn">${pasting ? "Hide the text box" : "Paste the text instead"}</button></div>
        ${pasting ? `<textarea id="pastetext" aria-label="Resume text" placeholder="Paste your resume text here"></textarea>
          <button class="btn quiet" type="button" id="usepaste">Use this text</button>` : ""}
        ${statusLine}
      </div>`;
    return;
  }
  $("#me").innerHTML = `<div class="mehead">
      <div><h2>${esc(me.name)}</h2><span class="mestats">${plural(me.skills.length, "skill")} found, ${me.years ? me.years + "+ years of experience" : "years of experience not found"}</span></div>
      <div class="row"><button class="btn quiet" type="button" id="pick">Replace</button><button class="linkbtn" type="button" id="forget">Remove</button></div>
    </div>
    ${statusLine}
    <div class="row"><label>Years of experience <input type="number" id="years" min="0" max="50" value="${me.years ?? ""}"></label>
      <label>Add a skill <input id="addskill" list="techlist" placeholder="For example, Go"></label></div>
    <div class="dsec"><h3>Skills on your resume</h3><p class="note">Remove any that are wrong, or add ones it missed. Every score updates as you edit.</p>
      <div class="chips">${me.skills.map(k => `<span class="xchip">${esc(k)}<button type="button" data-k="${esc(k)}" aria-label="Remove ${esc(k)}">×</button></span>`).join("")}</div></div>`;
}

function bars(entries, empty = "Nothing to show yet.") {
  const max = entries[0]?.[1] || 1;
  return entries.map(([k, n]) => `<li>${esc(k)}<span>${n.toLocaleString()}</span><i style="--w:${Math.round(100 * n / max)}%"></i></li>`).join("")
    || `<li class="na">${empty}</li>`;
}
const tally = (jobs, pick) => {
  const t = {};
  jobs.forEach(j => [].concat(pick(j)).forEach(k => t[k] = (t[k] || 0) + 1));
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
};

function renderResume() {
  renderMe();
  $("#mygaps").innerHTML = me ? bars(tally(D.jobs, j => j.missing).slice(0, 10)) : '<li class="na">Add your resume to see this.</li>';
  const best = me ? [...D.jobs].sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || age(a) - age(b)).slice(0, 6) : [];
  $("#mybest").innerHTML = best.map(j => `<li><button type="button" data-i="${j.i}">${matchNum(j)}
      <span class="jtext"><span class="jtitle">${esc(j.title)}</span><span class="jco">${esc(j.company)}, ${esc(j.where.join(" / "))}</span></span></button></li>`).join("")
    || '<li class="na">Add your resume to see this.</li>';
}

// ---- Insights ----
function renderInsights() {
  const N = D.jobs.length, fresh = D.jobs.filter(isNew).length;
  $("#insight-sub").textContent = `From the last scan, ${ago(D.generated_at)}.`;
  $("#statement").innerHTML = `<b>${plural(N, "role")}</b> on the scope, <b>${fresh.toLocaleString()}</b> of them new in the last two days. `
    + (me ? `You're a hot match for <b>${D.jobs.filter(j => j.score >= 70).length.toLocaleString()}</b> and a warm match for <b>${D.jobs.filter(j => j.score >= 50 && j.score < 70).length.toLocaleString()}</b>.`
          : `Add your resume to see how many fit you.`);
  const card = (title, note, entries, cls = "") => `<section class="panel"><h2>${title}</h2><p class="note">${note}</p><ol class="bars ${cls}">${bars(entries)}</ol></section>`;
  $("#charts").innerHTML = [
    card("Most-requested skills", "Number of jobs naming each skill.", tally(D.jobs, j => j.skills).slice(0, 12)),
    me ? card("Skills you're missing most", "Jobs that name a skill your resume doesn't list.", tally(D.jobs, j => j.missing).slice(0, 12), "gap")
       : card("Skills you're missing most", "Add your resume to see this.", []),
    card("Jobs by role", "From the job title, or its skills when the title is generic.", tally(D.jobs, j => j.role)),
    card("Jobs by seniority", "From the job title.", LEVELS.map(l => [l, D.jobs.filter(j => j.level === l).length]).filter(([, n]) => n)),
    card("Jobs by location", "A remote job open to the US and Canada counts in each.", tally(D.jobs, j => j.where)),
    card("Jobs by type", "From the posting's own field, its title, or a plain statement in the text.", tally(D.jobs, j => j.type)),
  ].join("");
}

// ---- Sources ----
function renderSources() {
  const rules = D.rules || { max_age_days: 30 };
  const steps = [
    [`Scan ${D.sources.length} sources`, "Every 6 hours a scheduled job reads company career sites on Greenhouse, Ashby, Lever, Workday, SmartRecruiters and Workable, plus job boards such as The Muse, Himalayas and Hacker News."],
    ["Keep what fits", `Software engineering roles in the US, Canada or remote, posted in the last ${rules.max_age_days} days. Each is tagged with its skills, role, seniority and job type.`],
    ["Match your resume", "Add your resume and every job gets a match score, the skills you have and the ones you're missing. This happens in your browser."],
    ["Narrow it down", "Filter by role, seniority, technology, location or job type, then open the posting on the company's own site."],
  ];
  $("#steps").innerHTML = steps.map(([t, d]) => `<li><b>${esc(t)}</b>${esc(d)}</li>`).join("");
  const ok = D.sources.filter(s => s.ok), bad = D.sources.filter(s => !s.ok), kinds = {};
  ok.forEach(s => kinds[s.kind] = (kinds[s.kind] || 0) + 1);
  $("#srcsum").textContent = `${ok.length} of ${D.sources.length} read on the last scan (`
    + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") + "). Jobs kept out of jobs seen:";
  $("#srcok").innerHTML = ok.map(s => `<li><a href="${/^https?:\/\//.test(s.url) ? esc(s.url) : "#"}" target="_blank" rel="noopener">${esc(s.name)}</a><span>${s.kept} of ${s.seen}</span></li>`).join("");
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
  $("#scope").hidden = v !== "jobs";
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
  $("#updated").textContent = `Scanned ${ago(D.generated_at)}`;
  $("#updated").title = new Date(D.generated_at).toLocaleString();
  [...new Set(D.jobs.map(j => j.source))].sort().forEach(s => $("#src").insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`));
  ROLE_ORDER.filter(r => D.jobs.some(j => j.role === r)).forEach(r => $("#role").insertAdjacentHTML("beforeend", `<option>${esc(r)}</option>`));
  LEVELS.filter(l => D.jobs.some(j => j.level === l)).forEach(l => $("#level").insertAdjacentHTML("beforeend", `<option>${l}</option>`));
  $("#techlist").innerHTML = ALL_SKILLS.map(k => `<option value="${esc(k)}"></option>`).join("");

  const press = (group, v) => $(group).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v));
  const sync = () => {
    ["q", "role", "level", "type", "src", "sort"].forEach(k => { $("#" + k).value = state[k]; state[k] = $("#" + k).value; });
    $("#min").value = state.min; $("#minv").textContent = state.min + "%";
    $("#fresh").checked = state.fresh;
    press("#where", state.where); press("#mode", state.mode);
  };
  const set = (k, v) => { state[k] = v; state.limit = 40; renderJobs(); };
  const toggleRole = r => { state.role = state.role === r ? "" : r; $("#role").value = state.role; set("role", state.role); };
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
  $("#reset").addEventListener("click", () => { Object.assign(state, DEFAULTS, { techs: [], sort: state.sort }); sync(); set("limit", 40); });
  $("#filtersbtn").addEventListener("click", e => { e.currentTarget.setAttribute("aria-expanded", $("#filters").classList.toggle("open")); });
  $("#more").addEventListener("click", () => { state.limit += 40; renderJobs(); });
  $("#list").addEventListener("click", e => { const b = e.target.closest(".jitem"); if (b) openJob(+b.dataset.i); });
  $("#detail").addEventListener("click", e => { if (e.target.id === "back") { $("#board").classList.remove("showing"); $(`.jitem[data-i="${state.sel}"]`)?.focus(); } });
  document.addEventListener("keydown", e => { if (e.key === "Escape") $("#board").classList.remove("showing"); });
  $("#sectors").addEventListener("click", e => { const b = e.target.closest(".sector"); if (b) toggleRole(b.dataset.role); });
  $("#radar").addEventListener("click", e => {
    if (e.target.dataset.role) return toggleRole(e.target.dataset.role);
    if (e.target.classList.contains("blip")) { openJob(+e.target.dataset.i); if (wide()) $("#board").scrollIntoView({ behavior: "smooth", block: "start" }); }
  });
  $("#radar").addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.dataset.role) { e.preventDefault(); toggleRole(e.target.dataset.role); } });

  $("#file").addEventListener("change", e => { onFile(e.target.files[0]); e.target.value = ""; });
  $("#me").addEventListener("click", e => {
    const id = e.target.id;
    if (id === "pick") $("#file").click();
    if (id === "pastebtn") { pasting = !pasting; renderMe(); }
    if (id === "usepaste") { const t = $("#pastetext").value; t.trim() ? useResume("Pasted resume", t) : (status = "Paste your resume text first.", renderMe()); }
    if (id === "forget") { me = null; status = ""; store.set("wradar-resume", null); refresh(); }
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
  $("#mybest").addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (b) { location.hash = "#jobs"; openJob(+b.dataset.i); } });

  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
  sync();
  refresh();
}
init();
