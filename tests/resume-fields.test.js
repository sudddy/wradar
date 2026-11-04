"use strict";
// The resume reader on jobs in every field: titles, roles, levels and years. Split from resume.test.js to keep both short.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const { parseResume } = require("../docs/resume.js");
const { levelOf } = require("../docs/match.js");

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../docs/jobs.js"), "utf8"), sandbox);
const { rules } = sandbox.window.JOB_DATA;
const keywords = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, "../keywords.json"), "utf8"))).filter(([k]) => !k.startsWith("_")));
// Same compile as SKILLS in docs/app.js.
const rxEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SKILLS = Object.entries(keywords).map(([name, aliases]) => [name, aliases.map(a => a.startsWith("re:")
  ? new RegExp(a.slice(3))
  : new RegExp("(?<![A-Za-z0-9])" + rxEscape(a.replace(/^=/, "")) + "(?![A-Za-z0-9+#])", a.startsWith("=") ? "" : "i"))]);
const read = text => parseResume(text, SKILLS, rules, new Date(2026, 10, 2));

const job = (title, dates, ...work) => [title + "    " + dates, ...work.map(w => `- ${w}`)];
const resume = (...jobs) => read(["EXPERIENCE", ...jobs.flat()].join("\n"));

test("a job title in any field names the job", () => {
  for (const [title, role, level] of [["Chemistry Teacher", "Education", null], ["Staff Accountant", "Accounting", null], ["Paralegal", "Legal", null],
    ["Registered Nurse", "Clinical", null], ["Senior Technical Recruiter", "Recruiting", "Senior"], ["VP of Sales", "Sales", "VP"],
    ["Account Executive", "Sales", null], ["Executive Assistant", "Administrative", null], ["Marketing Intern", "Marketing", "Intern"]]) {
    const p = resume(job(title, "Jan 2021 - Present", "Kept the weekly plan."));
    assert.deepEqual([p.years, p.role, p.level], [5.5, role, level], title);
  }
});

test("a short tail after the title names its role, and the first segment its level", () => {
  assert.deepEqual(["role", "level"].map(k => resume(job("Manager, Customer Success", "2021 - Present", "Ran renewals."))[k]), ["Customer success", "Manager"]);
  assert.deepEqual(["role", "level"].map(k => resume(job("Director, Product Marketing", "2021 - Present", "Ran launches."))[k]), ["Marketing", "Director"]);
});

test("a title that names no role leaves the role empty", () => {
  assert.equal(resume(job("Laboratory Assistant", "2021 - Present", "Prepared reagents.")).role, null);
});

test("an employer whose name holds a role noun doesn't take the title's place", () => {
  const role = (...lines) => read(["EXPERIENCE", ...lines, "- Built Java and Kafka services."].join("\n")).role;
  assert.equal(role("Trader Joe's    Jun 2019 - Present", "Software Engineer"), "Backend");
  assert.equal(role("Coach, New York, NY    Jun 2019 - Present", "Senior Software Engineer"), "Backend");
  assert.equal(role("Senior Software Engineer", "Lead Bank, Kansas City, MO", "Mar 2021 – Present"), "Backend");
  assert.equal(role("Registered Nurse", "Advocate Health, Chicago, IL    Jan 2020 - Present"), "Clinical");
  assert.equal(role("VP Sales    2019 - Present", "Acme Corp, New York, NY"), "Sales", "a title that doesn't end on its noun still counts alone");
});

test("a letter outside ASCII is part of its word, as in Python", () => {
  assert.equal(resume(job("Coordinator, Prévoyance", "2021 - Present", "Kept the files.")).role, null, "not PR, so not Communications");
});

test("a job with no title counts when it names three skills that aren't soft, which can name an engineer's role", () => {
  assert.deepEqual(["years", "role"].map(k => resume(["Jan 2020 - Present", "- Built Java, Kafka and PostgreSQL services."])[k]), [6.5, "Backend"]);
  assert.deepEqual(["years", "role"].map(k => resume(["Jan 2020 - Present", "- Ran campaigns in HubSpot, Marketo and Salesforce."])[k]), [6.5, null]);
  assert.equal(resume(["Jan 2020 - Present", "- Ran Agile ceremonies in Jira for a SaaS team."]).years, null);
});

test("years come from the latest job's field, else the field with the most months, else every job", () => {
  const sales = job("Account Executive", "Jan 2020 - Present", "Closed enterprise deals."), teach = job("Chemistry Teacher", "Jan 2010 - Dec 2019", "Taught chemistry.");
  assert.equal(resume(sales, teach).years, 6.5);
  const unknown = job("Laboratory Assistant", "Jan 2024 - Present", "Prepared reagents.");
  assert.equal(resume(unknown, job("Chemistry Teacher", "Jan 2021 - Dec 2023", "Taught."), job("Account Executive", "Jan 2010 - Dec 2020", "Closed deals.")).years, 11,
    "the latest field is unknown: Sales has the most months, though teaching is more recent");
  assert.equal(resume(unknown, job("Laboratory Assistant", "Jan 2020 - Dec 2023", "Kept inventory.")).years, 6.5, "no field known: every job");
});

test("a side job held alongside the main one doesn't move the career", () => {
  const swe = job("Senior Software Engineer", "Jun 2019 - Present", "Built Java services on AWS with Kafka.");
  for (const side of ["Co-Founder, Weekend Apps", "Adjunct Instructor", "Independent Consultant"])
    assert.deepEqual(["years", "role", "level"].map(k => resume(job(side, "Jan 2024 - Present", "Built an app in React Native."), swe)[k]), [7.5, "Backend", "Senior"], side);
  const club = resume(job("Officer, Robotics Club", "Sep 2024 - Present", "Ran the budget."), job("Software Engineering Intern", "Jun 2026 - Aug 2026", "Built Java services with Kafka."));
  assert.deepEqual([club.role, club.level], ["Backend", "Junior"]);
});

test("data and research years count with engineering years, and hardware years don't", () => {
  const p = resume(job("Machine Learning Engineer", "Jan 2022 - Present", "Built Python services."), job("Data Scientist", "Jan 2018 - Dec 2021", "Trained models in Python."));
  assert.equal(p.years, 8.5);
  const civil = resume(job("Software Engineer", "Jan 2024 - Present", "Built Python services."), job("Civil Engineer", "Jan 2014 - Dec 2023", "Designed bridges."));
  assert.equal(civil.years, 2.5, "hardware engineering years are not software years");
});

test("a job whose title names no field counts toward the field its skills share", () => {
  const front = job("Frontend Developer", "Jan 2024 - Present", "Built React pages and tracked them in Jira.");
  assert.equal(resume(front, job("Web Development Intern", "Jun 2023 - Aug 2023", "Moved pages to React.")).years, 3);
  assert.equal(resume(front, job("Laboratory Assistant", "Jun 2023 - Aug 2023", "Prepared reagents.")).years, 2.5);
  assert.equal(resume(front, job("Laboratory Assistant", "Jun 2023 - Aug 2023", "Kept the Agile board in Jira.")).years, 2.5, "a soft skill shared isn't enough");
  const analyst = job("Data Analyst", "Jan 2024 - Present", "Built dashboards in SQL and Tableau; modelled churn in Excel.");
  assert.equal(resume(analyst, job("Store Manager", "Jan 2014 - Dec 2023", "Tracked weekly sales in Excel.")).years, 2.5, "one skill shared isn't enough outside an internship");
  assert.equal(resume(analyst, job("Store Manager", "Jan 2014 - Dec 2023", "Built weekly reports in Excel, SQL and Tableau.")).years, 12.5);
});

test("an individual Manager title is a manager when the latest job shows the people managed", () => {
  const pm = (...work) => resume(job("Product Manager", "Jan 2021 - Present", "Owned the checkout roadmap.", ...work)).level;
  assert.equal(pm(), null);
  for (const w of ["Managed a team of 6 product managers.", "Coached four direct reports.", "Led a team of 5 analysts."]) assert.equal(pm(w), "Manager", w);
  assert.equal(resume(job("Senior Product Manager", "Jan 2021 - Present", "Managed a team of 6.")).level, "Senior", "a level the title states stays");
  assert.equal(resume(job("Product Manager", "Jan 2021 - Present", "Built the roadmap."), job("Engineering Lead", "2015 - 2020", "Managed a team of 6.")).level, null,
    "people managed in an earlier job don't make the latest a manager job");
});

test("a current internship reads as Intern, and one that has ended as Junior", () => {
  assert.equal(resume(job("Software Engineering Intern", "Jun 2026 - Present", "Built Java services.")).level, "Intern");
  const ended = resume(job("Software Engineering Intern", "Jun 2026 - Aug 2026", "Built Java services."));
  assert.deepEqual([ended.level, levelOf(ended)], ["Junior", "Junior"]);
});
