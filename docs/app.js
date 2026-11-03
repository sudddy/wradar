"use strict";
// wradar: jobs come from jobs.js (written by fetch_jobs.py); resume matching happens here, in the browser.
const D = window.JOB_DATA;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = iso => { if (!iso) return "date unknown"; const d = (Date.now() - new Date(iso)) / DAY; return d < 1 ? "today" : d < 2 ? "yesterday" : Math.floor(d) + " days ago"; };
const agoShort = iso => { const m = Math.floor((Date.now() - new Date(iso)) / 6e4); return m < 60 ? `${Math.max(m, 1)}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : ago(iso); };  // the top bar's "2h ago"
const tier = s => s == null ? "none" : wmatch.TIERS.find(t => s >= t[1])[0].toLowerCase();
const TIER = { hot: "Hot match", warm: "Warm match", cool: "Cool match" };
const plural = (n, w, ws = w + "s") => `${n.toLocaleString()} ${n === 1 ? w : ws}`;
const store = {  // per-browser memory; the app works the same without it
  get: k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const wide = () => matchMedia("(min-width: 821px)").matches;
const roomy = () => matchMedia("(min-width: 1024px)").matches;  // every quick filter fits on one line
const LEVELS = ["Junior", "Mid", "Senior", "Staff+"];
const ROLE_ORDER = ["Backend", "Full stack", "Frontend", "Mobile", "Data", "ML / AI", "DevOps / SRE", "Security", "QA / Test", "Embedded", "General"];
const DEFAULTS = { v: 2, q: "", role: "", level: "", type: "", where: "", work: "", pay: 0, min: 0, src: "", fresh: false, sort: "score", techs: [], mode: "any", hideApplied: false };
const state = savedFilters(store.get("wradar-filters"), DEFAULTS);
const PASTED = "Pasted resume";
const byKey = new Map();
let me = null;  // wresume.STORED_KEYS only: derived facts, never the resume text, the person's name or employers
let stats = null, pasting = false, status = "", reads = 0, booted = false, scopeOpen = false;

// ---- Resume reading and matching ----
const rxEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SKILLS = Object.entries(D?.keywords || {}).map(([name, aliases]) => [name, aliases.map(a => a.startsWith("re:")
  ? new RegExp(a.slice(3))
  : new RegExp("(?<![A-Za-z0-9])" + rxEscape(a.replace(/^=/, "")) + "(?![A-Za-z0-9+#])", a.startsWith("=") ? "" : "i"))]);
const ALL_SKILLS = SKILLS.map(([n]) => n);
const findSkill = v => ALL_SKILLS.find(x => x.toLowerCase() === v.trim().toLowerCase());
const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
// The resume is open to these scripts, so the browser runs them only if they match these hashes (from cdnjs).
const SRI = {
  "pdf.js/3.11.174/pdf.min.js": "sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==",
  "pdf.js/3.11.174/pdf.worker.min.js": "sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==",
  "mammoth/1.6.0/mammoth.browser.min.js": "sha512-sG5Q7boJL+ft/weuz6Mmi9XBD+bEzE9AI2FMP4YMFxp3FpTFUQSQQm5K5cSgJCyed6bWs3W8f8h0lp36lHXhQA==",
};
const loadScript = file => new Promise((ok, fail) => {
  const src = CDN + file;
  if (document.querySelector(`script[src="${src}"]`)) return ok();
  document.head.append(Object.assign(document.createElement("script"), { src, integrity: SRI[file], crossOrigin: "anonymous", onload: ok,
    onerror: () => fail(new Error("Couldn't load the file reader. Check the internet connection, or paste the text instead.")) }));
});

async function readFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    // Loading the worker as a plain script lets PDF.js run on the main thread, so no worker file is needed.
    await loadScript("pdf.js/3.11.174/pdf.min.js");
    await loadScript("pdf.js/3.11.174/pdf.worker.min.js");
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) text += wresume.pdfLines((await (await pdf.getPage(i)).getTextContent()).items).join("\n") + "\n";
    return text;
  }
  if (ext === "docx") {
    await loadScript("mammoth/1.6.0/mammoth.browser.min.js");
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  if (["txt", "md", "text"].includes(ext) || file.type === "text/plain") return file.text();  // not text/rtf or text/html: their markup would read as words
  throw new Error("That file type isn't supported. Use a PDF, Word (.docx) or text file, or paste the text.");
}

function useResume(name, text) {
  const profile = { name, ...wresume.parseResume(text, SKILLS, D.rules) };
  if (!profile.skills.length) { status = "No skills were recognized in that resume. Check it's the right file, or paste the text."; return refresh(); }
  me = Object.fromEntries(wresume.STORED_KEYS.map(k => [k, profile[k]]));
  status = ""; pasting = false; state.sort = "score";
  store.set("wradar-resume", me);
  refresh();
}

async function onFile(file) {
  if (!file) return;
  const read = ++reads;  // if another file is picked meanwhile, only the latest one counts
  status = "Reading your resume…"; renderMe();
  try { const text = await readFile(file); if (read === reads) useResume(wresume.resumeLabel(file.name), text); }
  catch (e) { if (read === reads) { status = e.message || "Couldn't read that file. Try a PDF, .docx or .txt, or paste the text."; renderMe(); } }
}

function loadResume() {
  const saved = store.get("wradar-resume");
  me = wresume.upgradeProfile(saved);
  if (!me) return;
  if (saved.name === PASTED) me.name = PASTED;  // upgradeProfile only knows the file labels
  store.set("wradar-resume", me);  // at once, so an old stored file name is gone even if nothing else changes
}

const saveMe = () => { store.set("wradar-resume", me); refresh(); };
const unread = () => me && !Object.keys(me.evidence).length;  // saved before wradar read jobs and projects apart

function scoreJobs() {
  if (me) stats ||= wmatch.buildStats(D.all);
  const mine = new Set(me?.skills);
  D.all.forEach(j => {
    j.fit = me ? wmatch.score(me, j, stats) : null;
    j.score = j.fit ? j.fit.score : null;
    j.matched = me ? j.skills.filter(k => mine.has(k)) : [];
    j.missing = me ? j.skills.filter(k => !mine.has(k)) : [];
  });
}

// ---- Filtering ----
const unhidden = a => a.filter(j => statusOf(j) !== "hidden");
const pool = () => unhidden(page === "older" ? D.older : D.jobs).filter(j => !state.hideApplied || statusOf(j) !== "applied");
const newest = (a, b) => age(a) - age(b);
const byMatch = (a, b) => b.score - a.score || b.fit.tie - a.fit.tie || newest(a, b);

function listed({ tech, role, jobs = pool(), view = page } = {}) {
  const got = knownOnly(jobs.filter(j => matches(j, state, view, { tech, role })), state.pay, state.work);
  got.kept.sort(me && state.sort === "score" ? byMatch : newest);
  return got;
}
const filtered = opts => listed(opts).kept;

// ---- Radar scope ----
const jitter = (i, salt) => (((i + 1) * 2654435761 + salt * 40503) >>> 0) % 1000 / 1000;
function renderScope(jobs) {
  const C = 230, R = 172, roles = ROLE_ORDER.filter(r => D.jobs.some(j => j.role === r));
  const span = 2 * Math.PI / roles.length;
  const pt = (a, r) => [C + r * Math.sin(a), C - r * Math.cos(a)].map(v => v.toFixed(1));  // 0 rad is straight up, clockwise
  const frac = j => me ? (100 - j.score) / 100 : Math.min(1, age(j) / FRESH_DAYS);
  const rings = me ? [[.25, "75"], [.5, "50"], [.75, "25"], [1, "0"]] : [[7 / FRESH_DAYS, "1 wk"], [14 / FRESH_DAYS, "2 wk"], [21 / FRESH_DAYS, "3 wk"], [1, `${FRESH_DAYS} d`]];
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
    const cls = (me ? tier(j.score) : "plain") + (statusOf(j) === "applied" ? " hollow" : ""), sel = j.key === nav.jobs.sel;
    if (sel) svg += `<circle class="r-selring" cx="${x}" cy="${y}" r="9"/>`;
    svg += `<circle class="blip ${cls}${sel ? " sel" : ""}" cx="${x}" cy="${y}" r="${sel ? 5 : 3.6}" data-i="${j.i}" style="--d:${(a / (2 * Math.PI) * 2).toFixed(2)}s"><title>${esc(j.title)} at ${esc(j.company)}${me ? `, match ${j.score}` : ""}</title></circle>`;
  });
  const el = $("#radar");
  el.innerHTML = svg;
  if (!booted) { booted = true; el.classList.add("boot"); setTimeout(() => el.classList.remove("boot"), 3000); }
  $("#radar-legend").textContent = (me ? "Closer to the center means a better match for your resume." : "Closer to the center means newer.")
    + " Each wedge is a role." + (jobs.length > shown.length ? ` Showing the first ${shown.length} of ${jobs.length.toLocaleString()} jobs.` : "");
  el.setAttribute("aria-label", `Radar of ${jobs.length} jobs by role`);
}

function renderBand(jobs) {
  const N = D.jobs.length, hot = me ? D.jobs.filter(j => tier(j.score) === "hot").length : 0;
  $("#headline").textContent = `${plural(N, "software role")} on the scope`;
  $("#subline").textContent = `${D.jobs.filter(isNew).length.toLocaleString()} new in the last two days, from ${D.sources.filter(s => s.ok).length} career sites and job boards across the US, Canada and remote.`;
  $("#youline").innerHTML = me
    ? `<span class="tier hot">${plural(hot, "hot match", "hot matches")}</span><a class="btn onnavy${unread() ? " again" : ""}" href="#resume">${unread() ? "Add your resume again for better scores" : "Change resume"}</a>`
    : `<span class="youhint">See which of these fit you.</span><a class="btn" href="#resume">Add your resume</a>`;
  const counts = {};
  filtered({ role: false }).forEach(j => counts[j.role] = (counts[j.role] || 0) + 1);
  $("#sectors").innerHTML = ROLE_ORDER.filter(r => D.jobs.some(j => j.role === r))
    .map(r => `<button type="button" class="sector" data-role="${esc(r)}" aria-pressed="${state.role === r}">${esc(r)}<b>${(counts[r] || 0).toLocaleString()}</b></button>`).join("");
  renderScope(jobs);
}

function toggleScope() {
  scopeOpen = !scopeOpen;
  $("#scope").classList.toggle("open", scopeOpen);
  $("#radar").setAttribute("viewBox", scopeOpen ? "-66 0 592 460" : "50 50 360 360");
  $("#scopebtn").setAttribute("aria-expanded", scopeOpen);
  $("#scopebtn span").textContent = scopeOpen ? "Collapse radar" : "Expand radar";
}

// ---- Filter bar ----
const press = (group, v) => $(group).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v));

function activeFilters() {
  const more = ["type", "src", "pay"].filter(k => state[k]).length + (state.fresh && page !== "older" ? 1 : 0)
    + (state.min && me ? 1 : 0) + (state.techs.length ? 1 : 0);
  return more + (roomy() ? 0 : ["where", "role", "level", "work"].filter(k => state[k]).length);
}

function renderTechs() {
  const counts = {};
  filtered({ tech: false }).forEach(j => j.skills.forEach(k => counts[k] = (counts[k] || 0) + 1));
  const shown = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 18);
  state.techs.forEach(t => shown.includes(t) || shown.unshift(t));
  $("#techs").innerHTML = shown.map(k => `<button type="button" class="tchip" data-k="${esc(k)}" aria-pressed="${state.techs.includes(k)}">${esc(k)}<span>${(counts[k] || 0).toLocaleString()}</span></button>`).join("");
}

function renderFilters() {
  const n = activeFilters();
  $("#nfilters").textContent = n ? `(${n})` : "";
  $("#minlabel").classList.toggle("off", !me);
  $("#min").disabled = !me;
  $("#fresh").disabled = page === "older";
  $("#sort").value = me ? state.sort : "new";  // with no resume the list is newest first, whatever was picked
  $("#sort").disabled = !me;
  renderTechs();
}

function showMore(on) {
  $("#fmore").hidden = !on;
  $("#filters").classList.toggle("open", on);
  $("#filtersbtn").setAttribute("aria-expanded", on);
}

// ---- My resume ----
const READ_AS = [[3, "Latest job"], [2, "Older job or project"], [1, "Listed only"]];
const NOT_FOUND = '<span class="na">Not found</span>';
const xchip = k => `<span class="xchip">${esc(k)}<button type="button" data-k="${esc(k)}" aria-label="Remove ${esc(k)}">×</button></span>`;

function skillGroups() {
  const at = n => me.skills.filter(k => (me.evidence[k]?.strength || 0) === n);
  return [...READ_AS.map(([n, label]) => [label, at(n)]), [unread() ? "Skills on your resume" : "Added by you", at(0)]].filter(([, a]) => a.length);
}

function renderMe() {
  const err = status && !status.startsWith("Reading");
  const statusLine = status ? `<p class="status${err ? " err" : ""}" role="status">${esc(status)}</p>` : "";
  if (!me) {
    $("#me").innerHTML = `<div class="drop" id="drop">
        <h2>Drop your resume here</h2>
        <p>PDF, Word (.docx) or plain text. wradar reads your jobs, projects and skills, then scores every job against them.</p>
        <div class="row"><button class="btn" type="button" id="pick">Choose a file</button>
          <button class="linkbtn" type="button" id="pastebtn">${pasting ? "Hide the text box" : "Paste the text instead"}</button></div>
        ${pasting ? `<textarea id="pastetext" aria-label="Resume text" placeholder="Paste your resume text here"></textarea>
          <button class="btn quiet" type="button" id="usepaste">Use this text</button>` : ""}
        ${statusLine}
      </div>`;
    return;
  }
  const groups = skillGroups().map(([label, a]) => `<div class="skillgroup"><h4>${label} (${a.length})</h4><div class="chips">${a.map(xchip).join("")}</div></div>`).join("");
  $("#me").innerHTML = `<div class="mehead">
      <div><h2>${esc(me.name)}</h2><span class="mestats">${plural(me.skills.length, "skill")} found</span></div>
      <div class="row"><button class="btn quiet" type="button" id="pick">Replace</button><button class="linkbtn" type="button" id="forget">Remove</button></div>
    </div>
    ${statusLine}
    ${unread() ? '<p class="status">Add your resume again for better scores.</p>' : ""}
    <dl class="facts">${fact("Years", me.years ?? NOT_FOUND)}${fact("Level", esc(wmatch.levelOf(me)) || NOT_FOUND)}${fact("Role", esc(me.role) || NOT_FOUND)}${fact("Degree", esc(me.degree) || NOT_FOUND)}</dl>
    <div class="row"><label>Years of experience <input type="number" id="years" min="0" max="50" step="0.5" value="${me.years ?? ""}"></label>
      <label>Add a skill <input id="addskill" list="techlist" placeholder="For example, Go"></label></div>
    <div class="dsec"><h3>Skills on your resume</h3><p class="note">Remove any that are wrong, or add ones it missed. Every score updates as you edit.</p>${groups}</div>`;
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
  const best = me ? D.jobs.filter(j => !["applied", "hidden"].includes(statusOf(j))).sort(byMatch).slice(0, 6) : [];
  $("#mybest").innerHTML = best.map(j => `<li><button type="button" data-i="${j.i}">${matchNum(j)}
      <span class="jtext"><span class="jtitle">${esc(j.title)}</span><span class="jco">${esc(j.company)}, ${esc(j.where.join(" / "))}</span></span></button></li>`).join("")
    || '<li class="na">Add your resume to see this.</li>';
}

// ---- Insights ----
function renderInsights() {
  const N = D.jobs.length, fresh = D.jobs.filter(isNew).length;
  const inTier = t => D.jobs.filter(j => tier(j.score) === t).length.toLocaleString();
  $("#insight-sub").textContent = `From the last scan, ${ago(D.generated_at)}.`;
  $("#statement").innerHTML = `<b>${plural(N, "role")}</b> on the scope, <b>${fresh.toLocaleString()}</b> of them new in the last two days. `
    + (me ? `You're a hot match for <b>${inTier("hot")}</b> and a warm match for <b>${inTier("warm")}</b>.`
          : `Add your resume to see how many fit you.`);
  const card = (title, note, entries, cls = "") => `<section class="panel"><h2>${title}</h2><p class="note">${note}</p><ol class="bars ${cls}">${bars(entries)}</ol></section>`;
  $("#charts").innerHTML = [
    card("Most-requested skills", "Number of jobs naming each skill.", tally(D.jobs, j => j.skills).slice(0, 12)),
    me ? card("Skills to add", "Jobs that name a skill your resume doesn't list.", tally(D.jobs, j => j.missing).slice(0, 12), "gap")
       : card("Skills to add", "Add your resume to see this.", []),
    card("Jobs by role", "From the job title, or its skills when the title is generic.", tally(D.jobs, j => j.role)),
    card("Jobs by seniority", "From the job title.", LEVELS.map(l => [l, D.jobs.filter(j => j.level === l).length]).filter(([, n]) => n)),
    card("Jobs by location", "A remote job open to the US and Canada counts in each.", tally(D.jobs, j => j.where)),
    card("Jobs by type", "From the posting's own field, its title, or a plain statement in the text.", tally(D.jobs, j => j.type)),
  ].join("");
}

// ---- Sources ----
function renderSources() {
  const steps = [
    [`Scan ${D.sources.length} sources`, "Every 6 hours a scheduled job reads company career sites on Greenhouse, Ashby, Lever, Workday, SmartRecruiters and Workable, plus job boards such as The Muse, Himalayas and Hacker News."],
    ["Keep what fits", `Software engineering roles in the US, Canada or remote, posted in the last ${D.rules.max_age_days} days. Anything past ${FRESH_DAYS} days moves to the Older tab. Each is tagged with its skills, role, seniority and job type, plus pay and work mode when stated.`],
    ["Match your resume", "Add your resume and every job gets a score out of 100 for role, seniority, years, must-have skills, other skills and degree, with skills from your latest job counting most. This happens in your browser."],
    ["Narrow it down", "Filter by role, seniority, technology, location, pay, work mode or job type, then open the posting on the company's own site. My jobs keeps what you save or apply to."],
  ];
  $("#steps").innerHTML = steps.map(([t, d]) => `<li><b>${esc(t)}</b>${esc(d)}</li>`).join("");
  const ok = D.sources.filter(s => s.ok), bad = D.sources.filter(s => !s.ok), kinds = {};
  ok.forEach(s => kinds[s.kind] = (kinds[s.kind] || 0) + 1);
  // Slow sources are read once per 6-hour slot, and a scan between carries their last rows over.
  $("#srcsum").textContent = `${ok.length} of ${D.sources.length} read in the 6 hours up to the last scan (`
    + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") + "). Jobs kept out of jobs seen:";
  $("#srcok").innerHTML = ok.map(s => `<li><a href="${/^https?:\/\//.test(s.url) ? esc(s.url) : "#"}" target="_blank" rel="noopener">${esc(s.name)}</a><span>${s.kept} of ${s.seen}</span></li>`).join("");
  $("#srcbadwrap").hidden = !bad.length;
  $("#srcbadwrap summary").textContent = `${bad.length} couldn't be read`;
  $("#srcbad").innerHTML = bad.map(s => `<li>${esc(s.name)}<span>${esc(s.error)}</span></li>`).join("");
}

// ---- Routing ----
const VIEWS = { resume: renderResume, insights: renderInsights, sources: renderSources };
function route() {
  const { view, key } = parseHash(location.hash), moved = view !== page;
  const closing = !key && $("#board").classList.contains("showing");
  if (moved && nav[page]) nav[page].y = scrollY;
  page = view;
  if (key) tab().sel = key;
  else pushed = false;
  $("#view-jobs").hidden = !BOARDS.includes(view);
  Object.keys(VIEWS).forEach(x => { $("#view-" + x).hidden = x !== view; });
  $("#scope").hidden = view !== "jobs";
  $("#board").classList.toggle("showing", !!key);  // on a phone the hash owns the detail, so system Back closes it
  document.querySelectorAll(".tabs a").forEach(a => a.setAttribute("aria-current", a.getAttribute("href") === "#" + view ? "page" : "false"));
  if (VIEWS[view]) { renderCounts(); VIEWS[view](); } else renderBoard();  // the board renders its own counts
  if (moved) window.scrollTo(0, nav[view]?.y || 0);
  if (key) $("#list .jitem[aria-current=true]")?.scrollIntoView({ block: "nearest" });
  if (key && !wide()) { $("#detail").scrollTop = 0; $("#dtitle")?.focus({ preventScroll: true }); }
  if (closing) focusBoard();
}
function refresh() { scoreJobs(); route(); }

// ---- Wiring ----
function init() {
  if (!D) {
    $("#list").innerHTML = '<li class="empty">No job data yet. Run <code>python3 fetch_jobs.py</code>, then reload.</li>';
    return;
  }
  D.all = D.jobs;
  D.all.forEach((j, i) => { j.i = i; j.key = jobKey(j); j.must ||= []; j.nice ||= []; byKey.set(j.key, j); });
  const { fresh, older } = splitAge(D.all);
  D.jobs = fresh;
  D.older = older;
  loadResume();
  loadTracker();
  $("#updated").textContent = `Scanned ${agoShort(D.generated_at)}`;
  $("#updated").title = new Date(D.generated_at).toLocaleString();
  initScan();
  [...new Set(D.all.map(j => j.source))].sort().forEach(s => $("#src").insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`));
  ROLE_ORDER.filter(r => D.all.some(j => j.role === r)).forEach(r => $("#role").insertAdjacentHTML("beforeend", `<option>${esc(r)}</option>`));
  LEVELS.filter(l => D.all.some(j => j.level === l)).forEach(l => $("#level").insertAdjacentHTML("beforeend", `<option>${l}</option>`));
  $("#techlist").innerHTML = ALL_SKILLS.map(k => `<option value="${esc(k)}"></option>`).join("");

  const sync = () => {
    ["q", "role", "level", "type", "src", "sort", "work"].forEach(k => { $("#" + k).value = state[k]; state[k] = $("#" + k).value; });
    $("#pay").value = state.pay; state.pay = +$("#pay").value;
    $("#min").value = state.min; $("#minv").textContent = state.min;
    $("#fresh").checked = state.fresh;
    $("#hideapplied").checked = state.hideApplied;
    press("#where", state.where); press("#mode", state.mode);
  };
  const changed = () => {  // a filter change ends any deep link, so the list picks the selection again
    tab().limit = 40;
    if (parseHash(location.hash).key) history.replaceState(null, "", "#" + page);
    renderBoard();
  };
  const set = (k, v) => { state[k] = v; changed(); };
  const toggleRole = r => { state.role = state.role === r ? "" : r; $("#role").value = state.role; changed(); };
  $("#q").addEventListener("input", e => set("q", e.target.value));
  ["role", "level", "type", "src", "sort", "work"].forEach(k => $("#" + k).addEventListener("change", e => set(k, e.target.value)));
  $("#pay").addEventListener("change", e => set("pay", +e.target.value));
  $("#min").addEventListener("input", e => { $("#minv").textContent = e.target.value; set("min", +e.target.value); });
  $("#fresh").addEventListener("change", e => set("fresh", e.target.checked));
  $("#hideapplied").addEventListener("change", e => set("hideApplied", e.target.checked));
  $("#where").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { press("#where", b.dataset.v); set("where", b.dataset.v); } });
  $("#mode").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { press("#mode", b.dataset.v); set("mode", b.dataset.v); } });
  $("#mineseg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { mineSeg = b.dataset.v; changed(); } });
  $("#techs").addEventListener("click", e => {
    const b = e.target.closest(".tchip"); if (!b) return;
    set("techs", state.techs.includes(b.dataset.k) ? state.techs.filter(t => t !== b.dataset.k) : [...state.techs, b.dataset.k]);
  });
  const addTech = () => { const k = findSkill($("#techq").value); if (k) { $("#techq").value = ""; if (!state.techs.includes(k)) set("techs", [...state.techs, k]); } };
  $("#techq").addEventListener("change", addTech);
  $("#techq").addEventListener("keydown", e => { if (e.key === "Enter") addTech(); });
  $("#reset").addEventListener("click", () => { Object.assign(state, DEFAULTS, { techs: [], sort: state.sort, hideApplied: state.hideApplied }); sync(); changed(); });
  $("#filtersbtn").addEventListener("click", () => showMore($("#fmore").hidden));
  document.addEventListener("click", e => { if (!$("#fmore").hidden && !e.composedPath().includes($("#filters"))) showMore(false); });
  $("#more").addEventListener("click", () => { tab().limit += 40; renderList(); });
  $("#list").addEventListener("click", e => { const b = e.target.closest(".jitem"); if (b) openRow(rows[+b.dataset.n]); });
  $("#list").addEventListener("keydown", e => {
    const d = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (d && e.target.closest(".jitem")) { e.preventDefault(); step(d); }
  });
  $("#detail").addEventListener("click", e => { const b = e.target.closest("[data-do]"); if (b) act(b.dataset.do); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("#fmore").hidden) { showMore(false); $("#filtersbtn").focus(); }
    else if (!closeToast() && parseHash(location.hash).key && !wide()) closeDetail();
  });
  $("#scopebtn").addEventListener("click", toggleScope);
  $("#sectors").addEventListener("click", e => { const b = e.target.closest(".sector"); if (b) toggleRole(b.dataset.role); });
  $("#radar").addEventListener("click", e => {
    if (e.target.dataset.role) return toggleRole(e.target.dataset.role);
    if (e.target.classList.contains("blip")) openRow(D.all[+e.target.dataset.i]);
  });
  $("#radar").addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.dataset.role) { e.preventDefault(); toggleRole(e.target.dataset.role); } });

  $("#file").addEventListener("change", e => { onFile(e.target.files[0]); e.target.value = ""; });
  $("#me").addEventListener("click", e => {
    const id = e.target.id;
    if (id === "pick") $("#file").click();
    if (id === "pastebtn") { pasting = !pasting; renderMe(); }
    if (id === "usepaste") { const t = $("#pastetext").value; reads++; t.trim() ? useResume(PASTED, t) : (status = "Paste your resume text first.", renderMe()); }  // reads++: a file still loading no longer counts
    if (id === "forget") { reads++; me = null; status = ""; store.set("wradar-resume", null); refresh(); }  // reads++ drops a read still going
    const k = e.target.closest(".xchip button")?.dataset.k;
    if (k) { me.skills = me.skills.filter(s => s !== k); delete me.evidence[k]; saveMe(); }
  });
  $("#me").addEventListener("change", e => {
    if (e.target.id === "years") { me.years = e.target.value === "" ? null : +e.target.value; saveMe(); }  // 0 is a real answer
    if (e.target.id === "addskill") {
      const k = findSkill(e.target.value);
      if (k && !me.skills.includes(k)) { me.skills = ALL_SKILLS.filter(s => s === k || me.skills.includes(s)); saveMe(); $("#addskill")?.focus(); }
    }
  });
  $("#me").addEventListener("dragover", e => { if (!me) { e.preventDefault(); $("#drop")?.classList.add("over"); } });
  $("#me").addEventListener("dragleave", () => $("#drop")?.classList.remove("over"));
  $("#me").addEventListener("drop", e => { if (!me) { e.preventDefault(); $("#drop")?.classList.remove("over"); onFile(e.dataTransfer.files[0]); } });
  $("#mybest").addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (b) location.hash = hashFor("jobs", D.all[+b.dataset.i].key); });

  window.addEventListener("hashchange", route);
  window.addEventListener("storage", e => {  // a mark made in another tab; My resume isn't redrawn, so text being typed there stays
    if (e.key === "wradar-tracker") { loadTracker(); BOARDS.includes(page) ? route() : renderCounts(); }
  });
  sync();
  refresh();
}
init();
