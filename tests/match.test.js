"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { score, buildStats, TIERS, levelOf } = require("../docs/match.js");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(read("docs/jobs.js"), sandbox);
const rows = sandbox.window.JOB_DATA.jobs;
const stats = buildStats(rows, sandbox.window.JOB_DATA.rules);

const { MUST, job, on, part, lines, ev, old, full, onAll } = require("./match-helpers.js");

const PROFILES = [
  old,
  { name: "x", skills: [], years: null },
  { name: "PDF resume", skills: ["Java", "Spring Boot", "Kafka", "AWS", "Docker", "PostgreSQL", "Terraform"], years: 9, role: "Backend", level: "Senior",
    degree: "Master's", evidence: { Java: ev(3, 0), Kafka: ev(3, 0), AWS: ev(2, 30), Docker: ev(2, 70), Terraform: ev(1, null) } },
  { name: "Text resume", skills: ["TypeScript", "React", "Next.js", "Jest"], years: 1.5, role: "Frontend", level: null, degree: "Bachelor's",
    evidence: { React: ev(3, 0), Jest: ev(1, null) } },
  { name: "Word resume", skills: ["Python", "PyTorch", "Spark", "LLMs"], years: 12, role: "ML / AI", level: "Staff+", degree: "PhD",
    evidence: { PyTorch: ev(3, 0), Spark: ev(2, 65) } },
  { name: "Text resume", skills: ["Python", "Go", "Docker"], years: 4, role: "General", level: null, degree: null, evidence: {} },
  { name: "PDF resume", skills: ["Salesforce", "Prospecting", "SaaS", "People Management", "SQL"], years: 15, role: "Sales", level: "Director",
    degree: "Bachelor's", evidence: { Salesforce: ev(3, 0), "People Management": ev(3, 0), SQL: ev(1, null) } },
];

test("loads beside app.js as a classic script, sharing nothing but wmatch", () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(read("docs/match.js"), ctx);
  assert.deepEqual(Object.keys(ctx.window.wmatch).sort(), ["TIERS", "buildStats", "levelOf", "score"]);
  vm.runInContext("const esc = 0, list = 0, plural = 0, pair = 0, LEVELS = 0, TIERS = 0, levelOf = 0; function score() {}", ctx);
});

test("tiers and level helper", () => {
  assert.deepEqual(TIERS, [["Hot", 75], ["Warm", 65], ["Cool", 0]]);
  assert.equal(levelOf({ years: 1 }), "Junior");
  assert.equal(levelOf({ years: 3 }), "Mid");
  assert.equal(levelOf({ years: 8, level: "Staff+" }), "Staff+");
  assert.equal(levelOf({ years: null }), null);
});

test("reads the years_required row field", () => {
  const r = on(old, job({ years_required: 7 }));
  assert.equal(part(r, "Years").max, 15);
  assert.equal(part(r, "Years").note, "8 against 7+");
  assert.ok(r.fits.includes("You have 8 years; it asks for 7+."));
});

test("old-format profile still earns Hot", () => {
  const r = on(old, job());
  assert.equal(r.tier, "Hot");
  assert.ok(r.score >= 75);
});

test("adding a must skill never lowers a score", () => {
  const added = [undefined, ev(1, null), ev(1, 100), ev(3, 0)];
  let tried = 0;
  for (const p of PROFILES) for (let i = 0; i < rows.length; i += 5) {
    const miss = rows[i].must.find(k => !p.skills.includes(k));
    if (!miss) continue;
    const before = score(p, rows[i], stats).score;
    for (const e of added) {
      const q = { ...p, skills: [...p.skills, miss], evidence: { ...p.evidence, ...(e && { [miss]: e }) } };
      assert.ok(score(q, rows[i], stats).score >= before, `${rows[i].title} + ${miss}`);
      tried++;
    }
  }
  assert.ok(tried > 0, "nothing tried");  // a fork that lists fewer companies keeps fewer rows
});

test("editing a profile's skills re-scores it", () => {
  const p = { ...old }, j = job(), st = buildStats([j]), before = score(p, j, st).score;
  p.skills = p.skills.filter(k => k !== "Kafka");
  assert.ok(score(p, j, st).score < before);
});

test("profiles sharing a skills array keep their own evidence", () => {
  const j = job(), st = buildStats([j]), proven = { ...old, evidence: full.evidence };
  assert.ok(score(proven, j, st).score > score(old, j, st).score);
});

test("a General profile role is no role, not a mismatch", () => {
  const j = job(), none = on(old, j), general = on({ ...old, role: "General" }, j);
  assert.equal(general.score, none.score);
  assert.equal(part(general, "Role").max, 0);
  assert.equal(general.held, null);
  for (const r of rows.filter(x => x.role !== "General").slice(0, 200)) {
    assert.ok(!lines(score({ ...old, role: "General" }, r, stats)).some(l => l.includes("General")), r.title);
  }
});

test("empty profile and empty must[] run clean", () => {
  const blank = { name: "x", skills: [], years: null };
  for (const j of [job(), job({ must: [] }), job({ must: [], skills: ["Java"] }), job({ must: [], nice: ["Java"], years_required: null })]) {
    for (const p of [blank, old, full, { ...blank, years: 0 }]) {
      const r = on(p, j);
      assert.ok(r.score >= 0 && r.score <= 100);
      assert.ok(TIERS.some(([name]) => name === r.tier));
    }
  }
});

test("every real row gets a valid result for every profile", () => {
  for (const p of PROFILES) for (const j of rows) {
    const r = score(p, j, stats);
    assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, j.title);
    assert.equal(r.tier, TIERS.find(t => r.score >= t[1])[0], j.title);
    assert.ok(Number.isFinite(r.tie) && r.parts.every(x => Number.isFinite(x.got)), j.title);
    assert.ok(r.fits.length <= 4 && r.gaps.length <= 3 && r.next.length <= 3, j.title);
  }
});

test("a held result says so beside the parts, and its reason leads the gaps", () => {
  const r = on(full, job({ years_required: 20 }));
  assert.deepEqual(r.held, { at: 50, why: "It asks for 20+ years and you have 8." });
  assert.equal(r.score, 50);
  assert.equal(r.gaps[0], r.held.why);
  assert.deepEqual(r.parts.map(x => x.name), ["Role", "Seniority", "Years", "Top must-haves", "Everything else", "Degree"]);
  assert.equal(on(full, job()).held, null);
});

test("years short lines", () => {
  assert.ok(on(old, job({ years_required: 16 })).next.includes("You are 8 years short: go in through a referral if you can."));
  assert.ok(on({ ...old, years: 7 }, job({ years_required: 8 })).next.includes("You are 1 year short: apply anyway and open with your biggest result, with its numbers."));
});

test("years lines read naturally at the edges", () => {
  assert.ok(on({ ...old, years: 1 }, job({ years_required: 1 })).fits.includes("You have 1 year; it asks for 1+."));
  assert.ok(on({ ...old, years: 4.1 }, job({ years_required: 5 })).next.some(l => l.startsWith("You are 0.9 years short")));
});

test("role names take the right article", () => {
  const front = { ...full, role: "Frontend" };
  assert.ok(on(front, job({ title: "Senior Machine Learning Engineer", role: "ML / AI" })).gaps.includes("This is an ML / AI role and your track is Frontend."));
  assert.ok(on(front, job({ title: "Senior Embedded Engineer", role: "Embedded" })).gaps.includes("This is an Embedded role and your track is Frontend."));
  assert.ok(on(front, job({ title: "Senior Security Engineer", role: "Security" })).gaps.includes("This is a Security role and your track is Frontend."));
});

test("Terraform on a resume counts toward Infrastructure as Code", () => {
  const j = job({ must: ["Infrastructure as Code", "Kubernetes"] });
  const without = on({ ...full, skills: ["Kubernetes"] }, j), withTf = on({ ...full, skills: ["Kubernetes", "Terraform"] }, j);
  assert.ok(withTf.score > without.score);
  assert.ok(!lines(withTf).some(l => /Not on your resume:.*Infrastructure as Code/.test(l)));
});

test("a role read from skills is worded as a reading, not a fact", () => {
  const p = { ...full, role: "Backend" };
  let seen = 0;
  for (const j of rows) {
    const r = score(p, j, stats);
    if (!part(r, "Role").note.includes("(read from skills)")) continue;
    assert.ok(!r.gaps.some(l => /^This is an? .+ role and your track is/.test(l)), j.title);
    seen += r.gaps.some(l => l.startsWith("Its skills read like")) ? 1 : 0;
  }
  assert.ok(seen > 0);
});

test("a rare skill leads with how few postings ask for it", () => {
  const rare = job({ must: ["Rust"] }), rest = Array.from({ length: 49 }, () => job({ must: ["Java"] }));
  assert.equal(on({ ...old, skills: ["Rust"] }, rare, rest).next[0], "Lead with Rust: only 2% of postings ask for it.");
});

test("no line mentions the scoring or an unproven claim", () => {
  const banned = /\b(?:scores?|caps?|capped|weights?|tiers?)\b|at the screen|strong match|you lack/i;
  const seen = new Set();
  for (const p of PROFILES) for (const j of rows) for (const l of lines(score(p, j, stats))) seen.add(l);
  for (const j of [job({ must: [], skills: [] }), job({ title: "Software Engineer", role: "General", level: "Mid", years_required: null, must: ["Java", "Go", "Rust", "Scala"] })]) {
    for (const p of PROFILES) for (const l of lines(on(p, j))) seen.add(l);
  }
  for (const j of [job({ title: "VP, Sales", role: "Sales", level: "VP", must: ["Salesforce", "People Management"] }),
    job({ title: "Account Executive", role: "Sales", level: "Mid", must: ["Payments", "CRM"] }), job({ title: "Associate", role: "Other", must: ["Excel"] })]) {
    for (const p of PROFILES) for (const l of lines(onAll(p, j))) seen.add(l);
  }
  assert.ok(seen.size > 100, `only ${seen.size} lines seen`);
  for (const l of seen) assert.doesNotMatch(l, banned);
});

test("a security title reads as Security even when a backend word set the family", () => {
  const j = job({ title: "Senior Staff Security Engineer, Distributed Systems", level: "Staff+", role: "Backend" });
  assert.equal(part(on({ ...full, role: "Security", level: "Staff+" }, j), "Role").note, "Security to Security");
});

test("a coverage reason states what is true by count", () => {
  const listed = on({ ...full, evidence: Object.fromEntries(MUST.map(k => [k, ev(1, null)])) }, job());
  assert.equal(listed.held.why, "Java and Kafka are only listed on your resume, not shown in a job.");
  const obs = ["Observability", "Python", "Go", "Kubernetes", "AWS"], have = obs.slice(1);
  const one = on({ ...full, skills: have, evidence: Object.fromEntries(have.map(k => [k, ev(1, null)])) }, job({ title: "Expert Observability Engineer", role: "General", must: obs }));
  assert.equal(one.held.why, "Not on your resume: Observability.");
  const single = on({ ...full, skills: ["React"], role: "Frontend" }, job({ title: "Front End Engineer", role: "Frontend", must: ["React"] }));
  assert.equal(single.held.why, "It names only React, so check the posting yourself.");
  for (const p of PROFILES) for (const j of rows) {
    const r = score(p, j, stats), [, c, n] = (/^(\d+) of (\d+)/.exec(part(r, "Top must-haves").note) || [0, 0, 0]).map(Number), why = r.held?.why || "";
    if (why.startsWith("Most of its")) assert.ok((n - c) * 2 > n, `${j.title}: ${c} of ${n}`);
    if (why.startsWith("None of its")) assert.ok(n > 0 && c === 0, j.title);
    if (why.startsWith("Only one of its")) assert.ok(n > 1 && c === 1, j.title);
    assert.ok(!why.startsWith("Some of its"), j.title);
  }
});

test("a posting that names no known skills says so, and that part drops out", () => {
  const r = on(full, job({ must: [], skills: [] }));
  assert.equal(r.gaps[0], "It names none of the skills wradar knows, so check the posting yourself.");
  assert.ok(!r.gaps.includes("It has no clear requirements list, so check the posting yourself."));  // the same advice twice
  assert.equal(part(r, "Top must-haves").max, 0);
  assert.equal(part(r, "Top must-haves").note, "No skills named");
});

test("a posting with only nice-to-haves says it has no clear requirements list, not that it names no skills", () => {
  const r = on(full, job({ must: [], nice: ["AWS", "Kafka"] }));
  assert.ok(r.gaps.includes("It has no clear requirements list, so check the posting yourself."), JSON.stringify(r.gaps));
  assert.ok(!r.gaps.includes("It names none of the skills wradar knows, so check the posting yourself."), JSON.stringify(r.gaps));
});

test("a missing must-have is still listed when nothing holds the score down", () => {
  const r = on({ ...full, skills: ["Java", "Kafka", "AWS", "PostgreSQL"] }, job());
  assert.equal(r.held, null, JSON.stringify(r.held));
  assert.ok(r.gaps.includes("Not on your resume: Kubernetes."), JSON.stringify(r.gaps));
});

test("a missing skill the title names isn't said again as the Not on your resume list", () => {
  const r = on({ ...full, skills: ["Java", "Kafka", "AWS", "PostgreSQL"] }, job({ title: "Senior Kubernetes Engineer" }));
  assert.equal(r.held.why, "The title names Kubernetes, which is not on your resume.");
  assert.ok(!r.gaps.includes("Not on your resume: Kubernetes."), JSON.stringify(r.gaps));
});

test("the binding reason leads the gaps, and no gap after it says the same again", () => {
  for (const p of PROFILES) for (const j of rows) {
    const r = score(p, j, stats);
    if (!r.held) continue;
    assert.equal(r.gaps[0], r.held.why, j.title);
    for (const g of r.gaps.slice(1)) assert.ok(!r.held.why.toLowerCase().includes(g.toLowerCase().slice(0, -1)), `${j.title}: ${g}`);
  }
  const stepUp = on({ ...full, level: "Mid", years: 4 }, job({ title: "Backend Engineer", level: "Mid", years_required: 5 }));  // a step up read from the years asked
  assert.equal(stepUp.held.why, "It's a step up and it asks for 5+ years and you have 4.");
  assert.equal(stepUp.gaps.filter(g => g.includes("asks for 5+ years")).length, 1, JSON.stringify(stepUp.gaps));
});

test("what the resume doesn't show is said as the resume's, not the posting's", () => {
  const silent = on({ ...full, role: null, level: null, years: null }, job());
  assert.deepEqual(["Role", "Seniority", "Years"].map(n => part(silent, n).note), ["No role found on your resume", "No level found on your resume", "No years found on your resume"]);
  assert.equal(silent.held.why, "Your resume shows too little about your role or level, so check the posting yourself.");
  assert.equal(on({ ...full, role: "General", skills: MUST.slice(0, 4) }, job()).held.why, "Your resume shows no role family, so check the posting yourself.");
  const families = sandbox.window.JOB_DATA.rules.families.map(([, rx]) => new RegExp(rx, "i"));
  for (const j of rows.filter(x => x.role !== "Other" && families.some(rx => rx.test(x.title)))) {  // Other: the scan placed it in no field ("Data Entry Clerk")
    assert.ok(!lines(score({ ...old, role: "General" }, j, stats)).some(l => l.includes("names no family")), j.title);
  }
});

test("a topic word in a title moves it off the person's family only when the title doesn't name that family", () => {
  for (const [title, role] of [["Quality Automation Engineer", "QA / Test"], ["Data Engineer, Marketing", "Data"], ["Senior Site Reliability Engineer - Storage", "DevOps / SRE"]]) {
    assert.equal(part(on({ ...full, role }, job({ title, role })), "Role").note, `${role} to ${role}`, title);
  }
  assert.equal(part(on(full, job({ title: "Sr. Software Engineer, MarTech" })), "Role").note, "Different track");
  for (const title of ["Deployed Architect, Professional Services (Remote)", "Deployed Engineer (NYC)"]) {
    assert.equal(part(on(full, job({ title, role: "General" })), "Role").note, "Different track", title);
  }
});

test("a family fetch_jobs.py set from skills alone counts as read from skills", () => {
  assert.equal(part(on(full, job({ title: "Software Development Engineer - US Federal" })), "Role").note, "Backend to Backend (read from skills)");
  assert.equal(part(on(full, job()), "Role").note, "Backend to Backend");
});

test("same-kind skills a title joins with or or / are one requirement", () => {
  const java = { ...full, skills: ["Java"], evidence: { Java: ev(3, 0) } };
  assert.equal(part(on(java, job({ title: "Software Engineer - Java, Go or Kotlin", must: ["Java", "Go", "Kotlin"] })), "Top must-haves").note, "1 of 1: Java or Go or Kotlin");
  assert.equal(on(java, job({ title: "Software Engineer - Java and Kotlin", must: ["Java", "Kotlin"] })).held.why, "The title names Kotlin, which is not on your resume.");
  const python = { ...full, skills: ["Python"], evidence: { Python: ev(3, 0) } };
  assert.equal(on(python, job({ title: "Software Engineer - Python/Golang", must: ["Python", "Go"] })).held.why, "It names only one language, so check the posting yourself.");
});

test("the Everything else note counts each kind it scores", () => {
  assert.equal(part(on(full, job({ nice: ["Redis"] })), "Everything else").note, "1 nice-to-have");
  const many = job({ must: [...MUST, "Redis", "Agile"], nice: ["Go", "Rust"], skills: [...MUST, "Redis", "Agile", "Go", "Rust", "Docker"] });
  assert.equal(part(on(full, many), "Everything else").note, "2 other must-haves, 2 nice-to-haves and 1 mention");
});

test("a weak implied skill is named by the skill the resume shows", () => {
  const r = on({ ...full, skills: ["PostgreSQL", "Java"], evidence: { PostgreSQL: ev(1, null), Java: ev(3, 0) } }, job({ must: ["SQL", "Java"] }));
  assert.ok(r.next.includes("PostgreSQL is only listed: if you used it at work, show that in a job bullet."));
  assert.ok(!lines(r).some(l => l.startsWith("SQL ")));
});

test("data without fields scores as data whose every role is Engineering", () => {
  const none = buildStats(rows), eng = buildStats(rows, { fields: Object.fromEntries(rows.map(r => [r.role, "Engineering"])) });
  for (const p of PROFILES) for (let i = 0; i < rows.length; i += 7) {
    const a = score(p, rows[i], none), b = score(p, rows[i], eng);
    assert.equal(b.tie, a.tie, rows[i].title);
    assert.deepEqual(b.gaps, a.gaps, rows[i].title);
  }
});

test("R in a title is the language only when it stands alone", () => {
  const py = { ...full, skills: ["Python", "SQL"], evidence: { Python: ev(3, 0), SQL: ev(3, 0) } }, must = ["R", "Python", "SQL"];
  for (const title of ["Data Scientist, R&D", "SAP R/3 Data Analyst", "Brand(R) Data Scientist"]) {
    assert.ok(!lines(on(py, job({ title, role: "Data", must }))).some(l => l.includes("title names R")), title);
  }
  assert.equal(on(py, job({ title: "Data Scientist - R", role: "Data", must })).held.why, "The title names R, which is not on your resume.");
});

test("a professional degree meets a bachelor's or master's bar, and only it meets its own", () => {
  const asks = (level, req = "required") => job({ degree: { level, req } }), got = (degree, j) => part(on({ ...full, degree }, j), "Degree");
  for (const level of ["associate", "bachelor", "master", "professional"]) assert.equal(got("Professional", asks(level)).got, 4, level);
  assert.equal(got("Professional", asks("phd")).got, 0);
  assert.equal(got("PhD", asks("professional")).got, 0);
  assert.ok(on({ ...full, degree: "PhD" }, asks("professional")).gaps.includes("It lists a professional degree as required."));
  assert.equal(got("PhD", asks("professional", "preferred")).got, 2);
  assert.deepEqual([got("Associate", asks("associate")).got, got("Associate", asks("associate")).note], [4, "associate degree required"]);
});
