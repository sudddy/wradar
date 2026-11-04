"use strict";
// The real scripts in one context, as the browser loads them, on a stub DOM. Shared by page.test.js and fields.test.js.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

// older: the JOB_OLDER that older.js holds, null for no such file, or "wait" to leave it loading until page.older() is called.
function openPage({ wide = true, keyboard = false, storage = new Map(), data = pageData(), at = "#jobs", older = null } = {}) {
  const els = {}, scripts = [], winOn = {}, back = [], frames = [], doc = { activeElement: null };
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
      scrollIntoView() {}, insertAdjacentHTML: (where, html) => { el.innerHTML += html; },
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
    requestAnimationFrame: fn => frames.push(fn),
  });
  context.window = context;
  for (const [filename, src] of SCRIPTS) vm.runInContext(src, context, { filename });
  const isOlder = s => s.src.startsWith("older.js");
  let olderFrame = scripts.some(isOlder) ? 0 : null;  // the frame that asked for older.js: 0 is before the first paint
  for (let n = 1; frames.length; n++) { frames.shift()(); if (olderFrame == null && scripts.some(isOlder)) olderFrame = n; }
  const run = code => vm.runInContext(code, context);
  const go = to => run(`location.hash = ${JSON.stringify(to)}`);
  const olderTag = scripts.find(isOlder);
  const finish = more => { if (more) { context.JOB_OLDER = more; olderTag.onload(); } else olderTag.onerror(); };
  if (older !== "wait") finish(older);
  return { $: doc.querySelector, doc, run, go, scripts, storage, context, older: finish, olderFrame, fireWindow: (type, e) => fire(winOn, type, e), hash: () => hash };
}
const withResume = page => { page.context.RESUME = RESUME; page.run("useResume('Pasted resume', RESUME)"); return page; };

module.exports = { DAY, daysAgo, read, REAL, RESUME, row, pageData, openPage, withResume };
