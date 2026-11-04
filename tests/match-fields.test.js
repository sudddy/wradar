"use strict";
// Matching in every field and along the whole ladder, on synthetic jobs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { score, buildStats } = require("../docs/match.js");
const { MUST, job, on, part, lines, ev, full, onAll, person } = require("./match-helpers.js");

test("an Account Executive matches a sales job, where SaaS is a requirement and Negotiation is not", () => {
  const must = ["Salesforce", "Prospecting", "Quota Attainment", "Enterprise Sales", "SaaS", "Negotiation"];
  const r = onAll(person("Sales", "Mid", 5, must), job({ title: "Enterprise Account Executive", role: "Sales", level: "Mid", must, years_required: 4 }));
  assert.equal(r.tier, "Hot");
  assert.equal(part(r, "Role").note, "Sales to Sales");
  assert.match(part(r, "Top must-haves").note, /^5 of 5: .*SaaS/);
  assert.equal(part(r, "Everything else").note, "1 other must-have");
});

test("Payments is a real requirement in a sales job but background in an engineering one", () => {
  const sales = onAll(person("Sales", "Mid", 5, ["Salesforce"]), job({ title: "Account Executive", role: "Sales", level: "Mid", must: ["Payments", "Salesforce"], years_required: 3 }));
  assert.match(part(sales, "Top must-haves").note, /^1 of 2: .*Payments/);
  assert.ok(sales.gaps.includes("Not on your resume: Payments."), JSON.stringify(sales.gaps));
  const eng = onAll(full, job({ must: [...MUST, "Payments"] }));
  assert.ok(!part(eng, "Top must-haves").note.includes("Payments"));
  assert.equal(part(eng, "Everything else").note, "1 other must-have");
});

test("a row read once is read again when its field changes, and a rebuild over more rows plans the same", () => {
  const ae = job({ title: "Account Executive", role: "Sales", level: "Mid", must: ["Payments", "Salesforce"], years_required: 3 }), p = person("Sales", "Mid", 5, ["Salesforce"]);
  assert.equal(part(on(p, ae), "Top must-haves").note, "1 of 1: Salesforce");  // data without fields: every role is Engineering
  assert.match(part(onAll(p, ae), "Top must-haves").note, /^1 of 2: .*Payments/);
  // A title with no family word lets its skills vote, and the rows older.js joins change what Java, Kafka and AWS say.
  const swe = job({ title: "Software Engineer II", level: "Mid", must: ["Java", "Kafka", "AWS"] });
  const backend = Array.from({ length: 10 }, () => job({ must: ["Go", "PostgreSQL", "Redis"] }));
  const data = Array.from({ length: 10 }, () => job({ title: "Data Engineer", role: "Data", must: ["Java", "Kafka", "AWS"] }));
  const rows = [ae, swe, ...backend, ...data], copies = rows.map(j => ({ ...j }));
  const rules = { fields: { Sales: "Sales", Backend: "Engineering", Data: "Engineering" } }, first = buildStats(rows.slice(0, 12), rules);
  assert.equal(part(score(full, swe, first), "Role").note, "Backend to Backend (read from skills)");  // the first paint, before older.js joins
  const joined = buildStats(rows, rules), fresh = buildStats(copies, rules);
  assert.equal(part(score(full, swe, joined), "Role").note, "Backend to Data (read from skills)");
  rows.forEach((j, i) => assert.deepEqual(score(full, j, joined), score(full, copies[i], fresh), j.title));
});

test("reconciliation and demand planning are the job in finance and operations, and background in engineering", () => {
  for (const [k, title, role] of [["Account Reconciliation", "Staff Accountant", "Accounting"], ["Demand & Supply Planning", "Demand Planner", "Supply chain"]]) {
    const at = onAll(person(role, "Mid", 5, ["Excel"]), job({ title, role, level: "Mid", must: [k, "Excel"], years_required: 3 }));
    assert.match(part(at, "Top must-haves").note, new RegExp(`^1 of 2: .*${k}`), k);
    assert.equal(part(onAll(full, job({ must: [...MUST, k] })), "Everything else").note, "1 other must-have", k);
  }
});

test("a Senior Accountant's CPA counts in full when only listed, and never reads as only listed", () => {
  const skills = ["GAAP", "Month-end Close", "Account Reconciliation", "NetSuite", "CPA"];
  const j = job({ title: "Senior Accountant", role: "Accounting", level: "Senior", must: ["CPA", "GAAP", "Month-end Close", "Account Reconciliation", "ERP Systems"] });
  const shownIn = over => ({ evidence: { ...Object.fromEntries(skills.map(k => [k, ev(3, 0)])), ...over } });
  const shown = onAll(person("Accounting", "Senior", 6, skills), j), listed = onAll(person("Accounting", "Senior", 6, skills, shownIn({ CPA: ev(1, null) })), j);
  assert.equal(listed.tier, "Hot");
  assert.equal(listed.score, shown.score);
  assert.match(part(listed, "Top must-haves").note, /^5 of 5/);  // NetSuite shows ERP Systems
  assert.ok(!lines(listed).some(l => l.includes("only listed")), JSON.stringify(lines(listed)));
  const close = onAll(person("Accounting", "Senior", 6, skills, shownIn({ "Month-end Close": ev(1, null) })), j);  // a skill, not a credential
  assert.ok(close.next.includes("Month-end Close is only listed: if you used it at work, show that in a job bullet."), JSON.stringify(close.next));
});

test("a Recruiter matches a recruiting job, where Recruiting is a requirement", () => {
  const rec = person("Recruiting", "Mid", 4, ["Full-cycle Recruiting", "Candidate Sourcing", "Greenhouse", "Recruiting", "Technical Recruiting"]);
  const must = ["Full-cycle Recruiting", "Candidate Sourcing", "Applicant Tracking Systems", "Recruiting", "Technical Recruiting"];
  const r = onAll(rec, job({ title: "Technical Recruiter", role: "Recruiting", level: "Mid", must, years_required: 3 }));
  assert.equal(r.tier, "Hot");
  assert.match(part(r, "Top must-haves").note, /^5 of 5: .*Recruiting/);
  assert.equal(part(onAll(full, job({ must: [...MUST, "Recruiting"] })), "Everything else").note, "1 other must-have");
});

test("a nurse's licence counts in full, and Healthcare is the job, not background", () => {
  const skills = ["RN License", "EHR Systems", "Healthcare", "Utilization Management"];
  const rn = person("Clinical", "Mid", 5, skills, { evidence: { ...Object.fromEntries(skills.map(k => [k, ev(3, 0)])), "RN License": ev(1, null) } });
  const r = onAll(rn, job({ title: "Registered Nurse, Care Management", role: "Clinical", level: "Mid", must: skills, years_required: 3 }));
  assert.equal(r.tier, "Hot");
  assert.match(part(r, "Top must-haves").note, /^4 of 4: .*Healthcare/);
  assert.ok(!lines(r).some(l => l.includes("only listed")), JSON.stringify(lines(r)));
});

test("a licence the posting requires is the screen: held, it carries a posting that names only it, and no other licence stands in", () => {
  const clinic = (title, must) => job({ title, role: "Clinical", level: "Mid", must, years_required: 2 });
  const np = person("Clinical", "Mid", 4, ["Nurse Practitioner License", "EHR Systems"]), rn = person("Clinical", "Mid", 6, ["RN License", "EHR Systems"]);
  const own = onAll(np, clinic("Nurse Practitioner, Primary Care", ["Nurse Practitioner License"]));
  assert.equal(own.tier, "Hot", JSON.stringify(own.held));
  assert.equal(part(own, "Top must-haves").note, "1 of 1: Nurse Practitioner License");
  const either = onAll(np, clinic("Nurse Practitioner or Physician Assistant", ["Nurse Practitioner License", "Physician Assistant License"]));
  assert.equal(part(either, "Top must-haves").note, "1 of 1: Nurse Practitioner License or Physician Assistant License");
  assert.equal(either.tier, "Hot");
  const md = onAll(rn, clinic("Primary Care Physician", ["Medical License"]));
  assert.deepEqual(md.held, { at: 54, why: "Most of its top must-haves are not on your resume." });
  assert.ok(!lines(md).some(l => l.includes("closest match")), JSON.stringify(lines(md)));
  assert.ok(md.next.includes("If you hold Medical License, add it to your resume."), JSON.stringify(md.next));  // held, not used or learnt
  const ward = onAll(np, clinic("Registered Nurse, Telehealth", ["RN License", "EHR Systems"]));  // an NP holds an RN licence
  assert.equal(part(ward, "Top must-haves").note, "2 of 2: RN License, EHR Systems");
  assert.ok(!ward.gaps.some(g => g.includes("RN License")), JSON.stringify(ward.gaps));
  const both = clinic("Nurse Practitioner, Primary Care", ["Nurse Practitioner License", "RN License", "EHR Systems"]);  // an NP needs an RN licence too
  assert.equal(part(onAll(np, both), "Top must-haves").note, "3 of 3: Nurse Practitioner License, RN License, EHR Systems");
  assert.deepEqual(onAll(rn, both).held, { at: 74, why: "Not on your resume: Nurse Practitioner License." });
  const lcsw = person("Clinical", "Mid", 6, ["Social Work License", "EHR Systems"]);  // "RN or LCSW": either licence meets it
  assert.equal(onAll(lcsw, clinic("Care Manager", ["RN License", "Social Work License", "EHR Systems"])).tier, "Hot");
});

test("a credential screens only in a field that asks for it: CPA in a marketing posting is cost per acquisition", () => {
  const ads = ["Performance Marketing", "Google Ads", "Unit Economics"], cpa = ["CPA", "GAAP", "Month-end Close"];
  const books = Array.from({ length: 10 }, () => job({ title: "Senior Accountant", role: "Accounting", level: "Senior", must: cpa }));
  const growth = Array.from({ length: 10 }, () => job({ title: "Growth Marketing Manager", role: "Marketing", level: "Mid", must: ads, years_required: 3 }));
  const paid = job({ title: "Paid Media Manager", role: "Marketing", level: "Mid", must: [...ads, "Meta Ads", "CPA"], years_required: 3 });
  const r = onAll(person("Marketing", "Mid", 5, [...ads, "Meta Ads"]), paid, [...books, ...growth]);
  assert.equal(r.tier, "Hot", JSON.stringify(r.held));
  assert.equal(part(r, "Top must-haves").note, "3 of 4: Performance Marketing, Google Ads or Meta Ads, Unit Economics, CPA");
  const acct = onAll(person("Accounting", "Senior", 6, ["GAAP", "Month-end Close"]), books[0], [...books.slice(1), ...growth, paid]);
  assert.equal(part(acct, "Top must-haves").note, "2 of 3: CPA, GAAP, Month-end Close");
  assert.deepEqual(acct.held, { at: 74, why: "Not on your resume: CPA." });
});

test("a General job is no role match for someone from another field, nor a job in another field for a General resume", () => {
  const must = ["SQL", "Python", "Tableau"], swe = job({ title: "Software Engineer", role: "General", level: "Mid", must, years_required: 3 });
  const analyst = person("Analytics", "Mid", 4, must), r = onAll(analyst, swe);
  assert.equal(part(r, "Role").note, "Analytics to Engineering");
  assert.deepEqual(r.held, { at: 50, why: "This is an Engineering role and your track is Analytics." });
  assert.equal(part(onAll({ ...full, skills: must }, swe), "Role").max, 0);  // an engineer: the family is unknown, the field is the same
  assert.equal(part(on(analyst, swe), "Role").max, 0);  // data without fields
  const ae = onAll(person("General", "Mid", 4, ["Salesforce", "Prospecting"]), job({ title: "Account Executive", role: "Sales", level: "Mid", must: ["Salesforce", "Prospecting"] }));
  assert.equal(part(ae, "Role").note, "Engineering to Sales");
  assert.ok(ae.gaps.includes("This is a Sales role and your track is Engineering."), JSON.stringify(ae.gaps));
});

test("an intern's next job is Junior, and early in a career a year short is internships, not a hold", () => {
  const intern = { ...full, level: "Intern", years: 0.3 }, grad = (years_required, level = "Junior") => job({ title: "Software Engineer, New Grad", level, years_required });
  const r = on(intern, grad(null));
  assert.equal(part(r, "Seniority").note, "Intern to Junior");
  assert.equal(part(r, "Seniority").got, 12);
  assert.equal(r.held, null);
  assert.ok(r.next.includes("Say when you graduate, so they know when you can start."), JSON.stringify(r.next));
  assert.ok(!lines(r).some(l => l.includes("step up")), JSON.stringify(lines(r)));
  const year = on(intern, grad(1));
  assert.equal(year.held, null, JSON.stringify(year.held));
  assert.ok(year.next.includes("You are 0.7 years short: apply anyway and open with your biggest result, with its numbers."), JSON.stringify(year.next));
  assert.equal(on(intern, grad(2)).held.why, "It asks for 2+ years and you have 0.3.");
  assert.equal(on({ ...full, level: "Junior", years: 0.5 }, grad(1)).held, null);
  assert.equal(on({ ...full, level: "Mid", years: 1 }, grad(3, "Mid")).held.why, "It asks for 3+ years and you have 1.");  // later on, a ratio as before
});

test("from a manager's level, a title with no level word is an individual job, whatever years it asks", () => {
  const must = ["Salesforce", "Prospecting", "Enterprise Sales"], vp = person("Sales", "VP", 18, [...must, "People Management"]);
  const ae = years_required => onAll(vp, job({ title: "Account Executive", role: "Sales", level: "Mid", must, years_required }));
  assert.equal(part(ae(1), "Seniority").note, "VP to Junior (read from years)");
  assert.deepEqual(ae(1).held, { at: 60, why: "Junior is 6 levels below your VP experience." });
  assert.equal(part(ae(null), "Seniority").note, "VP to an individual role");
  assert.deepEqual(ae(null).held, { at: 60, why: "It names no team or level, so it reads as an individual role below your VP experience." });
  const mgr = onAll({ ...vp, level: "Manager" }, job({ title: "Account Executive", role: "Sales", level: "Mid", must, years_required: null }));
  assert.equal(part(mgr, "Seniority").got, 10.2);
  assert.ok(mgr.next.includes("Lead with work you did yourself."), JSON.stringify(mgr.next));
  assert.equal(part(on({ ...full, level: "Senior" }, job({ title: "Backend Engineer", level: "Mid", years_required: 5 })), "Seniority").note, "Senior to Senior (read from years)");
});

test("a Director of Marketing moving to VP is one step up, and so is each manager step", () => {
  const skills = ["Demand Generation", "Brand Strategy", "Marketing Automation", "Performance Marketing", "People Management"];
  const dir = person("Marketing", "Director", 14, skills), at = (title, level) => job({ title, role: "Marketing", level, must: skills, years_required: 12 });
  const r = onAll(dir, at("VP, Marketing", "VP"));
  assert.equal(part(r, "Role").note, "Marketing to Marketing");
  assert.equal(part(r, "Seniority").note, "Director to VP");
  assert.equal(part(r, "Seniority").got, 12);  // one step, with the years asked
  assert.deepEqual(r.held, { at: 74, why: "This is a step up from your Director experience." });
  assert.ok(r.next.includes("This is a step up: show VP scope, such as what you led and decided."), JSON.stringify(r.next));
  assert.ok(r.next.includes("Open with the team you led, its size and what it delivered."), JSON.stringify(r.next));
  for (const [from, title, to] of [["Senior Manager", "Director, Marketing", "Director"], ["Senior Director", "VP, Marketing", "VP"], ["VP", "Chief Marketing Officer", "C-level"]]) {
    assert.equal(onAll({ ...dir, level: from }, at(title, to)).held?.why, `This is a step up from your ${from} experience.`, `${from} to ${to}`);
  }
  assert.ok(onAll(dir, at("Senior Director, Marketing", "Senior Director")).fits.includes("The level matches your Director experience."));
});

test("an IC moving to a manager job needs people they managed shown in a job", () => {
  const ic = { ...full, level: "Staff+", years: 10 }, em = job({ title: "Engineering Manager, Backend", level: "Manager" });
  const withPeople = e => on({ ...ic, skills: [...MUST, "People Management"], evidence: { ...ic.evidence, "People Management": e } }, em);
  const none = on(ic, em), listed = withPeople(ev(1, null)), led = withPeople(ev(3, 0));
  assert.equal(part(none, "Seniority").note, "Staff+ to Manager");
  assert.equal(part(none, "Seniority").got, 9);
  assert.deepEqual(none.held, { at: 74, why: "It manages a team, and your resume shows no people you managed." });
  assert.deepEqual(listed.held, none.held);
  assert.equal(part(led, "Seniority").got, 12.8);
  assert.equal(led.held, null);
  assert.ok(led.next.includes("Open with the team you led, its size and what it delivered."), JSON.stringify(led.next));
  assert.ok(!lines(led).some(l => l.includes("no people you managed")));
});

test("a Staff engineer and an Engineering Manager share a rank: the gap between them is the track", () => {
  const staff = { ...full, level: "Staff+", years: 10 }, mgr = { ...staff, level: "Manager" };
  const up = on(staff, job({ title: "Engineering Manager, Backend", level: "Manager" })), down = on(mgr, job({ title: "Staff Backend Engineer", level: "Staff+" }));
  for (const r of [up, down]) assert.ok(!lines(r).some(l => /levels? (?:above|below)|step up|matches your/.test(l)), JSON.stringify(lines(r)));
  assert.equal(part(down, "Seniority").note, "Manager to Staff+");
  assert.equal(part(down, "Seniority").got, 12.8);
  assert.ok(down.next.includes("Lead with work you did yourself."), JSON.stringify(down.next));
  assert.equal(down.tier, "Hot");
});

test("an internship reads as Intern", () => {
  const intern = job({ title: "Software Engineering Intern", level: "Intern", years_required: null });
  const r = on({ ...full, level: "Intern", years: 0 }, intern);
  assert.equal(part(r, "Seniority").note, "Intern to Intern");
  assert.ok(r.fits.includes("The level matches your Intern experience."));
  const older = job({ title: "Backend Engineer Intern (Summer 2027)", level: "Junior", years_required: null });  // today's data reads interns as Junior
  assert.equal(part(on({ ...full, level: "Junior", years: 1 }, older), "Seniority").note, "Junior to Intern");
  assert.equal(on(full, intern).held.why, "This is an early-career program, and your experience is past it.");
});

test("neighbouring families across fields count part of the way", () => {
  const r = onAll(person("Sales", "Mid", 5, MUST), job({ title: "Customer Success Manager", role: "Customer success", level: "Mid" }));
  assert.equal(part(r, "Role").got, 12);
  assert.ok(r.next.includes("Describe your Sales work in Customer success terms in your opening lines."), JSON.stringify(r.next));
  assert.equal(part(onAll({ ...full, role: "Cybersecurity" }, job({ title: "Senior Security Engineer", role: "Security" })), "Role").got, 14);
});

test("the software title rules leave other fields alone", () => {
  for (const [title, role] of [["Solutions Consultant, Professional Services", "Solutions & presales"], ["Salesforce Administrator", "Revenue operations"],
    ["Growth Marketing Manager", "Marketing"], ["Security GRC Program Manager", "Cybersecurity"], ["ASIC Design Engineer", "Hardware"]]) {
    assert.equal(part(onAll({ ...full, role }, job({ title, role })), "Role").note, `${role} to ${role}`, title);
  }
  assert.equal(part(onAll(full, job({ title: "Sr. Software Engineer, MarTech" })), "Role").note, "Different track");
  assert.equal(part(onAll({ ...full, role: "Security" }, job({ title: "Security GRC Program Manager", role: "Cybersecurity" })), "Role").note, "Security to Cybersecurity");
});

test("an Other role on a job or a resume is no role", () => {
  const r = onAll(full, job({ title: "Associate", role: "Other", level: "Junior" }));
  assert.equal(part(r, "Role").max, 0);
  assert.equal(part(r, "Role").note, "Title names no family");
  const other = onAll({ ...full, role: "Other" }, job());
  assert.equal(other.score, onAll({ ...full, role: null }, job()).score);
  assert.equal(part(other, "Role").note, "No role found on your resume");
});

test("how few postings ask for a skill is counted within the job's field", () => {
  const books = Array.from({ length: 49 }, () => job({ title: "Accountant", role: "Accounting", level: "Mid", must: ["GAAP"] }));
  const code = Array.from({ length: 50 }, () => job({ must: ["Treasury Management"] }));
  const treasury = job({ title: "Treasury Accountant", role: "Accounting", level: "Mid", must: ["Treasury Management"] });
  const r = onAll(person("Accounting", "Mid", 5, ["Treasury Management"]), treasury, [...books, ...code]);
  assert.equal(r.next[0], "Lead with Treasury Management: only 2% of finance postings ask for it.");
  const gaap = onAll(person("Accounting", "Mid", 5, ["Excel"]), books[0], [treasury, ...books.slice(1), ...code]);
  assert.ok(gaap.next.includes("If you have used GAAP, add it to your resume. If not, 98% of finance postings ask for it, so it's worth learning."), JSON.stringify(gaap.next));
  const counsel = job({ title: "Counsel", role: "Legal", level: "Mid", must: ["Commercial Contracts"] });
  const law = score(person("Legal", "Mid", 5, ["Excel"]), counsel, buildStats([counsel], { fields: { Legal: "Legal & compliance" } }));
  assert.ok(law.next.some(l => l.endsWith("100% of legal and compliance postings ask for it, so it's worth learning.")), JSON.stringify(law.next));
});

test("a general skill joins its tools' kind: CRM and Salesforce are one requirement", () => {
  const r = onAll(person("Sales", "Mid", 5, ["HubSpot"]), job({ title: "Account Executive", role: "Sales", level: "Mid", must: ["CRM", "Salesforce"], years_required: 3 }));
  assert.equal(part(r, "Top must-haves").note, "1 of 1: CRM or Salesforce");
  assert.equal(r.held.why, "It names only one CRM, so check the posting yourself.");
});

test("early-career words in a recruiter's or a manager's title name who is hired, not the level", () => {
  const must = ["Full-cycle Recruiting", "Candidate Sourcing", "University Recruiting"], rec = person("Recruiting", "Senior", 6, must);
  const at = (title, level, p = rec, role = "Recruiting") => part(onAll(p, job({ title, role, level, must, years_required: 4 })), "Seniority").note;
  assert.equal(at("Senior Recruiter, Emerging Talent", "Senior"), "Senior to Senior");
  assert.equal(at("Manager, Intern Programs", "Manager", { ...rec, level: "Manager" }, "People & HR"), "Manager to Manager");
  assert.equal(at("Recruiting Intern", "Intern"), "Senior to Intern");
});

test("a job whose family is unknown ranks its skills by its own field", () => {
  const backend = Array.from({ length: 10 }, (_, i) => job({ must: i < 2 ? ["Java", "SQL"] : ["Java"] }));
  const sales = Array.from({ length: 30 }, () => job({ title: "Account Executive", role: "Sales", level: "Mid", must: ["SQL"] }));
  const general = job({ title: "Software Engineer", role: "General", level: "Mid", must: ["SQL", "Java"] });
  assert.equal(part(onAll(full, general, [...backend, ...sales]), "Top must-haves").note, "2 of 2: Java, SQL");  // across every field, SQL would come first
});

test("abbreviations that sound like a vowel take an", () => {
  for (const role of ["FP&A", "HR", "SDR", "SEO"]) {
    assert.ok(onAll({ ...full, role: "Sales" }, job({ title: "Specialist", role })).gaps.includes(`This is an ${role} role and your track is Sales.`), role);
  }
  assert.ok(onAll({ ...full, role: "Accounting" }, job({ title: "Account Executive", role: "Sales" })).gaps.includes("This is a Sales role and your track is Accounting."));
});
