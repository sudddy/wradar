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
const later = fn => { let t; return v => { clearTimeout(t); t = setTimeout(() => fn(v), 150); }; };  // waits for a pause in typing: a redraw reads every job
const store = {  // per-browser memory; the app works the same without it
  get: k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const wide = () => matchMedia("(min-width: 821px)").matches;
const roomy = () => matchMedia("(min-width: 1024px)").matches;  // every quick filter fits on one line
const LADDER = D?.rules?.ladder || ["Junior", "Mid", "Senior", "Staff+"];  // data from before the ladder has these four
const DAYS = [2, 3, 7, FRESH_DAYS];  // the Posted choices; Over 30 days ago is #older
const FIELDS = ["Engineering", "Data & research", "Product", "Design", "Sales", "Customer", "Marketing", "People", "Finance", "Legal & compliance",
  "Operations", "IT & security", "Healthcare", "Education", "Other"];
const fieldOf = role => (D.rules.fields ? D.rules.fields[role] || "Other" : "Engineering");  // data from before fields is all engineering
// autoRole: the Role a resume read set, so a Role cleared or picked after that stays as the person left it.
const DEFAULTS = { v: 2, q: "", role: "", level: "", type: "", where: "", work: "", pay: 0, min: 0, src: "", days: FRESH_DAYS, sort: "score", techs: [], mode: "any", hideApplied: false, autoRole: "" };
const state = savedFilters(store.get("wradar-filters"), DEFAULTS);
const PASTED = "Pasted resume";
const byKey = new Map();
let me = null;  // wresume.STORED_KEYS only: derived facts, never the resume text, the person's name or employers
let stats = null, pasting = false, status = "", reads = 0, justRead = false;  // justRead: Your resume then points on to the matches

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
  if (state.role === state.autoRole) {  // an empty Role, or the one the last resume set: one the person picked or cleared stays
    const role = $("#role");
    role.value = myField() ? "field:" + myField() : "";
    role.value = state.role = state.autoRole = role.value;  // a field with no jobs has no option, so Role reads "" and shows All roles
  }
  status = ""; pasting = false; justRead = true; state.sort = "score";
  store.set("wradar-filters", state);  // Your resume doesn't save the filters, and a reload must keep Role and the flag
  if (!location.hash.slice(1)) history.replaceState(null, "", "#resume");  // read on the welcome: stay to check it, not jump to the jobs
  nav.jobs.y = nav.older.y = 0;  // the lists now sort by match, so an old scroll spot would land on other jobs
  store.set("wradar-resume", me);
  refresh();
  announce(`Your resume is in. ${plural(me.skills.length, "skill")} read.`);
  if (page === "resume") { window.scrollTo(0, 0); $(".readok .btn")?.focus({ preventScroll: true }); }  // the next step, even after a long scroll to Use this text
}

async function onFile(file) {
  if (!file) return;
  const read = ++reads;  // if another file is picked meanwhile, only the latest one counts
  status = "Reading your resume…"; renderMe(); announce(status);
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
  if (me) stats ||= wmatch.buildStats(D.all, D.rules);
  D.all.forEach(j => {
    j.fit = me ? wmatch.score(me, j, stats) : null;
    j.score = j.fit ? j.fit.score : null;
  });
}

// ---- Fields: Skills to add and Insights read the chosen field, else the person's own ----
const myField = () => { const f = me?.role ? fieldOf(me.role) : null; return f === "Other" ? null : f; };  // Other: no role found
const chosenField = () => (state.role.startsWith("field:") ? state.role.slice(6) : state.role ? fieldOf(state.role) : null);
const shownField = () => chosenField() || myField();
const inField = (jobs, f) => (f ? jobs.filter(j => j.field === f) : jobs);
const gaps = jobs => { const mine = new Set(me.skills); return tally(jobs, j => j.skills.filter(k => !mine.has(k))); };

function roleOptions() {
  const fams = {};
  D.all.forEach(j => (fams[j.field] ||= new Set()).add(j.role));
  const opts = f => [...fams[f]].sort((a, b) => (a === "General") - (b === "General") || a.localeCompare(b))  // General: no family named
    .map(r => `<option>${esc(r)}</option>`).join("");
  return FIELDS.filter(f => fams[f]).map(f => (f === "Other" ? opts(f)  // one role, named like its field
    : `<optgroup label="${esc(f)}"><option value="field:${esc(f)}">All ${esc(f)}</option>${opts(f)}</optgroup>`)).join("");
}

// ---- Filtering ----
const unhidden = a => a.filter(j => statusOf(j) !== "hidden");
const pool = () => unhidden(page === "older" ? D.older : D.jobs.filter(j => state.days >= FRESH_DAYS || within(j, state.days))).filter(j => !state.hideApplied || statusOf(j) !== "applied");
const newest = (a, b) => postedAt(b) - postedAt(a);
const byMatch = (a, b) => b.score - a.score || b.fit.tie - a.fit.tie || newest(a, b);

// One pass serves the list and the skill chips, which count the jobs before the chosen skills narrow them.
function listed({ jobs = pool() } = {}) {
  const loose = jobs.filter(j => matches(j, state, { tech: false }));
  const got = knownOnly(loose.filter(j => hasTech(j, state)), state.pay, state.work);
  got.kept.sort(me && state.sort === "score" ? byMatch : newest);
  return { ...got, loose };
}

// ---- Step bar: the main navigation, 1 Your resume, 2 Matching jobs, 3 Applications ----
const STEP_OF = { resume: 1, jobs: 2, older: 2, mine: 3 };
const hotCount = () => (me ? unhidden(D.jobs).filter(j => tier(j.score) === "hot").length : 0);

function renderSteps() {
  $("#s1").textContent = me ? `${plural(me.skills.length, "skill")} read` : "Start here";
  $("#s2").textContent = me ? plural(hotCount(), "hot match", "hot matches") : plural(D.jobs.length, "job");
  const done = { 1: !!me, 2: !!me && mineRows(tracker, "all", byKey).length > 0 };  // step 2 is done once a matched job is saved or applied to
  [1, 2, 3].forEach(n => {
    $("#step-" + n).classList.toggle("done", !!done[n]);
    $("#step-" + n).setAttribute("aria-current", STEP_OF[page] === n ? "step" : "false");
  });
}

// ---- Filter bar ----
const press = (group, v) => $(group).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v));

function activeFilters() {
  const more = ["type", "src", "pay"].filter(k => state[k]).length + (state.min && me ? 1 : 0) + (state.techs.length ? 1 : 0);
  return more + (roomy() ? 0 : ["where", "role", "level", "work"].filter(k => state[k]).length);
}

function renderTechs(loose) {
  const counts = {};
  knownOnly(loose, state.pay, state.work).kept.forEach(j => j.skills.forEach(k => counts[k] = (counts[k] || 0) + 1));
  const shown = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 18);
  state.techs.forEach(t => shown.includes(t) || shown.unshift(t));
  $("#techs").innerHTML = shown.map(k => `<button type="button" class="tchip" data-k="${esc(k)}" aria-pressed="${state.techs.includes(k)}">${esc(k)}<span>${(counts[k] || 0).toLocaleString()}</span></button>`).join("");
}

function renderFilters(loose) {
  const n = activeFilters();
  $("#nfilters").textContent = n ? `(${n})` : "";
  $("#minlabel").classList.toggle("off", !me);
  $("#min").disabled = !me;
  press("#ages", page === "older" ? "older" : String(state.days));
  $("#sort").value = me ? state.sort : "new";  // with no resume the list is newest first, whatever was picked
  $("#sort").disabled = !me;
  renderTechs(loose);
}

function showMore(on) {
  $("#fmore").hidden = !on;
  $("#filters").classList.toggle("open", on);
  $("#filtersbtn").setAttribute("aria-expanded", on);
}

// ---- Your resume ----
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
    $("#me").innerHTML = `<div class="welcome">
      <div class="wcopy">
        <h1>Find jobs that fit your resume</h1>
        <p class="lede">wradar ranks ${plural(D.jobs.length, "job")} from ${D.sources.filter(s => s.ok).length} company career sites and job boards by how well they match you, and says what to do next for each one.</p>
      </div>
      <div class="drop" id="drop">
        <svg class="dropicon" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><path d="M12 5h14l8 8v24a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M26 5v8h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M22 32V20m-5 5 5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <h2>Drop your resume here</h2>
        <p>PDF, Word (.docx) or plain text</p>
        <div class="row"><button class="btn big" type="button" id="pick">Choose a file</button>
          <button class="btn line big" type="button" id="pastebtn">${pasting ? "Hide the text box" : "Paste the text"}</button></div>
        ${pasting ? `<textarea id="pastetext" aria-label="Resume text" placeholder="Paste your resume text here"></textarea>
          <button class="btn" type="button" id="usepaste">Use this text</button>` : ""}
        ${statusLine}
        <p class="privacy">Your resume stays in this browser. Only the skills and facts read from it are kept on this device.</p>
      </div>
      <div class="whow">
        <ol class="how">
          <li><span><b>Add your resume.</b> It's read here, in your browser, and never uploaded.</span></li>
          <li><span><b>See your matching jobs.</b> Each one shows why you fit and what's missing from your resume.</span></li>
          <li><span><b>Apply and track.</b> Mark the jobs you save and apply to, and pick up where you left off.</span></li>
        </ol>
        <a class="skip" href="#jobs">Browse jobs without a resume</a>
      </div>
    </div>`;
    return;
  }
  const hot = hotCount();
  const groups = skillGroups().map(([label, a]) => `<div class="skillgroup"><h3>${label} (${a.length})</h3><div class="chips">${a.map(xchip).join("")}</div></div>`).join("");
  $("#me").innerHTML = `${justRead ? `<div class="readok"><p><b>Your resume is in.</b> ${plural(me.skills.length, "skill")} read from it. Check them below, then see the jobs that fit.</p>
      <a class="btn big" href="#jobs">${hot ? `See your ${plural(hot, "hot match", "hot matches")}` : "See your matching jobs"}</a></div>` : ""}
    <div class="pane mepane">
      <div class="mehead">
        <div><h1>Your resume</h1><p class="note">${esc(me.name)}, ${plural(me.skills.length, "skill")} read</p></div>
        <div class="row"><button class="btn line" type="button" id="pick">Replace</button><button class="linkbtn" type="button" id="forget">Remove</button></div>
      </div>
      ${statusLine}
      ${unread() ? '<p class="status">Add your resume again for better scores.</p>' : ""}
      <dl class="facts">${fact("Years", me.years ?? NOT_FOUND)}${fact("Level", esc(wmatch.levelOf(me)) || NOT_FOUND)}${fact("Role", esc(me.role) || NOT_FOUND)}${fact("Degree", esc(me.degree) || NOT_FOUND)}</dl>
      <div class="row edits"><label>Years of experience <input type="number" id="years" min="0" max="50" step="0.5" value="${me.years ?? ""}"></label>
        <label>Add a skill <input id="addskill" list="techlist" placeholder="For example, Excel"></label></div>
      <div class="dsec"><h2>Skills read from your resume</h2><p class="note">Remove any that are wrong, or add ones it missed. Every score updates as you edit.</p>${groups}</div>
    </div>`;
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
  $("#meside").hidden = !me;  // with no resume, the page is the welcome
  $("#view-resume").classList.toggle("has", !!me);
  renderSide();
}

// Skills to add reads one field, so a marketer isn't told to learn what engineering jobs ask for.
function renderSide() {
  if (!me) return;
  const f = shownField();
  $("#mygapsnote").textContent = `What jobs${f ? ` in ${f}` : ""} ask for most that your resume doesn't list.`;
  $("#mygaps").innerHTML = bars(gaps(inField(D.jobs, f)).slice(0, 10));
  const best = topN(D.jobs.filter(j => !["applied", "hidden"].includes(statusOf(j))), 6, byMatch);
  $("#mybest").innerHTML = best.map(j => `<li><button type="button" data-i="${j.i}">${matchNum(j)}
      <span class="jtext"><span class="jtitle">${esc(j.title)}</span><span class="jco">${esc(j.company)}, ${esc(j.where.join(" / "))}</span></span></button></li>`).join("")
    || '<li class="na">No jobs to show yet.</li>';
}

// ---- Insights ----
function renderInsights() {
  const N = D.jobs.length, fresh = D.jobs.filter(isNew).length;
  const inTier = t => D.jobs.filter(j => tier(j.score) === t).length.toLocaleString();
  $("#insight-sub").textContent = `From the last scan, ${ago(D.generated_at)}.`;
  $("#statement").innerHTML = `<b>${plural(N, "role")}</b> posted in the last ${FRESH_DAYS} days, <b>${fresh.toLocaleString()}</b> of them new in the last two days. `
    + (me ? `You're a hot match for <b>${inTier("hot")}</b> and a warm match for <b>${inTier("warm")}</b>.`
          : `Add your resume to see how many fit you.`);
  const card = (title, note, entries, cls = "") => `<section class="pane"><h2>${esc(title)}</h2><p class="note">${esc(note)}</p><ol class="bars ${cls}">${bars(entries)}</ol></section>`;
  const f = shownField(), jobs = inField(D.jobs, f), where = f ? ` in ${f}` : "";  // about 45 roles: the fields, then one field's roles
  $("#charts").innerHTML = [
    card("Most-requested skills", `Number of jobs${where} naming each skill.`, tally(jobs, j => j.skills).slice(0, 12)),
    me ? card("Skills to add", `Jobs${where} that name a skill your resume doesn't list.`, gaps(jobs).slice(0, 12), "gap")
       : card("Skills to add", "Add your resume to see this.", []),
    card("Jobs by field", "From the job's role.", tally(D.jobs, j => j.field)),
    card(`Jobs${where} by role`, `${f ? "" : "The 12 most common. "}From the job title, or its skills when the title is generic.`, tally(jobs, j => j.role).slice(0, f ? undefined : 12)),
    card("Jobs by seniority", "From the job title.", LADDER.map(l => [l, D.jobs.filter(j => j.level === l).length]).filter(([, n]) => n)),
    card("Jobs by location", "A remote job open to the US and Canada counts in each.", tally(D.jobs, j => j.where)),
    card("Jobs by type", "From the posting's own field, its title, or a plain statement in the text.", tally(D.jobs, j => j.type)),
  ].join("");
}

// ---- Sources ----
function renderSources() {
  const steps = [
    [`Scan ${D.sources.length} sources`, "Every 6 hours a scheduled job reads company career sites on Greenhouse, Ashby, Lever, Workday, SmartRecruiters and Workable, plus job boards such as The Muse, Himalayas and Hacker News."],
    ["Keep what fits", `Jobs in every field, from intern to executive, in the US, Canada or remote, posted in the last ${D.rules.max_age_days} days. Anything past ${FRESH_DAYS} days moves to Over ${FRESH_DAYS} days ago. Each is tagged with its skills, field, role, seniority and job type, plus pay and work mode when stated.`],
    ["Match your resume", "Add your resume and every job gets a score out of 100 for role, seniority, years, must-have skills, other skills and degree, with skills from your latest job counting most. This happens in your browser."],
    ["Narrow it down", "Filter by how recently it was posted, field or role, seniority, skill, location, pay, work mode or job type, then open the posting on the company's own site. Applications keeps what you save or apply to."],
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
  const { view: named, key } = parseHash(location.hash);
  const view = !location.hash.slice(1) && !me ? "resume" : named, moved = view !== page;  // a first visit starts at step 1
  const closing = !key && $("#board").classList.contains("showing");
  if (moved && nav[page]) nav[page].y = scrollY;
  if (moved && page === "resume") justRead = false;
  page = view;
  if (key) tab().sel = key;
  else pushed = false;
  $("#view-jobs").hidden = !BOARDS.includes(view);
  Object.keys(VIEWS).forEach(x => { $("#view-" + x).hidden = x !== view; });
  $("#board").classList.toggle("showing", !!key);  // on a phone the hash owns the detail, so system Back closes it
  const covered = !!key && !wide();  // the phone detail covers the page, so what's behind it leaves the tab order
  document.querySelectorAll(".top, .foot, .boardhead, #nores, #filters, #olderwarn, .results").forEach(el => { el.inert = covered; });
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
    $("#view-jobs").hidden = false;
    $("#list").innerHTML = '<li class="empty">No job data yet. Run <code>python3 fetch_jobs.py</code>, then reload.</li>';
    return;
  }
  const first = D.jobs;  // not "rows": that is the list on show, which a click on the list reads below
  Object.assign(D, { all: [], jobs: [], older: [] });
  addRows(first);
  loadResume();
  loadTracker();
  $("#updated").textContent = `Scanned ${agoShort(D.generated_at)}`;
  $("#updated").title = new Date(D.generated_at).toLocaleString();
  initScan();
  [...new Set(D.all.map(j => j.source))].sort().forEach(s => $("#src").insertAdjacentHTML("beforeend", `<option>${esc(s)}</option>`));
  $("#role").insertAdjacentHTML("beforeend", roleOptions());
  LADDER.filter(l => D.all.some(j => j.level === l)).forEach(l => $("#level").insertAdjacentHTML("beforeend", `<option>${esc(l)}</option>`));
  $("#techlist").innerHTML = ALL_SKILLS.map(k => `<option value="${esc(k)}"></option>`).join("");

  const sync = () => {
    ["q", "role", "level", "type", "src", "sort", "work"].forEach(k => { $("#" + k).value = state[k]; state[k] = $("#" + k).value; });
    $("#pay").value = state.pay; state.pay = +$("#pay").value;
    $("#min").value = state.min; $("#minv").textContent = state.min;
    if (!DAYS.includes(state.days)) state.days = FRESH_DAYS;  // a choice saved by an older version
    $("#hideapplied").checked = state.hideApplied;
    press("#where", state.where); press("#mode", state.mode);
  };
  const changed = () => {  // a filter change ends any deep link, so the list picks the selection again
    tab().limit = 40;
    if (parseHash(location.hash).key) history.replaceState(null, "", "#" + page);
    renderBoard();
  };
  const set = (k, v) => { state[k] = v; changed(); };
  // The box as it reads when the pause ends, since Clear filters may have emptied it; the page may no longer be a list.
  const search = later(() => { state.q = $("#q").value; if (BOARDS.includes(page)) changed(); });
  $("#q").addEventListener("input", search);
  ["role", "level", "type", "src", "sort", "work"].forEach(k => $("#" + k).addEventListener("change", e => set(k, e.target.value)));
  $("#pay").addEventListener("change", e => set("pay", +e.target.value));
  $("#min").addEventListener("input", e => { $("#minv").textContent = e.target.value; set("min", +e.target.value); });
  $("#ages").addEventListener("click", e => {  // Over 30 days ago is its own page, with its warning
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.v === "older") return void (location.hash = "#older");
    state.days = +b.dataset.v; nav.jobs.limit = 40;
    page === "jobs" ? changed() : (location.hash = "#jobs");
  });
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
  $("#reset").addEventListener("click", () => { Object.assign(state, DEFAULTS, { techs: [], sort: state.sort, hideApplied: state.hideApplied, autoRole: state.autoRole }); sync(); changed(); });
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

  $("#file").addEventListener("change", e => { onFile(e.target.files[0]); e.target.value = ""; });
  $("#me").addEventListener("click", e => {
    const id = e.target.id;
    if (id === "pick") $("#file").click();
    // Each redraw replaces the pane, so focus goes back where the person was working.
    if (id === "pastebtn") { pasting = !pasting; renderMe(); $(pasting ? "#pastetext" : "#pastebtn")?.focus(); }
    if (id === "usepaste") { const t = $("#pastetext").value; reads++; t.trim() ? useResume(PASTED, t) : (status = "Paste your resume text first.", renderMe(), $("#pastetext")?.focus()); }  // reads++: a file still loading no longer counts
    if (id === "forget") { reads++; me = null; status = ""; nav.jobs.y = nav.older.y = 0; store.set("wradar-resume", null); refresh(); $("#pick")?.focus(); }  // reads++ drops a read still going
    const k = e.target.closest(".xchip button")?.dataset.k;
    if (k) { me.skills = me.skills.filter(s => s !== k); delete me.evidence[k]; saveMe(); $("#addskill")?.focus(); }
  });
  const setYears = later(v => { if (me) { me.years = v === "" ? null : +v; saveMe(); $("#years")?.focus(); } });  // 0 is a real answer; Remove may come first
  $("#me").addEventListener("change", e => {
    if (e.target.id === "years") setYears(e.target.value);
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
  matchMedia("(min-width: 821px)").addEventListener?.("change", route);  // a phone turned sideways may stop covering the list with the detail
  window.addEventListener("storage", e => {  // a mark made in another tab; Your resume isn't redrawn, so text being typed there stays
    if (e.key === "wradar-tracker") { loadTracker(); BOARDS.includes(page) ? route() : renderCounts(); }
  });
  sync();
  refresh();
  requestAnimationFrame(() => requestAnimationFrame(loadOlder));  // the second frame comes after the first paint
}
init();
