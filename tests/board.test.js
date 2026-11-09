"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const board = require("../docs/board.js");
const tracker = require("../docs/tracker.js");

const NOW = Date.parse("2026-11-02T12:00:00Z");
const DAY = 864e5;
const daysAgo = (d, now = NOW) => new Date(now - d * DAY).toISOString();
const job = (over = {}) => ({ title: "Software Engineer", company: "Acme", where: ["US"], location: "Boston", url: "https://acme.test/1", skills: ["Go"],
  source: "Greenhouse", role: "Backend", level: "Mid", type: "Full-time", score: null, posted: daysAgo(1, Date.now()), first_seen: daysAgo(1, Date.now()),
  salary: { min: 100000, max: 150000, cur: "USD", per: "year" }, mode: "Remote", ...over });
const FILTERS = { q: "", role: "", level: "", type: "", where: "", min: 0, src: "", techs: [], mode: "any" };

test("key is lowercased company|title", () => {
  assert.equal(board.jobKey({ company: "OpenAI", title: "Staff Engineer, Infra" }), "openai|staff engineer, infra");
});

test("every age lands in exactly one of Last 30 days and Older, with no gap at 30.x", () => {
  const rows = [29.9, 30, 30.01, 30.5, 30.99, 31, 89].map(d => ({ posted: daysAgo(d) }));
  const { fresh, older } = board.splitAge(rows, NOW);
  assert.equal(fresh.length + older.length, rows.length);
  assert.deepEqual(fresh, rows.slice(0, 2));
  assert.deepEqual(older, rows.slice(2));
});

test("a row with no posted date ages from first_seen", () => {
  const { older } = board.splitAge([{ posted: null, first_seen: daysAgo(40) }], NOW);
  assert.equal(older.length, 1);
});

test("an old posting never reads as new, whenever wradar first saw it", () => {
  assert.equal(board.isNew(job()), true);
  assert.equal(board.isNew(job({ posted: daysAgo(40, Date.now()) })), false);
});

test("hourly pay is annualized at 2080 hours", () => {
  assert.deepEqual(board.annualPay({ min: 50, max: 65, cur: "USD", per: "hour" }), { min: 104000, max: 135200, cur: "USD" });
  assert.deepEqual(board.annualPay({ min: 120000, max: 160000, cur: "CAD", per: "year" }), { min: 120000, max: 160000, cur: "CAD" });
  assert.equal(board.annualPay(null), null);
});

test("pay is labeled in its own currency, with no conversion", () => {
  assert.equal(board.payLabel({ min: 150000, max: 225000, cur: "USD", per: "year" }), "$150k–225k");
  assert.equal(board.payLabel({ min: 120000, max: 160000, cur: "CAD", per: "year" }), "CA$120k–160k");
  assert.equal(board.payLabel({ min: 70000, max: 70000, cur: "GBP", per: "year" }), "£70k");
  assert.equal(board.payLabel({ min: 50, max: 65, cur: "USD", per: "hour" }), "$104k–135k");
  assert.equal(board.payLabel(null), "");
});

test("a minimum pay filter drops unknown pay and counts it", () => {
  const rows = [job(), job({ salary: null }), job({ salary: null }), job({ salary: { min: 40, max: 50, cur: "USD", per: "hour" } })];
  const { kept, noPay, noMode } = board.knownOnly(rows, 120000, "");
  assert.deepEqual(kept, rows.slice(0, 1));
  assert.equal(noPay, 2);
  assert.equal(noMode, 0);
});

test("a work mode filter drops unknown mode and counts it", () => {
  const rows = [job(), job({ mode: "Hybrid" }), job({ mode: null })];
  const { kept, noPay, noMode } = board.knownOnly(rows, 0, "Remote");
  assert.deepEqual(kept, rows.slice(0, 1));
  assert.equal(noMode, 1);
  assert.equal(noPay, 0);
});

test("an unknown is only counted when the other filter would have let it through", () => {
  const rows = [job({ salary: null, mode: "Hybrid" }), job({ mode: null, salary: { min: 1, max: 2, cur: "USD", per: "year" } })];
  const { noPay, noMode } = board.knownOnly(rows, 120000, "Remote");
  assert.equal(noPay, 0);
  assert.equal(noMode, 0);
});

test("with no pay or mode filter, nothing is dropped or counted", () => {
  const rows = [job({ salary: null, mode: null }), job()];
  assert.deepEqual(board.knownOnly(rows, 0, ""), { kept: rows, noPay: 0, noMode: 0 });
});

test("matches reads the other saved filters", () => {
  assert.equal(board.matches(job(), { ...FILTERS, q: "acme" }), true);
  assert.equal(board.matches(job(), { ...FILTERS, q: "globex" }), false);
  assert.equal(board.matches(job({ score: 60 }), { ...FILTERS, min: 70 }), false);
  assert.equal(board.matches(job({ score: null }), { ...FILTERS, min: 70 }), true);  // no resume, so no score to hold it back
  assert.equal(board.matches(job(), { ...FILTERS, techs: ["Rust"] }), false);
  assert.equal(board.matches(job(), { ...FILTERS, techs: ["Rust", "Go"], mode: "all" }), false);
  assert.equal(board.matches(job(), { ...FILTERS, techs: ["Rust", "Go"], mode: "any" }), true);
  assert.equal(board.matches(job(), { ...FILTERS, techs: ["Rust"] }, { tech: false }), true);
});

test("Role is one family, or every family of a field", () => {
  const sales = job({ role: "Solutions & presales", field: "Sales" });
  assert.equal(board.matches(sales, { ...FILTERS, role: "field:Sales" }), true);
  assert.equal(board.matches(sales, { ...FILTERS, role: "Solutions & presales" }), true);
  assert.equal(board.matches(sales, { ...FILTERS, role: "Sales" }), false);
  assert.equal(board.matches(sales, { ...FILTERS, role: "field:Engineering" }), false);
  assert.equal(board.matches(job({ field: "Engineering" }), { ...FILTERS, role: "Backend" }), true);  // a value saved before fields
});

test("search reads the title, company, place, skills, role and field", () => {
  const sales = job({ title: "Account Executive", company: "Globex", location: "Austin", skills: ["Salesforce"], role: "Solutions & presales", field: "Sales" });
  for (const q of ["account exec", "globex", "austin", "salesforce", "presales", "sales"]) assert.equal(board.matches(sales, { ...FILTERS, q }), true, q);
  assert.equal(board.matches(sales, { ...FILTERS, q: "engineering" }), false);
  assert.equal(board.matches(job({ field: "Engineering" }), { ...FILTERS, q: "engineering" }), true);
});

test("topN gives what a full sort would, ties in their order", () => {
  const cmp = (a, b) => b.n - a.n;
  for (let r = 0; r < 50; r++) {
    const a = Array.from({ length: r % 13 }, (_, i) => ({ i, n: (i * 7919 + r) % 5 }));
    assert.deepEqual(board.topN(a, 6, cmp), [...a].sort(cmp).slice(0, 6));
  }
});

test("a saved minimum match resets once, and Any/All survives", () => {
  const defaults = { v: 2, min: 0, mode: "any", work: "" };
  const first = board.savedFilters({ min: 70, mode: "all" }, defaults);
  assert.equal(first.min, 0);
  assert.equal(first.mode, "all");
  assert.equal(first.v, 2);
  assert.equal(board.savedFilters({ ...first, min: 40 }, defaults).min, 40);
  assert.equal(board.savedFilters(null, defaults).min, 0);
});

test("a deep link survives the characters a key can hold", () => {
  const key = "o'reilly & co|senior engineer / platform, 100% remote";
  assert.deepEqual(board.parseHash(board.hashFor("older", key)), { view: "older", key });
  assert.deepEqual(board.parseHash("#jobs"), { view: "jobs", key: null });
  assert.deepEqual(board.parseHash("#resume"), { view: "resume", key: null });
  assert.deepEqual(board.parseHash(""), { view: "jobs", key: null });
  assert.deepEqual(board.parseHash("#nowhere/x"), { view: "jobs", key: null });
  assert.deepEqual(board.parseHash("#resume/x"), { view: "resume", key: null });
  assert.deepEqual(board.parseHash("#jobs/%E0%A4%A"), { view: "jobs", key: null });
});

test("the pager shows every page up to seven, else the first, the last and the current page's neighbours", () => {
  assert.equal(board.PER_PAGE, 25);
  assert.deepEqual(board.pageList(1, 1), [1]);
  assert.deepEqual(board.pageList(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(board.pageList(1, 54), [1, 2, 3, 4, 5, null, 54]);
  assert.deepEqual(board.pageList(5, 54), [1, null, 4, 5, 6, null, 54]);
  assert.deepEqual(board.pageList(10, 54), [1, null, 9, 10, 11, null, 54]);
  assert.deepEqual(board.pageList(54, 54), [1, null, 50, 51, 52, 53, 54]);
  for (let total = 1; total < 40; total++) {
    for (let cur = 1; cur <= total; cur++) {
      const list = board.pageList(cur, total), nums = list.filter(Boolean);
      assert.ok(list.length <= 7 && nums.includes(cur) && list[0] === 1 && list.at(-1) === total, `${cur} of ${total}`);
      list.forEach((n, i) => n === null && assert.ok(list[i + 1] - list[i - 1] > 2, `a gap hides two pages or more: ${list}`));
      nums.forEach((n, i) => i && assert.ok(n > nums[i - 1]));
    }
  }
});

test("a tracker snapshot survives a delisted job", () => {
  const live = { ...job(), key: "acme|software engineer" };
  const t = tracker.mark({}, live, "applied", "2026-10-28T10:00:00Z");
  assert.deepEqual(t[live.key], { s: "applied", at: "2026-10-28T10:00:00Z", title: live.title, company: "Acme", url: live.url, where: ["US"] });
  const [row] = tracker.mineRows(t, "all", new Map());
  assert.equal(row.delisted, true);
  assert.equal(row.key, live.key);
  assert.equal(row.title, "Software Engineer");
  assert.equal(row.company, "Acme");
  assert.equal(row.url, live.url);
  assert.deepEqual(row.where, ["US"]);
});

test("a job still in the feed shows live, not from its snapshot", () => {
  const live = { ...job(), key: "acme|software engineer" };
  const t = tracker.mark({}, { ...live, url: "https://acme.test/old" }, "saved", "2026-10-28T10:00:00Z");
  assert.equal(tracker.mineRows(t, "all", new Map([[live.key, live]]))[0], live);
});

test("Applications segments hold saved plus applied, and Hidden apart, newest first", () => {
  const a = { key: "a", title: "A" }, b = { key: "b", title: "B" }, c = { key: "c", title: "C" };
  let t = tracker.mark({}, a, "saved", "2026-10-01T00:00:00Z");
  t = tracker.mark(t, b, "applied", "2026-10-02T00:00:00Z");
  t = tracker.mark(t, c, "hidden", "2026-10-03T00:00:00Z");
  const keys = seg => tracker.mineRows(t, seg, new Map()).map(r => r.key);
  assert.deepEqual(keys("all"), ["b", "a"]);
  assert.deepEqual(keys("saved"), ["a"]);
  assert.deepEqual(keys("applied"), ["b"]);
  assert.deepEqual(keys("hidden"), ["c"]);
});

test("marking twice toggles off, and a mark leaves the old tracker alone", () => {
  const a = { key: "a", title: "A" }, empty = {};
  const on = tracker.toggle(empty, a, "saved", "2026-10-01T00:00:00Z");
  assert.deepEqual(empty, {});
  assert.equal(on.a.s, "saved");
  assert.deepEqual(tracker.toggle(on, a, "saved", "2026-10-02T00:00:00Z"), {});
  assert.equal(tracker.toggle(on, a, "applied", "2026-10-02T00:00:00Z").a.s, "applied");
});

test("showing a hidden job again brings back its Applied or Saved mark", () => {
  const a = { key: "a", title: "A" };
  const applied = tracker.mark({}, a, "applied", "2026-10-01T00:00:00Z");
  const hidden = tracker.mark(applied, a, "hidden", "2026-10-02T00:00:00Z");
  assert.equal(hidden.a.s, "hidden");
  assert.deepEqual(tracker.toggle(hidden, a, "hidden", "2026-10-03T00:00:00Z"), applied);
  assert.deepEqual(tracker.toggle(tracker.mark({}, a, "hidden", "2026-10-02T00:00:00Z"), a, "hidden", "2026-10-03T00:00:00Z"), {});
});

test("Clicked keeps the date a job was first opened, and only the newest past the cap", () => {
  assert.equal(tracker.CLICKS_KEPT, 2000);
  const once = tracker.addClick({}, "acme|engineer", "2026-11-01T00:00:00.000Z");
  assert.deepEqual(once, { "acme|engineer": "2026-11-01T00:00:00.000Z" });
  assert.equal(tracker.addClick(once, "acme|engineer", "2026-11-05T00:00:00.000Z"), once);
  let c = {};
  for (const d of [3, 1, 5, 2, 4]) c = tracker.addClick(c, `k${d}`, `2026-11-0${d}T00:00:00.000Z`, 3);
  assert.deepEqual(Object.keys(c).sort(), ["k3", "k4", "k5"]);
  assert.deepEqual(Object.keys(tracker.addClick({}, "__proto__", "2026-11-01T00:00:00.000Z")), ["__proto__"]);  // a key is data, never a prototype
});

test("Undo puts back exactly what was there", () => {
  const a = { key: "a", title: "A" };
  const applied = tracker.mark({}, a, "applied", "2026-10-01T00:00:00Z");
  const hidden = tracker.mark(applied, a, "hidden", "2026-10-02T00:00:00Z");
  assert.deepEqual(tracker.putBack(hidden, "a", applied.a), applied);
  assert.deepEqual(tracker.putBack(tracker.mark({}, a, "hidden", "2026-10-02T00:00:00Z"), "a", undefined), {});
});
