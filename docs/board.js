"use strict";
// wradar board: Matching jobs (#jobs and #older) and Applications share one list and detail pane.
// The first half never touches the page, so tests can load it. The rest reads app.js and tracker.js at call time.
const DAY = 864e5, FRESH_DAYS = 30, WORK_HOURS_A_YEAR = 2080;
const BOARDS = ["jobs", "older", "mine"], PAGES = [...BOARDS, "resume", "insights", "sources"];
const CURRENCY = { USD: "$", CAD: "CA$", GBP: "£", EUR: "€" };

const postedAt = j => (j.ms ??= +new Date(j.posted || j.first_seen));  // read once per row: sorting and counts ask for it often
const age = (j, now = Date.now()) => (now - postedAt(j)) / DAY;
const isOlder = (j, now) => age(j, now) > FRESH_DAYS;
const within = (j, days) => Math.floor(age(j)) <= days;  // whole days, as a row's "2 days ago" reads
const isNew = j => within(j, 2);  // posted in the last 2 days, as Posted reads it
const jobKey = j => `${j.company}|${j.title}`.toLowerCase();
const splitAge = (jobs, now = Date.now()) => ({ older: jobs.filter(j => isOlder(j, now)), fresh: jobs.filter(j => !isOlder(j, now)) });

const annualPay = s => {
  if (!s) return null;
  const x = s.per === "hour" ? WORK_HOURS_A_YEAR : 1;
  return { min: s.min * x, max: s.max * x, cur: s.cur };
};

function payLabel(s) {
  const pay = annualPay(s);
  if (!pay) return "";
  const [lo, hi] = [pay.min, pay.max].map(n => Math.round(n / 1000));
  return `${CURRENCY[pay.cur] || pay.cur + " "}${lo}k${hi > lo ? `–${hi}k` : ""}`;
}

// Pay and work mode drop jobs that don't state them, and the list says how many went.
function knownOnly(jobs, pay, work) {
  const kept = [];
  let noPay = 0, noMode = 0;
  for (const j of jobs) {
    const yearly = annualPay(j.salary);
    const payOk = !pay || (yearly && yearly.max >= pay), modeOk = !work || j.mode === work;
    if (pay && !yearly && modeOk) noPay++;
    if (work && !j.mode && payOk) noMode++;
    if (payOk && modeOk) kept.push(j);
  }
  return { kept, noPay, noMode };
}

const hasTech = (j, f) => !f.techs.length || (f.mode === "all" ? f.techs.every(t => j.skills.includes(t)) : f.techs.some(t => j.skills.includes(t)));
const searchText = j => (j.text ??= [j.title, j.company, j.location, j.role, j.field, ...j.skills].join(" ").toLowerCase());
const hasRole = (j, role) => !role || (role.startsWith("field:") ? j.field === role.slice(6) : j.role === role);  // "field:Sales" is every Sales family

function matches(j, f, { tech = true } = {}) {
  const q = f.q.toLowerCase();
  return (j.score == null || j.score >= f.min)
    && (!tech || hasTech(j, f))
    && hasRole(j, f.role)
    && (!f.level || j.level === f.level)
    && (!f.where || j.where.includes(f.where))
    && (!f.type || j.type === f.type)
    && (!f.src || j.source === f.src)
    && (!q || searchText(j).includes(q));
}

// The first n of a sorted copy, without sorting everything. Not "top": that is window.top in a browser.
function topN(a, n, cmp) {
  const best = [];
  for (const x of a) {
    if (best.length === n && cmp(x, best[n - 1]) >= 0) continue;
    let i = best.length;
    while (i && cmp(x, best[i - 1]) < 0) i--;
    best.splice(i, 0, x);
    if (best.length > n) best.pop();
  }
  return best;
}

// A saved minimum match was on the old scale, so it resets the first time this version loads.
const savedFilters = (saved, defaults) => ({ ...defaults, ...saved, ...(saved?.v === defaults.v ? {} : { v: defaults.v, min: defaults.min }) });

function parseHash(hash) {
  const [name, raw] = hash.slice(1).split("/");
  const view = PAGES.includes(name) ? name : "jobs";
  if (view !== name || !raw || !BOARDS.includes(view)) return { view, key: null };
  try { return { view, key: decodeURIComponent(raw) }; } catch { return { view, key: null }; }
}
const hashFor = (view, key) => `#${view}/${encodeURIComponent(key)}`;

// ---- Pages: 25 rows each ----
const PER_PAGE = 25;
const pageOf = n => Math.floor(n / PER_PAGE);  // -1 for a job not in the list

// Page numbers from 1, null for a gap: the first, the last and the current one's neighbours, in seven places at most so the pager keeps its width.
function pageList(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (cur <= 4) return [1, 2, 3, 4, 5, null, total];
  if (cur >= total - 3) return [1, null, total - 4, total - 3, total - 2, total - 1, total];
  return [1, null, cur - 1, cur, cur + 1, null, total];
}

if (typeof module !== "undefined") module.exports = { jobKey, age, within, isNew, splitAge, annualPay, payLabel, knownOnly, matches, topN, savedFilters, parseHash, hashFor, PER_PAGE, pageList };

// ---- Loading: jobs.js at init, then older.js, the rows past 30 days, after the first paint ----
let olderIn = false;  // until older.js has loaded or failed, a job not found may be in it

// One row per key: an older.js from another scan may repeat a row of jobs.js.
function addRows(rows) {
  const added = rows.filter(j => !byKey.has(jobKey(j)));
  added.forEach(j => {
    Object.assign(j, { i: D.all.length, key: jobKey(j), field: fieldOf(j.role) });
    j.must ||= []; j.nice ||= [];
    byKey.set(j.key, j);
    D.all.push(j);
  });
  const { fresh, older } = splitAge(added);
  D.jobs = D.jobs.concat(fresh);
  D.older = D.older.concat(older);
  return added.length;
}

// A script tag, unlike fetch, also works from a file:// copy. ?v= asks for the older.js of this scan, not a cached one.
// Data from before older.js has none, so a failed load just means no older rows.
function loadOlder() {
  document.head.append(Object.assign(document.createElement("script"), { src: "older.js?v=" + encodeURIComponent(D.generated_at),
    onload: () => joinOlder(window.JOB_OLDER?.jobs || []), onerror: () => joinOlder([]) }));
}

// The match stats count every row, so they are built again and every job scored again.
// Only what the older rows change is drawn again, with focus kept: Your resume keeps its own pane, which may hold text being pasted.
// The new scores may reorder the list, so the selected job keeps its place and the page turns to it.
function joinOlder(rows) {
  const sel = BOARDS.includes(page) && tab().sel, waited = sel && !byKey.has(sel);
  olderIn = true;
  if (addRows(rows)) { stats = null; scoreJobs(); }
  if (BOARDS.includes(page)) return redrawBoard(sel, waited);
  renderCounts();
  if (page === "insights") renderInsights();  // its hot and warm counts; Sources shows nothing older.js brings
  if (page !== "resume") return;
  const i = $("#mybest").contains(document.activeElement) && document.activeElement.dataset.i;  // Your best matches may reorder
  renderSide();
  if (i) ($(`#mybest [data-i="${i}"]`) || $("#mybest button"))?.focus({ preventScroll: true });
}

// A job the detail waited for is announced, and on a phone a link opened there gets the focus route() gives it.
function redrawBoard(sel, waited) {
  const was = document.activeElement, inList = $("#list").contains(was), inDetail = $("#detail").contains(was);
  const covered = $("#board").classList.contains("showing") && !wide() && (!was || was === document.body);
  renderBoard(true);
  if (inDetail || covered) $("#dtitle")?.focus({ preventScroll: true });
  else if (inList) focusBoard();
  if (!waited) return;
  $("#list .jitem[aria-current=true]")?.scrollIntoView({ block: "nearest" });
  announce(byKey.has(sel) ? `${byKey.get(sel).title} at ${byKey.get(sel).company}` : "This job is no longer listed.");
}

// ---- Rows ----
const nav = Object.fromEntries(BOARDS.map(v => [v, { sel: null, pg: 0, y: 0 }]));  // each tab keeps its own place; pg, its page from 0, lasts until a reload
let page = "jobs", rows = [], pushed = false;
const tab = () => nav[page];
const announce = text => { $("#live").textContent = text; };
const postedText = j => (j.posted_approx ? "30+ days ago" : ago(j.posted));
const rowOf = key => byKey.get(key) || (Object.hasOwn(tracker, key) ? { ...tracker[key], key, delisted: true } : null);  // a link's key may be "constructor"
const matchNum = j => (j.score == null ? "" : `<span class="match ${tier(j.score)}">${j.score}</span>`);

const rowPlace = j => j.where.filter(w => w !== j.mode).join(" / ");
const rowWhen = j => (j.delisted ? (olderIn ? "No longer listed" : "") : isNew(j) ? "New" : postedText(j));  // it may still be in older.js
const rowLabel = j => [`${j.title} at ${j.company}`, j.score != null && `match ${j.score}, ${tier(j.score)}`, payLabel(j.salary), j.mode, rowPlace(j), rowWhen(j), statusText(j)].filter(Boolean).join(", ");

function item(j, n, stop) {
  const s = statusOf(j), on = j.key === tab().sel, pay = payLabel(j.salary);
  const facts = [j.mode, rowPlace(j)].filter(Boolean).map(x => `<span class="jfact">${esc(x)}</span>`).join("");
  return `<li><button type="button" class="jitem${s === "applied" ? " applied" : ""}" data-n="${n}" aria-current="${on}" tabindex="${j.key === stop ? 0 : -1}" aria-label="${esc(rowLabel(j))}">
    ${matchNum(j)}
    <span class="jtext">
      <span class="jline"><span class="jtitle">${esc(j.title)}</span>${s ? `<span class="tag ${s}">${esc(statusText(j))}</span>` : ""}</span>
      <span class="jline"><span class="jco">${esc(j.company)}</span><span class="jwhen${isNew(j) ? " fresh" : ""}">${esc(rowWhen(j))}</span></span>
      <span class="jline jfacts">${pay ? `<span class="jpay">${esc(pay)}</span>` : ""}${facts}</span>
    </span>
  </button></li>`;
}

function emptyText() {
  if (page === "mine") return MINE_EMPTY[mineSeg];
  if (page === "older") return olderIn ? "No older jobs match these filters. Try clearing one." : "Loading the older jobs…";
  if (state.days < FRESH_DAYS && listed({ jobs: unhidden(D.jobs) }).kept.length) return `No jobs posted in the last ${state.days} days match these filters. Try a longer time under Posted.`;
  const n = listed({ jobs: unhidden(D.older) }).kept.length;
  return n ? `No jobs match these filters. <a href="#older">${plural(n, "older job")} ${n === 1 ? "does" : "do"}.</a>` : "No jobs match these filters. Try clearing one.";
}

function renderList() {
  const t = tab(), first = t.pg * PER_PAGE, shown = rows.slice(first, first + PER_PAGE);
  const stop = shown.some(j => j.key === t.sel) ? t.sel : shown[0]?.key;  // the one row Tab lands on; arrows do the rest
  $("#list").innerHTML = shown.map((j, n) => item(j, first + n, stop)).join("") || `<li class="empty">${emptyText()}</li>`;
  renderPager();
}

const showingText = () => { const first = tab().pg * PER_PAGE; return `Showing ${(first + 1).toLocaleString()}–${Math.min(first + PER_PAGE, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`; };

// Previous, the range shown and Next, then the page numbers: two rows, so it fits a narrow list and a phone, in the order Tab takes.
function renderPager() {
  const t = tab(), pages = Math.ceil(rows.length / PER_PAGE);
  $("#pager").hidden = pages < 2;
  const end = (pg, cls, label, text) => `<button type="button" class="btn line ${cls}" data-pg="${pg}" aria-label="${label}"${pg < 0 || pg >= pages ? " disabled" : ""}>${text}</button>`;
  const num = n => (n ? `<li><button type="button" class="btn line" data-pg="${n - 1}" aria-label="Page ${n}"${n - 1 === t.pg ? ' aria-current="page"' : ""}>${n.toLocaleString()}</button></li>`
    : '<li class="gap" aria-hidden="true">…</li>');
  $("#pager").innerHTML = `${end(t.pg - 1, "pprev", "Previous page", "Previous")}<p class="showing">${showingText()}</p>${end(t.pg + 1, "pnext", "Next page", "Next")}
    <ol class="pages">${pageList(t.pg + 1, pages).map(num).join("")}</ol>`;
}

// Focus goes to the new page's first row, which a wide screen also selects, after any page change.
function turnPage(pg) {
  tab().pg = pg;
  history.replaceState(null, "", "#" + page);  // a key in the hash would turn the page back to that job
  renderBoard();
  const first = $("#list .jitem");
  first?.scrollIntoView({ block: "nearest" });
  first?.focus({ preventScroll: true });
  announce(showingText());
}

function countText(total, noPay, noMode) {
  const left = (n, what) => (n ? `, ${n.toLocaleString()} more ${n === 1 ? "doesn't" : "don't"} list ${what}` : "");
  return (rows.length === total ? plural(total, "job") : `${rows.length.toLocaleString()} of ${plural(total, "job")}`) + left(noPay, "pay") + left(noMode, "work mode");
}

// follow: the page turns to the selected job, as it does for a link.
function renderBoard(follow = false) {
  const t = tab(), mine = page === "mine", shown = t.sel;
  store.set("wradar-filters", state);
  $("#boardtitle").textContent = mine ? "Applications" : me ? "Matching jobs" : "All jobs";
  $("#filters").hidden = mine;
  $("#minebar").hidden = !mine;
  $("#nores").hidden = (me && !unread()) || mine;  // a resume saved by an older version reads less, so it's asked for again
  $("#norestext").innerHTML = me
    ? "<b>Add your resume again for better scores.</b> It was saved before wradar read jobs and projects apart, so matches use less of it."
    : "<b>Add your resume to rank these jobs by fit.</b> Each job then shows why you fit, what's missing from your resume, and what to do before you apply.";
  $("#olderwarn").hidden = page !== "older";
  $("#sortwrap").hidden = $("#hideappliedwrap").hidden = mine;
  renderCounts();
  const got = mine ? { kept: mineRows(tracker, mineSeg, byKey), noPay: 0, noMode: 0 } : listed();
  rows = got.kept;
  const link = !!parseHash(location.hash).key, at = rows.findIndex(j => j.key === t.sel);
  if (at >= 0 && (link || follow)) t.pg = pageOf(at);
  t.pg = Math.max(0, Math.min(t.pg, pageOf(rows.length - 1)));  // fewer rows, fewer pages
  if (!link && pageOf(at) !== t.pg) t.sel = wide() && rows.length ? rows[t.pg * PER_PAGE].key : null;  // a job off this page, or not listed, gives way
  if (!mine) renderFilters(got);
  $("#count").textContent = countText(mine ? rows.length : pool().length, got.noPay, got.noMode);
  renderList();
  $("#detail").innerHTML = detail(rowOf(t.sel));
  if (t.sel !== shown) $("#detail").scrollTop = 0;  // another job now, so it starts at its title
}

// ---- Detail ----
const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
const NOT_LISTED = '<span class="na">Not listed</span>';

function payFact(s) {
  if (!s) return NOT_LISTED;
  const sign = CURRENCY[s.cur] || s.cur + " ";
  return `${esc(payLabel(s))} a year${s.per === "hour" ? `, from ${esc(sign)}${s.min}–${s.max} an hour` : ""}`;
}

function gauge(j) {
  const c = 2 * Math.PI * 30, v = j.score / 100 * c;
  return `<div class="gauge ${tier(j.score)}">
    <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true"><circle class="g-track" cx="38" cy="38" r="30" fill="none" stroke-width="7"/>
      <circle class="g-val" cx="38" cy="38" r="30" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${v.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 38 38)"/>
      <text x="38" y="45" text-anchor="middle">${j.score}</text></svg></div>`;
}

const part = p => `<li${p.max ? "" : ' class="off"'}><b>${esc(p.name)}</b><i style="--w:${p.max ? Math.round(100 * p.got / p.max) : 0}%"></i><span>${esc(p.note)}</span></li>`;
const advice = (title, lines, cls) => (lines.length ? `<section class="card advice ${cls}"><h3>${title}</h3><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></section>` : "");

function reading(j) {
  if (!j.fit) return '<div class="nudge"><p><b>How well do you fit?</b> Add your resume to see your match for this job, and what to do before you apply.</p><a class="btn" href="#resume">Add your resume</a></div>';
  return `<section class="card fitbox" aria-labelledby="fith">
      <div class="fithead">${gauge(j)}<div><h3 id="fith">${TIER[tier(j.score)]}, ${j.score}</h3><p class="note">From your role, seniority, years, skills and degree.</p></div></div>
      <ol class="parts">${j.fit.parts.map(part).join("")}</ol>
    </section>
    <div class="advicegrid">${advice("Why you fit", j.fit.fits, "fit")}${advice("Gaps", j.fit.gaps, "gaps")}${advice("Next steps", j.fit.next, "next")}</div>`;
}

// Required, preferred and other skills, each marked against the resume when there is one.
function requirements(j) {
  const have = k => me.skills.includes(k);  // j.fit is there only with a resume
  const item = k => (j.fit ? `<li class="${have(k) ? "have" : "miss"}">${esc(k)}<span class="sr">, ${have(k) ? "on" : "not on"} your resume</span></li>` : `<li>${esc(k)}</li>`);
  const group = (title, a) => (a.length ? `<div class="req"><h4>${title}</h4><ul class="reqs">${a.map(item).join("")}</ul></div>` : "");
  const rest = j.skills.filter(k => !j.must.includes(k) && !j.nice.includes(k));
  const body = group("Must-haves", j.must) + group("Nice to have", j.nice) + group(j.must.length + j.nice.length ? "Also mentioned" : "Skills named", rest);
  const legend = j.fit ? '<p class="reqkey" aria-hidden="true"><span class="have">On your resume</span><span class="miss">Not on your resume</span></p>' : "";
  return `<section class="card half"><h3>Skills this job asks for</h3>${body ? legend + body : '<p class="na">This posting names none of the skills wradar knows.</p>'}</section>`;
}

const DEGREE = { bachelor: "Bachelor's", master: "Master's", phd: "PhD" };
function about(j) {
  const degree = j.degree ? `${esc(DEGREE[j.degree.level] || j.degree.level)}, ${esc(j.degree.req)}` : "Not stated";
  return `<section class="card half"><h3>About this job</h3><dl class="facts">${fact("Pay", payFact(j.salary))}${fact("Work mode", j.mode ? esc(j.mode) : NOT_LISTED)}
      ${fact("Where", esc(j.where.join(" / ")))}${fact("Location as posted", esc(j.location || "Not listed"))}${fact("Role", esc(j.role))}${fact("Seniority", esc(j.level))}
      ${fact("Job type", esc(j.type))}${fact("Experience asked", j.years_required ? j.years_required + "+ years" : "Not stated")}${fact("Degree", degree)}
      ${fact("Posted", postedText(j))}${fact("Found on", esc(j.source))}${fact("Applicants", j.applicants == null ? '<span class="na">Not available</span>' : esc(j.applicants))}</dl></section>`;
}

function pills(j) {
  const pay = payLabel(j.salary);
  return `<ul class="pills">${[pay ? `<li class="pay">${esc(pay)}</li>` : '<li class="na">Pay not listed</li>', j.mode && `<li>${esc(j.mode)}</li>`,
    rowPlace(j) && `<li>${esc(rowPlace(j))}</li>`, `<li>Posted ${esc(postedText(j))}</li>`].filter(Boolean).join("")}</ul>`;
}

function actions(j) {
  const link = /^https?:\/\//.test(j.url)
    ? `<a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer" data-do="open"><span class="onwide">Apply on company site</span><span class="onphone">Apply</span><span class="sr"> (opens in a new tab)</span></a>`
    : '<span class="na">No link for this posting</span>';
  const mark = (s, label) => `<button type="button" class="btn line mark" data-do="${s}" aria-pressed="${statusOf(j) === s}">${label}</button>`;
  const ask = statusOf(j) === "applied" ? "" : `<p class="dask" id="dask" hidden><span>Did you apply?</span>
    <button type="button" class="btn" data-do="yes">Yes, mark applied</button><button type="button" class="btn line" data-do="no">Not yet</button></p>`;
  return `<div class="dactions">${link}${mark("applied", "Applied")}${mark("saved", "Save")}${mark("hidden", "Hide")}${ask}</div>`;
}

function dnav(j) {
  const at = j ? rows.findIndex(r => r.key === j.key) : -1;
  const moves = at < 0 ? "" : `<span class="dpos">${at + 1} of ${rows.length.toLocaleString()}</span>
    <button type="button" class="btn line" data-do="prev"${at ? "" : " disabled"}>Previous</button>
    <button type="button" class="btn line" data-do="next"${at + 1 < rows.length ? "" : " disabled"}>Next</button>`;
  return `<div class="dnav"><button type="button" class="btn line back" data-do="back">Back</button>${moves}</div>`;
}

const LOOKING = "Loading this job…";  // until older.js is in, a job not found may be in it

function detail(j) {
  if (!j) return `${dnav()}<div class="card empty">${!tab().sel ? "Pick a job from the list to see the details." : olderIn ? "This job is no longer listed." : LOOKING}</div>`;
  const note = text => `<p class="dnote">${text}</p>`;
  // One card per question: what and where, how well you fit, what to say, what it asks for, the rest.
  return `${dnav(j)}
    <section class="card dmain">
      <header class="dhead"><p class="dco">${esc(j.company)}</p><h2 id="dtitle" tabindex="-1">${esc(j.title)}</h2>${j.delisted ? "" : pills(j)}</header>
      ${actions(j)}
      ${rows.some(r => r.key === j.key) ? "" : note("This job isn't in the current list.")}
      ${j.delisted ? note(olderIn ? "This job wasn't in the last scan, so it may be closed." : LOOKING) : isOlder(j) ? note(`Posted ${postedText(j)}. Check the job is still open before you spend time on it.`) : ""}
    </section>
    ${j.delisted ? `<section class="card"><dl class="facts">${fact("Where", esc(j.where.join(" / ")))}</dl></section>` : `${reading(j)}${requirements(j)}${about(j)}`}`;
}

// ---- Moving between jobs ----
// Keeps the list as it is, so focus stays put and arrow keys stay quick.
function select(key) {
  const t = tab(), at = rows.findIndex(j => j.key === key);
  t.sel = key;
  if (at >= 0 && pageOf(at) !== t.pg) { t.pg = pageOf(at); renderList(); }  // stepping past either end of a page turns it
  document.querySelectorAll("#list .jitem").forEach(b => {
    const on = +b.dataset.n === at;
    b.setAttribute("aria-current", on);
    b.tabIndex = on ? 0 : -1;
  });
  $("#detail").innerHTML = detail(rowOf(key));
  $("#detail").scrollTop = 0;
  history.replaceState(null, "", hashFor(page, key));
  const row = $("#list .jitem[aria-current=true]");
  row?.scrollIntoView({ block: "nearest" });
  (wide() || !$("#board").classList.contains("showing") ? row : $("#dtitle"))?.focus({ preventScroll: true });  // on a phone the title shows only in the open detail
  announce(`${at + 1} of ${rows.length.toLocaleString()}, ${rowOf(key)?.title}`);
}

function step(d) {
  const t = tab(), at = rows.findIndex(j => j.key === t.sel);
  const next = at < 0 ? rows[t.pg * PER_PAGE] : rows[at + d];  // with nothing selected, this page's first row
  if (next) select(next.key);
}

// A row's hash is pushed on a phone, so the system Back button closes the detail.
// The key may be in the hash already, from arrow keys or a wider screen, so the page's own hash goes first and the push always lands.
function openRow(j) {
  if (wide()) return select(j.key);
  history.replaceState(null, "", "#" + page);
  pushed = true;
  location.hash = hashFor(page, j.key);
}

function closeDetail() {
  if (pushed) history.back(); else location.replace("#" + page);
}

// Puts another job in the detail after the current one left the list.
function moveTo(key) {
  tab().sel = key;
  history.replaceState(null, "", key ? hashFor(page, key) : "#" + page);
  route();
}

function focusBoard() {
  ($("#board").classList.contains("showing") && !wide() ? $("#dtitle") : $("#list .jitem[aria-current=true]"))?.focus({ preventScroll: true });
}

function act(name) {
  const j = rowOf(tab().sel);
  const run = {
    back: closeDetail, prev: () => step(-1), next: () => step(1),
    open: () => { const ask = $("#dask"); if (ask) { ask.hidden = false; announce("Did you apply?"); } },
    yes: () => setMark(j, "applied"), no: () => { $("#dask").hidden = true; },
    applied: () => setMark(j, "applied"), saved: () => setMark(j, "saved"), hidden: () => hideJob(j),
  };
  run[name]?.();
}
