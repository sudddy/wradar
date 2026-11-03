"use strict";
// The real scripts in one context, as the browser loads them, on a stub DOM.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const board = require("../docs/board.js");

const DAY = 864e5;
const daysAgo = d => new Date(Date.now() - d * DAY).toISOString();
const job = (over = {}) => ({ title: "Software Engineer", company: "Acme", where: ["US"], location: "Boston", url: "https://acme.test/1", skills: ["Go"],
  source: "Greenhouse", role: "Backend", level: "Mid", type: "Full-time", score: null, posted: daysAgo(1), first_seen: daysAgo(1),
  salary: { min: 100000, max: 150000, cur: "USD", per: "year" }, mode: "Remote", ...over });

// Each selector is one stub element,
// so a test reads what a render wrote (textContent, innerHTML) and calls the handlers the page set.
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const SCRIPTS = ["match.js", "resume.js", "board.js", "tracker.js", "scan.js", "app.js"].map(f => [f, read("docs/" + f)]);
const REAL = (() => { const sandbox = { window: {} }; vm.runInNewContext(read("docs/jobs.js"), sandbox); return sandbox.window.JOB_DATA; })();
const RESUME = read("tests/fixtures/priya-raman.txt");
const row = (n, over) => job({ title: `Backend Engineer ${n}`, company: `Co${n}`, posted: daysAgo(1 + n), first_seen: daysAgo(1 + n),
  must: ["Go"], nice: [], years_required: 3, applicants: null, degree: null, posted_approx: false, ...over });
const pageData = (over = {}) => ({ generated_at: new Date(Date.now() - 2 * 36e5).toISOString(), slow_fetched_at: null, keywords: REAL.keywords,
  rules: { ...REAL.rules, scan_url: "" }, sources: [{ name: "Co", kind: "Greenhouse", url: "https://co.test", ok: true, seen: 9, kept: 5 }],
  jobs: [row(0), row(1), row(2), row(3), row(40)], ...over });

function openPage({ wide = true, keyboard = false, storage = new Map(), data = pageData(), at = "#jobs" } = {}) {
  const els = {}, scripts = [], winOn = {}, back = [], doc = { activeElement: null };
  let hash = at;
  const fire = (on, type, e = {}) => (on[type] || []).forEach(fn => fn({ preventDefault() {}, composedPath: () => [], ...e }));
  const element = () => {
    const on = {}, classes = new Set(), kids = {};
    const el = {
      hidden: false, disabled: false, value: "", textContent: "", innerHTML: "",
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, force = !classes.has(c)) => (force ? classes.add(c) : classes.delete(c)) },
      setAttribute() {}, addEventListener: (type, fn) => (on[type] ||= []).push(fn), fire: (type, e) => fire(on, type, e),
      querySelector: s => (kids[s] ||= element()), querySelectorAll: () => [], contains: x => x === el || Object.values(kids).includes(x),
      focus() { doc.activeElement = el; el.onfocus?.(); }, matches: s => s === ":focus-visible" && keyboard && doc.activeElement === el,
      scrollIntoView() {}, insertAdjacentHTML() {},
    };
    return el;
  };
  Object.assign(doc, {
    querySelector: s => (s.startsWith("script") ? scripts.find(x => s.includes(`"${x.src}"`)) || null : (els[s] ||= element())),
    querySelectorAll: () => [], addEventListener() {}, createElement: element, head: { append: x => scripts.push(x) },
  });
  const changed = () => fire(winOn, "hashchange");
  const context = vm.createContext({
    document: doc, JOB_DATA: data, console, scrollY: 0, scrollTo() {},
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    matchMedia: () => ({ matches: wide }),
    location: {
      get hash() { return hash; },
      set hash(v) { if (v !== hash) { back.push(hash); hash = v; changed(); } },
      replace(v) { if (v !== hash) { hash = v; changed(); } },
    },
    history: { replaceState: (state, title, v) => { hash = v; }, back: () => { hash = back.pop(); changed(); } },
    addEventListener: (type, fn) => (winOn[type] ||= []).push(fn),
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: id => clearTimeout(id),  // unref: a test never waits on the page's timers
  });
  context.window = context;
  for (const [filename, src] of SCRIPTS) vm.runInContext(src, context, { filename });
  const run = code => vm.runInContext(code, context);
  const go = to => run(`location.hash = ${JSON.stringify(to)}`);
  return { $: doc.querySelector, doc, run, go, scripts, storage, context, fireWindow: (type, e) => fire(winOn, type, e), hash: () => hash };
}
const withResume = page => { page.context.RESUME = RESUME; page.run("useResume('Pasted resume', RESUME)"); return page; };
const undoButton = page => page.$("#toast").querySelector("button");

test("the page loads on the stub", () => {
  const page = openPage();
  assert.equal(page.$("#count").textContent, "4 jobs");
  assert.match(page.$("#list").innerHTML, /Backend Engineer 0/);
});

test("a first visit with no resume opens on step 1, the welcome, with a way to browse anyway", () => {
  const page = openPage({ at: "" });
  assert.equal(page.run("page"), "resume");
  assert.match(page.$("#me").innerHTML, /Drop your resume here/);
  assert.match(page.$("#me").innerHTML, /href="#jobs">Browse jobs without a resume/);
  assert.equal(page.$("#meside").hidden, true);
  assert.equal(page.$("#s1").textContent, "Start here");
});

test("with a saved resume the bare address opens the matching jobs", () => {
  const storage = new Map();
  withResume(openPage({ storage }));
  const page = openPage({ storage, at: "" });
  assert.equal(page.run("page"), "jobs");
  assert.match(page.$("#s2").textContent, /hot match/);
  assert.equal(page.$("#boardtitle").textContent, "Matching jobs");
});

test("a resume read on the welcome stays on Your resume and points on to the matches, once", () => {
  const page = withResume(openPage({ at: "" }));
  assert.equal(page.hash(), "#resume");
  assert.equal(page.run("page"), "resume");
  assert.match(page.$("#me").innerHTML, /Your resume is in\./);
  assert.match(page.$("#me").innerHTML, /<a class="btn big" href="#jobs">See your/);
  page.go("#jobs");
  page.go("#resume");
  assert.doesNotMatch(page.$("#me").innerHTML, /Your resume is in/);
});

test("without a resume the jobs list asks for one, and the detail lists skills unmarked", () => {
  const page = openPage();
  assert.equal(page.$("#nores").hidden, false);
  assert.equal(page.$("#boardtitle").textContent, "Software jobs");
  assert.match(page.$("#detail").innerHTML, /<h4>Must-haves<\/h4><ul class="reqs"><li>Go<\/li>/);
  assert.match(page.$("#detail").innerHTML, /How well do you fit\?/);
});

test("with a resume the detail marks each required skill as on or not on it", () => {
  const page = withResume(openPage());
  assert.equal(page.$("#nores").hidden, true);
  assert.match(page.$("#detail").innerHTML, /<li class="(have|miss)">Go<span class="sr">, (on|not on) your resume<\/span><\/li>/);
  assert.doesNotMatch(page.$("#detail").innerHTML, /you lack|you're missing/i);
});

test("a resume saved by an older version is asked for again on the jobs", () => {
  const storage = new Map([["wradar-resume", JSON.stringify({ name: "PDF resume", skills: ["Go", "Python"], years: 5 })]]);
  const page = openPage({ storage });
  assert.equal(page.$("#nores").hidden, false);
  assert.match(page.$("#norestext").innerHTML, /Add your resume again for better scores/);
});

test("reading a resume drops the saved scroll spot, since the list now sorts by match", () => {
  const page = openPage();
  page.run("nav.jobs.y = nav.older.y = 3000");
  withResume(page);
  assert.deepEqual([page.run("nav.jobs.y"), page.run("nav.older.y")], [0, 0]);
});

test("the Hide toast closes 8 seconds after a mouse or touch Hide, and focus returns to the list", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = openPage();
  page.run("hideJob(rows[0])");
  assert.equal(page.$("#toast").hidden, false);
  assert.equal(page.doc.activeElement, undoButton(page));
  t.mock.timers.tick(7999);
  assert.equal(page.$("#toast").hidden, false);
  t.mock.timers.tick(1);
  assert.equal(page.$("#toast").hidden, true);
  assert.equal(page.doc.activeElement, page.$("#list .jitem[aria-current=true]"));
});

test("a pointer on the toast holds it, and leaving starts the 8 seconds again", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = openPage(), toast = page.$("#toast");
  page.run("hideJob(rows[0])");
  t.mock.timers.tick(5000);
  toast.onpointerenter();
  t.mock.timers.tick(60000);
  assert.equal(toast.hidden, false);
  toast.onpointerleave();
  t.mock.timers.tick(7999);
  assert.equal(toast.hidden, false);
  t.mock.timers.tick(1);
  assert.equal(toast.hidden, true);
});

test("a keyboard user keeps the toast while focus is on Undo, and it closes 8 seconds after focus leaves", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = openPage({ keyboard: true }), toast = page.$("#toast");
  page.run("hideJob(rows[0])");
  t.mock.timers.tick(60000);
  assert.equal(toast.hidden, false);
  undoButton(page).onblur();
  t.mock.timers.tick(7999);
  assert.equal(toast.hidden, false);
  undoButton(page).onfocus();  // back on Undo: it waits again
  t.mock.timers.tick(60000);
  assert.equal(toast.hidden, false);
  undoButton(page).onblur();
  t.mock.timers.tick(8000);
  assert.equal(toast.hidden, true);
});

test("a later mark closes the toast, so an old Undo can't erase it", () => {
  const page = openPage();
  const key = page.run("rows[0].key");
  page.run("hideJob(rows[0])");
  page.run("setMark(rowOf(" + JSON.stringify(key) + "), 'applied')");
  assert.equal(page.$("#toast").hidden, true);
  assert.equal(JSON.parse(page.storage.get("wradar-tracker"))[key].s, "applied");
});

test("Undo on another page puts the job back and leaves that page where it was", () => {
  for (const to of ["#resume", "#insights", "#sources", "#older"]) {
    const page = openPage();
    const key = page.run("rows[0].key");
    page.run("hideJob(rows[0])");
    page.go(to);
    assert.doesNotThrow(() => undoButton(page).onclick());
    assert.deepEqual(JSON.parse(page.storage.get("wradar-tracker")), {});
    assert.equal(page.hash(), to);
    assert.doesNotMatch(page.$("#detail").innerHTML, /isn't in the current list/);
    assert.equal(page.$("#live").textContent, "Job back in the list");
    page.go("#jobs");
    assert.equal(page.run("rows[0].key"), key);
  }
});

test("Undo on the same page selects the job again", () => {
  const page = openPage();
  const key = page.run("rows[0].key");
  page.run("hideJob(rows[0])");
  undoButton(page).onclick();
  assert.equal(page.run("nav.jobs.sel"), key);
  assert.equal(page.hash(), board.hashFor("jobs", key));
});

test("a mark in one tab keeps the marks another tab made", () => {
  const storage = new Map(), a = openPage({ storage }), b = openPage({ storage });
  const [first, second] = [a.run("rows[0].key"), a.run("rows[1].key")];
  a.run("setMark(rows[0], 'applied')");
  b.run("setMark(rows[1], 'saved')");
  b.run("hideJob(rows[2])");
  const stored = JSON.parse(storage.get("wradar-tracker"));
  assert.equal(stored[first].s, "applied");
  assert.equal(stored[second].s, "saved");
  undoButton(b).onclick();
  assert.equal(JSON.parse(storage.get("wradar-tracker"))[first].s, "applied");
});

test("an open tab shows marks made in another tab", () => {
  const storage = new Map(), a = openPage({ storage }), b = openPage({ storage });
  a.run("setMark(rows[0], 'applied')");
  b.fireWindow("storage", { key: "wradar-tracker" });
  assert.equal(b.run("statusOf(rows[0])"), "applied");
  assert.equal(b.$("#n-mine").textContent, "1");
});

test("a mark from another tab updates the counts but leaves Your resume as it is", () => {
  const storage = new Map(), a = openPage({ storage }), b = openPage({ storage });
  b.go("#resume");
  b.$("#me").innerHTML = "text being pasted";
  a.run("setMark(rows[0], 'saved')");
  b.fireWindow("storage", { key: "wradar-tracker" });
  assert.equal(b.$("#me").innerHTML, "text being pasted");
  assert.equal(b.$("#n-mine").textContent, "1");
});

test("the Last 30 days and Older counts show when the page first opens away from the boards", () => {
  const page = openPage({ at: "#insights" });
  assert.equal(page.$("#n-jobs").textContent, "4");
  assert.equal(page.$("#n-older").textContent, "1");
});

test("only plain text files are read as text", async () => {
  const page = openPage();
  page.context.F = { name: "cv.rtf", type: "text/rtf", text: async () => "{\\rtf1 Java}" };
  await assert.rejects(page.run("readFile(F)"), /isn't supported/);
  page.context.F = { name: "cv", type: "text/plain", text: async () => "Java" };
  assert.equal(await page.run("readFile(F)"), "Java");
});

test("a pasted resume isn't replaced by a file read that finishes later", async () => {
  const page = openPage();
  page.context.F = { name: "cv.txt", type: "text/plain", text: () => new Promise(done => setTimeout(() => done("Skills: Go, Rust, React"), 20)) };
  page.run("onFile(F)");
  page.$("#pastetext").value = RESUME;
  page.$("#me").fire("click", { target: { id: "usepaste", closest: () => null } });
  await new Promise(done => setTimeout(done, 40));
  assert.equal(page.run("me.name"), "Pasted resume");
});

test("on a phone a row opens even when its key is already in the hash, and Back closes it", () => {
  const page = openPage({ wide: false });
  page.run(`history.replaceState(null, "", hashFor("jobs", rows[0].key))`);  // as a tap on a wider screen leaves it
  page.run("openRow(rows[0])");
  assert.equal(page.$("#board").classList.contains("showing"), true);
  page.run("act('back')");
  assert.equal(page.$("#board").classList.contains("showing"), false);
  assert.equal(page.hash(), "#jobs");
});

test("on a phone arrow keys move focus with the highlight, and Next in the detail keeps it on the title", () => {
  const page = openPage({ wide: false });
  for (let n = 0; n < 2; n++) page.$("#list").fire("keydown", { key: "ArrowDown", target: { closest: () => true } });
  assert.equal(page.run("nav.jobs.sel"), page.run("rows[1].key"));
  assert.equal(page.doc.activeElement, page.$("#list .jitem[aria-current=true]"));
  page.run("openRow(rows[1])");
  page.run("act('next')");
  assert.equal(page.run("nav.jobs.sel"), page.run("rows[2].key"));
  assert.equal(page.doc.activeElement, page.$("#dtitle"));
});

test("a link to a key such as constructor shows a job no longer listed", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const page = openPage();
    assert.doesNotThrow(() => page.go("#jobs/" + key), key);
    assert.match(page.$("#detail").innerHTML, /This job is no longer listed\./, key);
  }
});

test("the Sort control shows the order in use", () => {
  const page = openPage(), sort = page.$("#sort");
  assert.equal(sort.value, "new");  // no resume, so newest first
  assert.equal(sort.disabled, true);
  page.run("state.sort = 'new'");
  withResume(page);
  assert.equal(page.run("state.sort"), "score");
  assert.equal(sort.value, "score");
  assert.equal(sort.disabled, false);
});

test("Remove during a read keeps the resume removed", async () => {
  const page = withResume(openPage());
  let finish;
  page.context.FILE = { name: "cv.txt", type: "text/plain", text: () => new Promise(ok => { finish = ok; }) };
  const reading = page.run("onFile(FILE)");
  page.$("#me").fire("click", { target: { id: "forget", closest: () => null } });
  finish(RESUME);
  await reading;
  assert.equal(page.run("me"), null);
  assert.equal(page.storage.has("wradar-resume"), false);
});

test("typing 0 years keeps 0, and an empty box clears it", () => {
  const page = withResume(openPage());
  page.$("#me").fire("change", { target: { id: "years", value: "0" } });
  assert.equal(page.run("me.years"), 0);
  assert.equal(JSON.parse(page.storage.get("wradar-resume")).years, 0);
  page.$("#me").fire("change", { target: { id: "years", value: "" } });
  assert.equal(page.run("me.years"), null);
});

test("PDF and Word readers load from cdnjs only with an integrity hash", async () => {
  const page = openPage();
  page.run(`readFile({ name: "cv.pdf", arrayBuffer: async () => new ArrayBuffer(0) }).catch(() => {})`);
  page.scripts[0].onload();
  await new Promise(setImmediate);
  page.run(`readFile({ name: "cv.docx", arrayBuffer: async () => new ArrayBuffer(0) }).catch(() => {})`);
  assert.deepEqual(page.scripts.map(s => s.src.split("/").pop()), ["pdf.min.js", "pdf.worker.min.js", "mammoth.browser.min.js"]);
  for (const s of page.scripts) {
    assert.match(s.src, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\//);
    assert.match(s.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, s.src);
    assert.equal(s.crossOrigin, "anonymous");
  }
});

test("the top bar says how long ago the scan ran", () => {
  for (const [ms, text] of [[2 * 36e5 + 6e5, "Scanned 2h ago"], [25 * 6e4, "Scanned 25m ago"], [3 * DAY + 36e5, "Scanned 3 days ago"]]) {
    const page = openPage({ data: pageData({ generated_at: new Date(Date.now() - ms).toISOString() }) });
    assert.equal(page.$("#updated").textContent, text);
  }
});

test("Insights never says you're missing a skill", () => {
  for (const page of [openPage(), withResume(openPage())]) {
    page.go("#insights");
    assert.doesNotMatch(page.$("#charts").innerHTML, /you're missing|you lack/i);
    assert.match(page.$("#charts").innerHTML, /<h2>Skills to add<\/h2>/);
  }
});

test("Sources doesn't claim every source was read on the last scan", () => {
  const page = openPage();
  page.go("#sources");
  assert.equal(page.$("#srcsum").textContent, "1 of 1 read in the 6 hours up to the last scan (Greenhouse 1). Jobs kept out of jobs seen:");
});
