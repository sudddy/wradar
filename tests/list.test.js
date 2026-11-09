"use strict";
// The job list on the stub DOM (tests/page-stub.js): the Job type chips and the pages.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const board = require("../docs/board.js");
const { daysAgo, row, pageData, openPage, withResume } = require("./page-stub.js");

// n rows, newest first as the list shows them with no resume: rows[k] is Backend Engineer k.
const many = n => Array.from({ length: n }, (_, i) => row(i, { posted: daysAgo(1 + i / 10), first_seen: daysAgo(1 + i / 10) }));
const keyOf = i => `co${i}|backend engineer ${i}`;
const turn = (page, pg) => page.$("#pager").fire("click", { target: { closest: () => ({ dataset: { pg: String(pg) } }) } });
const arrow = (page, key) => page.$("#list").fire("keydown", { key, target: { closest: () => true } });
const shows = (page, i) => page.$("#list").innerHTML.includes(`>Backend Engineer ${i}<`);

// ---- Job type chips ----
const kinds = () => pageData({ jobs: [row(0), row(1, { type: "Contract" }), row(2, { type: "Contract", where: ["Canada"] }), row(3, { type: "Part-time" }),
  row(4, { type: "Internship" }), row(5, { type: "Not specified" }), row(6, { salary: null })] });
const pickType = (page, v) => page.$("#types").fire("click", { target: { closest: () => ({ dataset: { v } }) } });
const typeCounts = page => ["any", "full-time", "contract", "part-time", "internship"].map(t => page.$("#n-t" + t).textContent);

test("each Job type chip counts what it would list, and one click lists it", () => {
  const page = openPage({ data: kinds() });
  assert.deepEqual(typeCounts(page), ["7", "2", "2", "1", "1"]);
  pickType(page, "Contract");
  assert.equal(page.$("#count").textContent, "2 of 7 jobs");
  assert.ok(shows(page, 1) && shows(page, 2) && !shows(page, 0));
  assert.deepEqual(typeCounts(page), ["7", "2", "2", "1", "1"]);  // the chips don't count the type chosen
  assert.equal(JSON.parse(page.storage.get("wradar-filters")).type, "Contract");
  pickType(page, "Part-time");
  assert.equal(page.$("#count").textContent, "1 of 7 jobs");
  pickType(page, "");
  assert.equal(page.$("#count").textContent, "7 jobs");  // Any keeps Not specified
});

test("the Job type counts follow the other filters", () => {
  const page = openPage({ data: kinds() });
  page.$("#where").fire("click", { target: { closest: () => ({ dataset: { v: "Canada" } }) } });
  assert.deepEqual(typeCounts(page), ["1", "0", "1", "0", "0"]);
  page.$("#where").fire("click", { target: { closest: () => ({ dataset: { v: "" } }) } });
  page.$("#pay").fire("change", { target: { value: "120000" } });
  assert.deepEqual(typeCounts(page), ["6", "1", "2", "1", "1"]);  // the job with no pay listed is left out
  pickType(page, "Full-time");
  assert.equal(page.$("#count").textContent.split(",")[0], "1 of 7 jobs");
});

test("a saved job type keeps working, a saved Not specified reads as Any, and Clear filters resets it", () => {
  const saved = type => openPage({ data: kinds(), storage: new Map([["wradar-filters", JSON.stringify({ v: 2, type })]]) });
  assert.equal(saved("Contract").$("#count").textContent, "2 of 7 jobs");
  const old = saved("Not specified");
  assert.equal(old.run("state.type"), "");
  assert.equal(old.$("#count").textContent, "7 jobs");
  const page = saved("Internship");
  assert.equal(page.$("#nfilters").textContent, "");  // the chips are always in view, so More filters doesn't count them
  page.$("#reset").fire("click");
  assert.equal(page.run("state.type"), "");
  assert.equal(page.$("#count").textContent, "7 jobs");
});

test("the list shows 25 rows a page, with Previous, the page numbers and Next under it", () => {
  const page = openPage({ data: pageData({ jobs: many(60) }) }), pager = page.$("#pager").innerHTML;
  assert.equal(page.$("#pager").hidden, false);
  assert.equal(page.$("#list").innerHTML.match(/class="jitem/g).length, 25);
  assert.ok(shows(page, 24) && !shows(page, 25));
  assert.match(pager, /<p class="showing">Showing 1–25 of 60<\/p>/);
  assert.match(pager, /data-pg="-1" aria-label="Previous page" disabled>Previous<\/button>/);
  assert.match(pager, /data-pg="1" aria-label="Next page">Next<\/button>/);
  assert.match(pager, /aria-label="Page 1" aria-current="page">1<\/button>/);
  assert.match(pager, /aria-label="Page 3">3<\/button>/);
  assert.equal(page.$("#count").textContent, "60 jobs");
});

test("a page change shows its rows, a wide screen selects the first, and focus goes there", () => {
  const page = openPage({ data: pageData({ jobs: many(60) }) });
  turn(page, 2);
  assert.equal(page.run("nav.jobs.pg"), 2);
  assert.ok(shows(page, 50) && shows(page, 59) && !shows(page, 49));
  assert.match(page.$("#list").innerHTML, /data-n="50" aria-current="true" tabindex="0"/);  // a click reads rows[data-n]
  assert.match(page.$("#pager").innerHTML, /Showing 51–60 of 60.*data-pg="3" aria-label="Next page" disabled/s);
  assert.equal(page.run("nav.jobs.sel"), keyOf(50));
  assert.match(page.$("#detail").innerHTML, />Backend Engineer 50<\/h2>/);
  assert.equal(page.doc.activeElement, page.$("#list .jitem"));
  assert.equal(page.$("#live").textContent, "Showing 51–60 of 60");
  assert.equal(page.hash(), "#jobs");
});

test("on a phone a page change selects nothing, focus goes to its first row, and an arrow key starts there", () => {
  const page = openPage({ wide: false, data: pageData({ jobs: many(60) }) });
  turn(page, 1);
  assert.equal(page.run("nav.jobs.sel"), null);
  assert.match(page.$("#list").innerHTML, /data-n="25" aria-current="false" tabindex="0"/);
  assert.equal(page.doc.activeElement, page.$("#list .jitem"));
  arrow(page, "ArrowDown");
  assert.equal(page.run("nav.jobs.sel"), keyOf(25));
});

test("a filter, search or sort change goes back to page 1, and one page needs no pager", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = withResume(openPage({ data: pageData({ jobs: many(60) }) }));
  const changes = [
    () => page.$("#where").fire("click", { target: { closest: () => ({ dataset: { v: "US" } }) } }),
    () => page.$("#sort").fire("change", { target: { value: "new" } }),
    () => page.$("#hideapplied").fire("change", { target: { checked: true } }),
    () => page.$("#reset").fire("click"),
  ];
  for (const change of changes) {
    turn(page, 2);
    change();
    assert.equal(page.run("nav.jobs.pg"), 0);
    assert.match(page.$("#pager").innerHTML, /Showing 1–25 of 60/);
  }
  turn(page, 1);
  const q = page.$("#q");
  q.value = "engineer 5";
  q.fire("input", { target: q });
  t.mock.timers.tick(150);
  assert.equal(page.run("nav.jobs.pg"), 0);
  assert.equal(page.$("#count").textContent, "11 of 60 jobs");  // 5 and 50 to 59
  assert.equal(page.$("#pager").hidden, true);
});

test("a link to a job on page 4 shows page 4, on a wide screen and a phone", () => {
  for (const wide of [true, false]) {
    const page = openPage({ wide, data: pageData({ jobs: many(120) }), at: board.hashFor("jobs", keyOf(80)) });
    assert.equal(page.run("nav.jobs.pg"), 3);
    assert.ok(shows(page, 80) && shows(page, 75) && !shows(page, 74));
    assert.match(page.$("#pager").innerHTML, /Showing 76–100 of 120.*aria-label="Page 4" aria-current="page"/s);
    assert.match(page.$("#detail").innerHTML, /<span class="dpos">81 of 120<\/span>/);
  }
});

test("arrow keys and the detail's Previous and Next step through every job, turning the page past either end", () => {
  const page = openPage({ data: pageData({ jobs: many(60) }) });
  page.run(`select(${JSON.stringify(keyOf(24))})`);
  arrow(page, "ArrowDown");
  assert.equal(page.run("nav.jobs.pg"), 1);
  assert.equal(page.run("nav.jobs.sel"), keyOf(25));
  assert.ok(shows(page, 25) && !shows(page, 24));
  assert.match(page.$("#pager").innerHTML, /Showing 26–50 of 60/);
  assert.equal(page.doc.activeElement, page.$("#list .jitem[aria-current=true]"));
  arrow(page, "ArrowUp");
  assert.equal(page.run("nav.jobs.pg"), 0);
  assert.equal(page.run("nav.jobs.sel"), keyOf(24));
  page.run("act('next')");
  assert.equal(page.run("nav.jobs.pg"), 1);
  assert.match(page.$("#detail").innerHTML, /<span class="dpos">26 of 60<\/span>/);
  page.run("act('prev')");
  assert.equal(page.run("nav.jobs.pg"), 0);
});

test("older.js joining keeps the selected job and turns to the page it moved to", () => {
  const fresh = { generated_at: "x", jobs: [row(99, { posted: daysAgo(0.1), first_seen: daysAgo(0.1) })] };  // the newest row, so every other moves down one
  const phone = openPage({ wide: false, data: pageData({ jobs: many(50) }), older: "wait" });
  phone.run("openRow(rows[24])");
  phone.run("act('back')");  // the list again, with the job still selected
  phone.older(fresh);
  assert.equal(phone.run("nav.jobs.sel"), keyOf(24));
  assert.equal(phone.run("nav.jobs.pg"), 1);
  assert.match(phone.$("#list").innerHTML, /data-n="25" aria-current="true"/);
  const wide = openPage({ data: pageData({ jobs: many(50) }), older: "wait" });
  wide.run(`select(${JSON.stringify(keyOf(24))})`);
  wide.older(fresh);
  assert.equal(wide.run("nav.jobs.pg"), 1);
  assert.equal(wide.run("nav.jobs.sel"), keyOf(24));
});

test("each list keeps its page until a reload, and nothing stores it", () => {
  const page = openPage({ data: pageData({ jobs: many(60) }) });
  turn(page, 2);
  page.go("#resume");
  page.go("#jobs");
  assert.equal(page.run("nav.jobs.pg"), 2);
  assert.match(page.$("#pager").innerHTML, /Showing 51–60 of 60/);
  for (const v of page.storage.values()) assert.doesNotMatch(v, /"pg"/);
  assert.equal(openPage({ storage: page.storage, data: pageData({ jobs: many(60) }) }).run("nav.jobs.pg"), 0);
  withResume(page);
  assert.equal(page.run("nav.jobs.pg"), 0);  // the list now sorts by match
});

test("Applications pages a long list too", () => {
  const marks = Object.fromEntries(many(30).map((j, i) => [keyOf(i), { s: "saved", at: daysAgo(i / 100), title: j.title, company: j.company, url: j.url, where: j.where }]));
  const page = openPage({ data: pageData({ jobs: many(30) }), storage: new Map([["wradar-tracker", JSON.stringify(marks)]]), at: "#mine" });
  assert.equal(page.$("#pager").hidden, false);
  assert.match(page.$("#pager").innerHTML, /Showing 1–25 of 30/);
  turn(page, 1);
  assert.ok(shows(page, 29) && !shows(page, 0));
});
