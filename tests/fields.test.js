"use strict";
// The page for every field: Role by field, the first resume setting Role, the ladder, search, Skills to add and Insights, the copy.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { read, REAL, row, pageData, openPage, withResume } = require("./page-stub.js");

const ae = row(5, { title: "Account Executive", role: "Sales", level: "Director", skills: ["Salesforce"], must: ["Salesforce"] });
const se = row(6, { title: "Solutions Engineer", role: "Solutions & presales", level: "Intern", skills: ["Salesforce", "SQL"], must: ["SQL"] });
const fields = () => pageData({ jobs: [row(0, { skills: ["Go", "COBOL"] }), row(1), row(2), row(3), row(40), ae, se].map(j => ({ ...j })) });
const pickRole = (page, value) => page.$("#role").fire("change", { target: { value } });

test("Role groups the roles by field, with one option for a whole field, and a role saved before still loads", () => {
  const page = openPage({ data: fields() }), html = page.$("#role").innerHTML;
  assert.match(html, /^<optgroup label="Engineering"><option value="field:Engineering">All Engineering<\/option><option>Backend<\/option><\/optgroup>/);
  assert.match(html, /<optgroup label="Sales"><option value="field:Sales">All Sales<\/option><option>Sales<\/option><option>Solutions &amp; presales<\/option><\/optgroup>$/);
  pickRole(page, "field:Sales");
  assert.equal(page.$("#count").textContent, "2 of 6 jobs");
  pickRole(page, "Sales");
  assert.equal(page.$("#count").textContent, "1 of 6 jobs");
  const saved = openPage({ data: fields(), storage: new Map([["wradar-filters", JSON.stringify({ v: 2, role: "Backend" })]]) });
  assert.equal(saved.$("#count").textContent, "4 of 6 jobs");
});

test("every field in the real data has its place in Role", () => {
  const page = openPage({ data: { ...REAL, rules: { ...REAL.rules, scan_url: "" } } });
  for (const f of new Set(REAL.jobs.map(j => REAL.rules.fields[j.role]))) {
    assert.ok(f === "Other" ? /<option>Other<\/option>$/.test(page.$("#role").innerHTML) : page.$("#role").innerHTML.includes(`value="field:${f.replace("&", "&amp;")}"`), f);
  }
});

test("a resume read sets an empty Role to its field, and a cleared Role stays cleared after a reload", () => {
  const storage = new Map(), page = withResume(openPage({ storage }));
  assert.equal(page.run("state.role"), "field:Engineering");
  assert.equal(page.$("#role").value, "field:Engineering");
  pickRole(page, "");
  withResume(page);
  assert.equal(page.run("state.role"), "");
  const again = withResume(openPage({ storage }));
  assert.equal(again.run("state.role"), "");
  const chosen = openPage();
  pickRole(chosen, "field:Sales");
  withResume(chosen);
  assert.equal(chosen.run("state.role"), "field:Sales");
});

// A resume read as one role, whatever resume.js makes of a text.
const readAs = (page, role) => {
  page.context.ROLE = role;
  page.run("wresume.parseResume = () => ({ skills: ['Salesforce'], evidence: {}, years: 5, level: 'Mid', role: ROLE, degree: null }); useResume('Pasted resume', 'x')");
  return page.run("state.role");
};
// #role as a <select> keeps a value only when it has that option.
const asSelect = el => { let v = ""; Object.defineProperty(el, "value", { get: () => v, set: x => { v = x === "" || el.innerHTML.includes(`value="${x}"`) ? x : ""; } }); };

test("another resume moves the Role a resume set, never one the person picked or cleared", () => {
  const page = openPage({ data: fields() });
  assert.equal(readAs(page, "Backend"), "field:Engineering");
  assert.equal(readAs(page, "Sales"), "field:Sales");
  assert.equal(readAs(page, null), "");  // a resume with no role says nothing about the field
  assert.equal(readAs(page, "Sales"), "field:Sales");
  pickRole(page, "Backend");
  assert.equal(readAs(page, "Solutions & presales"), "Backend");
  pickRole(page, "");
  assert.equal(readAs(page, "Sales"), "");
});

test("a resume from a field with no jobs leaves Role on All roles", () => {
  const page = openPage({ data: fields() });
  asSelect(page.$("#role"));
  assert.equal(readAs(page, "Recruiting"), "");
  assert.equal(page.$("#role").value, "");
  assert.equal(readAs(page, "Sales"), "field:Sales");
  assert.equal(page.$("#role").value, "field:Sales");
});

test("a resume read on the welcome keeps its Role after a reload", () => {
  const storage = new Map();
  withResume(openPage({ storage, at: "" }));
  assert.equal(openPage({ storage, at: "" }).run("state.role"), "field:Engineering");
});

test("Level follows the ladder, and data from before the ladder and fields still loads", () => {
  const page = openPage({ data: fields() });
  assert.equal(page.$("#level").innerHTML, "<option>Intern</option><option>Mid</option><option>Director</option>");
  assert.match(read("docs/index.html"), /<option>Contract<\/option><option>Internship<\/option>/);
  const { ladder, roles, fields: f, ...rules } = REAL.rules;
  const old = openPage({ data: { ...fields(), rules: { ...rules, scan_url: "" } } });
  assert.equal(old.$("#level").innerHTML, "<option>Mid</option>");
  assert.match(old.$("#role").innerHTML, /^<optgroup label="Engineering"><option value="field:Engineering">All Engineering<\/option><option>Backend<\/option><option>Sales<\/option>/);
  assert.equal(old.run("D.all.every(j => j.field === 'Engineering')"), true);
});

test("search finds a job by its role or its field", () => {
  const page = openPage({ data: fields() });
  page.run("state.q = 'presales'; renderBoard()");
  assert.equal(page.$("#count").textContent, "1 of 6 jobs");
  page.run("state.q = 'sales'; renderBoard()");
  assert.equal(page.$("#count").textContent, "2 of 6 jobs");
});

test("Skills to add and Insights count the jobs of the chosen field, else the person's own", () => {
  const page = withResume(openPage({ data: fields() }));
  page.go("#resume");
  assert.equal(page.$("#mygapsnote").textContent, "What jobs in Engineering ask for most that your resume doesn't list.");
  assert.match(page.$("#mygaps").innerHTML, /COBOL/);
  assert.doesNotMatch(page.$("#mygaps").innerHTML, /Salesforce/);
  page.go("#insights");
  assert.match(page.$("#charts").innerHTML, /<h2>Jobs by field<\/h2><p class="note">[^<]*<\/p><ol class="bars ">(?=.*Engineering)(?=.*Sales)/);
  assert.match(page.$("#charts").innerHTML, /<h2>Jobs in Engineering by role<\/h2>(?:(?!<h2>).)*Backend(?:(?!<h2>).)*<h2>/);
  page.go("#jobs");
  pickRole(page, "field:Sales");
  page.go("#resume");
  assert.match(page.$("#mygaps").innerHTML, /Salesforce/);
  assert.doesNotMatch(page.$("#mygaps").innerHTML, /COBOL/);
  page.go("#insights");
  assert.match(page.$("#charts").innerHTML, /<h2>Jobs in Sales by role<\/h2>/);
  page.go("#jobs");
  pickRole(page, "");
  page.run("me.role = null");
  page.go("#insights");
  assert.match(page.$("#charts").innerHTML, /<h2>Jobs by role<\/h2><p class="note">The 12 most common\./);
});

test("the copy says jobs, not software jobs", () => {
  const page = openPage({ at: "" });
  assert.doesNotMatch(page.$("#me").innerHTML, /software|engineering job/i);
  assert.doesNotMatch(read("docs/index.html"), /software|technolog/i);
  page.go("#sources");
  assert.doesNotMatch(page.$("#steps").innerHTML, /software|technolog/i);
});
