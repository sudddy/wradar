"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = path.join(__dirname, "../docs/resume.js");
const { parseResume, pdfLines, upgradeProfile, resumeLabel, STORED_KEYS } = require(source);
const { levelOf } = require("../docs/match.js");

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../docs/jobs.js"), "utf8"), sandbox);
const { rules } = sandbox.window.JOB_DATA;
// keywords.json itself, so a keyword edit fails here at once instead of after the scan that would publish it.
const keywords = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(__dirname, "../keywords.json"), "utf8"))).filter(([k]) => !k.startsWith("_")));

// Same compile as SKILLS in docs/app.js; a pattern JavaScript can't read throws here and fails every test.
const rxEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SKILLS = Object.entries(keywords).map(([name, aliases]) => [name, aliases.map(a => a.startsWith("re:")
  ? new RegExp(a.slice(3))
  : new RegExp("(?<![A-Za-z0-9])" + rxEscape(a.replace(/^=/, "")) + "(?![A-Za-z0-9+#])", a.startsWith("=") ? "" : "i"))]);

const NOW = new Date(2026, 10, 2);
const read = text => parseResume(text, SKILLS, rules, NOW);
const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", `${name}.txt`), "utf8");
const latest = p => Object.values(p.evidence).filter(e => e.strength === 3).length;

const PERSONAS = [
  { file: "daniel-okafor", years: 9, role: "Backend", titleLevel: "Senior", level: "Senior", degree: "Master's", skills: 32, latest: 13,
    secrets: /daniel|okafor|harborline|sentry|kestrel|lakeshore|toronto|example\.com/i },
  { file: "priya-raman", years: 1.5, role: "Frontend", titleLevel: null, level: "Junior", degree: "Bachelor's", skills: 15, latest: 5,
    secrets: /priya|raman|mosaic|hill country|austin|example\./i },
  { file: "marta-lindqvist", years: 12, role: "ML / AI", titleLevel: "Staff+", level: "Staff+", degree: "PhD", skills: 20, latest: 9,
    secrets: /marta|lindqvist|aurora|cedar|cascade|seattle|example\.com/i },
  { file: "cassandra-reyes", years: 6, role: "DevOps / SRE", titleLevel: null, level: "Senior", degree: "Bachelor's", skills: 21, latest: 9,
    secrets: /cassandra|reyes|northgate|pinecrest|front range|denver|boulder|example\.com/i },
  { file: "elena-marsh", years: 4, role: "Full stack", titleLevel: null, level: "Mid", degree: "Master's", skills: 18, latest: 9,
    secrets: /elena|marsh|brightwell|tallgrass|lincoln|westlake|prairie|chicago|example\.com/i },
  // Held out: written before the parser was tuned, and not changed to suit it.
  { file: "ivan-ios", years: 4, role: "Mobile", titleLevel: null, level: "Mid", degree: "Bachelor's", skills: 7, latest: 4,
    secrets: /ivan|kovalenko|pinecrest|harbor lane|tar river|raleigh|durham|example\.com/i },
  { file: "nora-data", years: 6, role: "Data", titleLevel: "Senior", level: "Senior", degree: "Bachelor's", skills: 17, latest: 5,
    secrets: /nora|haddad|lakeshore|cobalt|north prairie|minneapolis|st\. paul|example\.com/i },
  { file: "samir-sre", years: 11.5, role: "DevOps / SRE", titleLevel: "Staff+", level: "Staff+", degree: "Master's", skills: 18, latest: 8,
    secrets: /samir|qureshi|quillstone|bluefin|ardent|lake erie|pittsburgh|cleveland|example\.com/i },
  // Outside engineering: written for the all-roles review, before the reader learned other fields.
  { file: "sam-finance", years: 10, role: "Finance", titleLevel: "Manager", level: "Manager", degree: "Bachelor's", skills: 13, latest: 3,
    key: ["FP&A", "GAAP", "Month-end Close", "NetSuite", "CPA", "People Management"],
    secrets: /\bsam\b|ortiz|harbor freight|lakeview|grant & ruiz|depaul|chicago|example\.com/i },
  { file: "jordan-marketing", years: 15.5, role: "Marketing", titleLevel: "Director", level: "Director", degree: "Master's", skills: 13, latest: 5,
    key: ["Demand Generation", "Product Marketing", "HubSpot", "Marketo", "People Management"],
    secrets: /jordan|\bvale\b|northwind|bluebird|copperline|austin|baylor|university of texas|example\.com/i },
  { file: "alex-designer", years: 9, role: "Design", titleLevel: "Senior", level: "Senior", degree: "Bachelor's", skills: 6, latest: 3,
    key: ["Figma", "Design Systems", "User Research"],
    secrets: /\balex\b|\bkim\b|maple pay|lighthouse|toronto|ocad/i },
  { file: "riley-recruiter", years: 8, role: "Recruiting", titleLevel: "Senior", level: "Senior", degree: "Bachelor's", skills: 7, latest: 3,
    key: ["Greenhouse", "Full-cycle Recruiting", "Technical Recruiting", "Candidate Sourcing"],
    secrets: /riley|\bchen\b|cascade cloud|evergreen|seattle|university of washington/i },
  { file: "morgan-sales", years: 19.5, role: "Sales", titleLevel: "VP", level: "VP", degree: "Bachelor's", skills: 8, latest: 4,
    key: ["Salesforce", "Gong", "Enterprise Sales", "Quota Attainment", "People Management"],
    secrets: /morgan|blake|ridgeway|pinnacle|summit systems|new york|\bnyu\b/i },
];

// ---- PDF.js shaped items ----
const CHAR = 5, SIZE = 10, LEAD = 12, LEFT = 40, RIGHT = 420, TOP = 760;
const item = (str, x, y) => ({ str, dir: "ltr", width: str.length * CHAR, height: SIZE, transform: [SIZE, 0, 0, SIZE, x, y], fontName: "g_d0_f1", hasEOL: false });
const wholeLine = (line, x, y) => [item(line, x, y), { ...item("", x, y), width: 0, hasEOL: true }];
const wordByWord = (line, x, y) => [...line.matchAll(/\S+/g)].flatMap(m =>
  [item(m[0], x + m.index * CHAR, y), item(" ", x + (m.index + m[0].length) * CHAR, y)]);
const wrap = (line, width) => line.split(/\s+/).reduce((rows, w) => {
  const last = rows[rows.length - 1];
  if (last && last.length + w.length < width) rows[rows.length - 1] = `${last} ${w}`; else rows.push(w);
  return rows;
}, []);
// Content order in a PDF has nothing to do with reading order, so the items arrive reversed.
const page = (top, left, right, pieces) => [
  ...top.flatMap((l, i) => pieces(l, LEFT, TOP - i * LEAD)),
  ...left.flatMap((l, i) => pieces(l, LEFT, TOP - (top.length + i) * LEAD)),
  ...right.flatMap((l, i) => pieces(l, RIGHT, TOP - (top.length + i) * LEAD)),
].reverse();

const SIDEBAR = /^(?:technical skills|skills|education|certifications|s k i l l s|e d u c a t i o n|p u b l i c a t i o n s)$/i;
const MAIN = /^(?:about me|summary|s u m m a r y|professional summary|professional experience|work history|experience|e x p e r i e n c e|projects|previous career)$/i;
// Skills, education and the like move to a right-hand column; everything else stays on the left.
function sidebarLayout(text) {
  const out = { top: [], left: [], right: [] };
  let at = out.top;
  for (const line of text.split("\n").filter(l => l.trim())) {
    if (SIDEBAR.test(line)) at = out.right; else if (MAIN.test(line)) at = out.left;
    at.push(...(at === out.right ? wrap(line, 36) : at === out.left ? wrap(line, 66) : [line]));
  }
  return out;
}

// ---- Facts ----
for (const want of PERSONAS) test(`reads the facts of ${want.file}`, () => {
  const p = read(fixture(want.file));
  assert.deepEqual({ years: p.years, role: p.role, titleLevel: p.level, level: levelOf(p), degree: p.degree, skills: p.skills.length, latest: latest(p) },
    { years: want.years, role: want.role, titleLevel: want.titleLevel, level: want.level, degree: want.degree, skills: want.skills, latest: want.latest });
  for (const k of want.key || []) assert.ok(p.skills.includes(k), k);
});

test("evidence says where each skill was used and how long ago", () => {
  const { evidence: e } = read(fixture("daniel-okafor"));
  assert.deepEqual(e.Java, { strength: 3, years: 9, recent: 0 });
  assert.deepEqual(e.Hibernate, { strength: 2, years: 1.5, recent: 90 });
  assert.deepEqual(e.Docker, { strength: 1, years: 0, recent: null });
  assert.equal(read(fixture("priya-raman")).evidence["Next.js"].strength, 2, "a project counts as older work");
});

test("years count the field of the latest job, and stated years don't override that", () => {
  const p = read(fixture("elena-marsh"));
  assert.equal(p.years, 4);
  assert.match(fixture("elena-marsh"), /11 years of professional experience/);
  assert.equal(read(fixture("elena-marsh").replace("Chemistry Teacher", "Software Engineer")).years, 11, "the teaching years count once they are engineering");
});

// ---- Any field ----
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

test("a job with no title counts when it names three skills that aren't soft", () => {
  assert.equal(resume(["Jan 2020 - Present", "- Built Java, Kafka and PostgreSQL services."]).years, 6.5);
  assert.equal(resume(["Jan 2020 - Present", "- Ran Agile ceremonies in Jira for a SaaS team."]).years, null);
});

test("years come from the latest job's field, else the field with the most months, else every job", () => {
  const sales = job("Account Executive", "Jan 2020 - Present", "Closed enterprise deals."), teach = job("Chemistry Teacher", "Jan 2010 - Dec 2019", "Taught chemistry.");
  assert.equal(resume(sales, teach).years, 6.5);
  const unknown = job("Laboratory Assistant", "Jan 2024 - Present", "Prepared reagents.");
  assert.equal(resume(unknown, sales.map(l => l.replace("Present", "Dec 2023")), teach.map(l => l.replace("2010", "2019"))).years, 4, "the latest field is unknown: Sales has the most months");
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

test("a title line that starts with a dot still names the job", () => {
  const p = read(fixture("ivan-ios").replace("iOS Engineer\n", ".NET Developer\n"));
  assert.deepEqual([p.years, levelOf(p)], [4, "Mid"]);
});

test("a resume with no dates falls back on the stated years", () => {
  assert.equal(read("SUMMARY\nBackend engineer with 7+ years of experience in Java.\nSKILLS\nJava, Kafka\n").years, 7);
  assert.equal(read("SUMMARY\nSales executive with 18 years building enterprise sales teams.\nSKILLS\nSalesforce\n").years, 18);
  assert.equal(read("SUMMARY\nCPA and finance manager with 9 years in FP&A and accounting.\nSKILLS\nNetSuite\n").years, 9);
  assert.equal(read("SUMMARY\nRecruiter with 6 years leading technical hiring.\nSKILLS\nGreenhouse\n").years, 6);
});

test("empty text gives an empty profile", () => {
  assert.deepEqual(read(""), { skills: [], years: null, evidence: {}, role: null, level: null, degree: null });
});

// ---- Sections and dates ----
for (const [file, dates] of [["daniel-okafor", "Mar 2021 – Present"], ["elena-marsh", "2024-06 to present"], ["priya-raman", "07/2025 - Present"], ["marta-lindqvist", "2021 – Present"]])
  test(`a sub-heading inside a job doesn't end the experience of ${file}`, () => {
    assert.deepEqual(read(fixture(file).replace(dates, `${dates}\nKey Achievements`)), read(fixture(file)));
  });

test("a section after Experience that opens straight onto a job stays its own section", () => {
  const p = read(fixture("daniel-okafor").replace("EDUCATION\n", "VOLUNTEER EXPERIENCE\nVolunteer Web Developer, Code for Toronto    Jan 2024 – Present\n• Built a React site.\n\nEDUCATION\n"));
  assert.deepEqual([p.role, p.level, p.evidence.React.strength], ["Backend", "Senior", 1]);
});

test("experience headings named for a kind of work open the experience section", () => {
  for (const h of ["Software Development Experience", "Internship Experience", "Internships", "Co-op Experience"])
    assert.deepEqual(read(fixture("daniel-okafor").replace("PROFESSIONAL EXPERIENCE", h)), read(fixture("daniel-okafor")), h);
});

test("headings that end in a colon still end the experience section", () => {
  const text = ["Summary:", "Backend engineer.", "Experience:", "Senior Software Engineer    Jan 2020 - Present", "Tech stack:", "Go, Redis", "- Built Java and Kafka services.",
    "Software Engineer    Jan 2016 - Dec 2019", "- Wrote Python.", "Education:", "B.S. Computer Science, University of Waterloo    2012 - 2016", "Skills:", "AWS, Docker, Terraform, PostgreSQL"];
  const p = read(text.join("\n"));
  assert.deepEqual(p, read(text.map(l => l.replace(/^(\w+):$/, "$1")).join("\n")));
  assert.deepEqual([p.years, p.evidence.AWS.strength, p.evidence.Go.strength], [10.5, 1, 3]);
});

test("open-ended, day-level and other dash spellings of a date range", () => {
  for (const d of ["Mar 2021 - Till Date", "Mar 2021 – to date", "03/15/2021 - Present", "15/03/2021 - Present", "Mar 15, 2021 - Present", "15 Mar 2021 - Present", "Mar 2021 ‐ Present", "Mar 2021 ― Present"])
    assert.deepEqual(read(fixture("daniel-okafor").replace("Mar 2021 – Present", d)), read(fixture("daniel-okafor")), d);
});

test("a bare-year range inside one year still counts", () => {
  const text = ["EXPERIENCE", "Senior Software Engineer    2026 - Present", "- Built Java services.", "Software Engineer    2023 - 2023", "- Wrote Rust.", "Software Engineer    2018 - 2022", "- Wrote Python."];
  const p = parseResume(text.join("\n"), SKILLS, rules, new Date(2026, 2, 1));
  assert.deepEqual([p.level, p.evidence.Java.strength, p.evidence.Rust.strength], ["Senior", 3, 2]);
});

test("a job's first line of work counts when the employer is above the dates", () => {
  const p = read(["EXPERIENCE", "Senior Software Engineer    Mar 2021 – Present", "Built REST APIs in Java and Spring Boot on AWS", "Ran Kafka and PostgreSQL for settlement systems"].join("\n"));
  assert.ok(["Java", "Spring Boot", "AWS", "Kafka"].every(k => p.evidence[k]?.strength === 3), JSON.stringify(p.evidence));
  const stripped = read(fixture("cassandra-reyes").replace(/^- /gm, ""));
  assert.deepEqual(["Terraform", "Ansible", "Linux"].map(k => stripped.evidence[k].strength), [2, 2, 2]);
});

// ---- Degrees ----
test("a state code is not a degree, and joined abbreviations are", () => {
  const degree = text => read(`EDUCATION\n${text}`).degree;
  assert.equal(degree("B.S. Computer Science, Northeastern University, Boston, MA"), "Bachelor's");
  assert.equal(degree("BS, UMass, Amherst, MA, 2018"), "Bachelor's");
  assert.equal(degree("B.S. Computer Science, University of Mississippi, Oxford, MS"), "Bachelor's");
  assert.equal(degree("Worcester Polytechnic Institute, Worcester, MA 01609"), null);
  assert.equal(read("Jane Doe\nBoston, MA\nSKILLS\nJava").degree, null);
  assert.equal(degree("MSCS, Georgia Tech\nBS Computer Science, Purdue"), "Master's");
  for (const t of ["BSE Computer Science, Princeton", "BSCS, Lahore", "BSEE, Purdue"]) assert.equal(degree(t), "Bachelor's", t);
  for (const t of ["MSE, Johns Hopkins", "MS in Computer Science, Georgia Tech", "Georgia Tech, MS Computer Science", "MA, Economics"]) assert.equal(degree(t), "Master's", t);
});

test("professional, law and associate degrees", () => {
  const degree = text => read(`EDUCATION\n${text}`).degree;
  for (const t of ["J.D., Osgoode Hall Law School", "JD, Georgetown Law, 2014", "Juris Doctor, University of Michigan", "LL.B., McGill University",
    "Bachelor of Laws, University of Toronto", "M.D., Johns Hopkins University", "MD, University of Toronto", "Doctor of Medicine, McMaster University",
    "D.O., Kansas City University", "Doctor of Osteopathic Medicine, KCU", "PharmD, University of Florida", "Psy.D., Clinical Psychology, Rutgers",
    "DNP, Duke University", "Doctor of Nursing Practice, Duke", "DDS, NYU College of Dentistry", "DMD, Tufts"]) assert.equal(degree(t), "Professional", t);
  assert.equal(degree("JD, Georgetown Law\nPh.D., Economics, Yale"), "PhD");
  assert.equal(degree("JD, Georgetown Law\nMBA, Wharton"), "Professional");
  for (const t of ["LL.M., Taxation, NYU School of Law", "LLM in International Law, Columbia", "Master of Laws, Osgoode Hall"]) assert.equal(degree(t), "Master's", t);
  for (const t of ["Associate of Applied Science, Nursing", "Associate Degree in Accounting, Valencia College", "ADN, Miami Dade College"]) assert.equal(degree(t), "Associate", t);
  for (const t of ["BSN, University of Iowa", "MSN, Vanderbilt"]) assert.equal(degree(t), t.startsWith("B") ? "Bachelor's" : "Master's", t);
  assert.equal(degree("B.S. Biology, Johns Hopkins University, Baltimore, MD"), "Bachelor's", "a Maryland address is not a medical degree");
  assert.equal(degree("JD Edwards EnterpriseOne training"), null);
  assert.equal(degree("Skills: Python, LLM, RAG"), null, "a large language model is not a law degree");
  assert.equal(degree("J.D. Candidate, Harvard Law School\nB.A., Political Science, Tufts"), "Bachelor's");
});

test("a credential not yet held names no skill", () => {
  const skills = text => read(`EXPERIENCE\nStaff Accountant    2021 - Present\n- Closed the books.\nCERTIFICATIONS\n${text}`).skills;
  assert.ok(skills("Certified Public Accountant (CPA), Illinois, 2018").includes("CPA"));
  for (const t of ["CPA Candidate, passed FAR and AUD", "CFA Level II Candidate", "PMP (in progress)", "Project Management Professional, expected 2027"])
    assert.ok(!skills(t).some(k => ["CPA", "CFA", "PMP"].includes(k)), t);
  assert.ok(!read("EDUCATION\nJ.D. Candidate, Harvard Law School, 2027").skills.includes("Law Degree & Bar"));
});

test("bar admissions and licensure are their own sections", () => {
  const attorney = h => read(["EXPERIENCE", "Associate Attorney    2015 - Present", "- Drafted commercial contracts.", h, "Admitted to the bar in New York and New Jersey"].join("\n"));
  assert.equal(attorney("BAR ADMISSIONS").evidence["Law Degree & Bar"].strength, 1);
  assert.equal(attorney("Bar Admission").evidence["Law Degree & Bar"].strength, 1);
  const nurse = read(["EXPERIENCE", "Charge Nurse    2018 - Present", "- Ran a 30-bed surgical unit.", "LICENSURE", "Compact license, Texas Board of Nursing"].join("\n"));
  assert.equal(nurse.evidence["RN License"].strength, 1);
});

test("an Executive Summary heading opens the summary", () => {
  assert.equal(read("EXECUTIVE SUMMARY\nVP of Sales with 18 years building teams.\nSKILLS\nSalesforce").years, 18);
});

// ---- Rules ----
test("every exported rule compiles in JavaScript with no Python-only syntax", () => {
  assert.ok(rules.levels.length && rules.families.length && rules.backend.length && rules.frontend.length);
  const patterns = [...rules.levels, ...rules.families].map(([, rx]) => rx);
  const aliases = Object.values(keywords).flat().filter(a => a.startsWith("re:")).map(a => a.slice(3));
  for (const rx of [...patterns, ...aliases]) {
    assert.doesNotThrow(() => new RegExp(rx, "i"), rx);
    assert.doesNotMatch(rx, /\(\?[aiLmsux-]+[:)]|\(\?P[<=]/, rx);
  }
  assert.equal(SKILLS.length, Object.keys(keywords).length);
});

test("rules match without regard to case, as Python's re.I does", () => {
  const title = t => read(`EXPERIENCE\n${t}\n2021 - Present\n- Built Java services.\n`);
  assert.equal(title("STAFF SOFTWARE ENGINEER").level, "Staff+");
  assert.equal(title("Member of Technical Staff").level, null, "Member of Technical Staff is not Staff+");
  assert.equal(title("SITE RELIABILITY ENGINEER").role, "DevOps / SRE");
});

test("a jobs.js from before the rules were exported still reads resumes", () => {
  const p = parseResume(fixture("daniel-okafor"), SKILLS, { max_age_days: 30 }, NOW);
  assert.equal(p.years, 9);
  assert.equal(p.level, null);
  assert.equal(p.role, "General");
});

// The rules jobs.js held before roles, segments, fields and the ladder were exported.
const OLD_LEVELS = [["Staff+", "(?<!technical )\\bstaff\\b|\\b(principal|distinguished|architect|fellow)\\b"],
  ["Senior", "\\b(senior|sr\\.?|lead|iii|iv)\\b"], ["Junior", "\\b(junior|jr\\.?|entry|associate|i)\\b"]];
test("a jobs.js from before roles were exported reads every role as engineering, with the old levels", () => {
  const old = { levels: OLD_LEVELS, families: rules.families, backend: rules.backend, frontend: rules.frontend };
  const facts = name => { const p = parseResume(fixture(name), SKILLS, old, NOW); return [p.role, p.level]; };
  assert.deepEqual(facts("daniel-okafor"), ["Backend", "Senior"]);
  assert.deepEqual(facts("marta-lindqvist"), ["ML / AI", "Staff+"]);
});

// ---- PDF ----
test("pdfLines drops empty items and sorts each row by x", () => {
  assert.deepEqual(pdfLines([]), []);
  assert.deepEqual(pdfLines([item("World", 200, 700), item("Hello", 40, 700), { ...item(" ", 90, 700) }, { ...item("", 40, 700), hasEOL: true }, item("Next", 40, 680)]),
    ["Hello   World", "Next"]);
});

test("pdfLines joins split words without inventing spaces", () => {
  assert.deepEqual(pdfLines([item("Kuber", 40, 700), item("netes", 65, 700), item("and", 95, 700)]), ["Kubernetes and"]);
});

test("right-aligned dates stay on their row and aren't read as a column", () => {
  const rows = Array.from({ length: 8 }, (_, i) => [`Engineer ${i}`, `Mar 201${i} – Feb 201${i + 1}`]);
  const items = rows.flatMap(([title, dates], i) => [item(title, LEFT, TOP - i * LEAD), item(dates, 470, TOP - i * LEAD)]);
  assert.deepEqual(pdfLines(items), rows.map(([title, dates]) => `${title}   ${dates}`));
});

test("right-aligned locations and dates stay on their rows and aren't read as a column", () => {
  const rows = [0, 1, 2, 3].flatMap(i => [[`Company ${i}`, "Toronto, ON"], ["Software Engineer", `Mar 201${i} – Feb 201${i + 1}`],
    [`• Built Java services and Kafka streams for team ${i}`], ["• Ran PostgreSQL on AWS"]]);
  const items = rows.flatMap(([l, r], i) => [item(l, LEFT, TOP - i * LEAD), ...r ? [item(r, 555 - r.length * CHAR, TOP - i * LEAD)] : []]);
  assert.deepEqual(pdfLines(items), rows.map(r => r.join("   ")));
  const pasted = rows.map(([l, r]) => r ? l.padEnd(80 - r.length) + r : l).join("\n");
  assert.deepEqual(read(pasted), read(rows.map(r => r.join("   ")).join("\n")));
});

test("two columns read as one column at a time", () => {
  const left = Array.from({ length: 8 }, (_, i) => `left ${i}`), right = Array.from({ length: 8 }, (_, i) => `right ${i}`);
  assert.deepEqual(pdfLines(page(["Title across the top"], left, right, wholeLine)), ["Title across the top", ...left, ...right]);
});

for (const [name, pieces] of [["line items", wholeLine], ["word items", wordByWord]]) {
  test(`a two-column PDF of Cassandra's resume matches the clean parse (${name})`, () => {
    const lines = fixture("cassandra-reyes").split("\n");
    const top = lines.slice(0, 2).filter(Boolean), body = lines.slice(2);
    const left = body.map(l => l.slice(0, 57).trim()), right = body.map(l => l.slice(57).trim());
    const clean = read([...top, ...left.filter(Boolean), ...right.filter(Boolean)].join("\n"));
    assert.deepEqual(read(fixture("cassandra-reyes")), clean);
    const items = body.flatMap((_, i) => [
      ...(left[i] ? pieces(left[i], LEFT, TOP - (top.length + i) * LEAD) : []),
      ...(right[i] ? pieces(right[i], RIGHT, TOP - (top.length + i) * LEAD) : []),
    ]).concat(top.flatMap((l, i) => pieces(l, LEFT, TOP - i * LEAD))).reverse();
    assert.deepEqual(read(pdfLines(items).join("\n")), clean);
  });

  // Not yet nora-data: its sidebar is 7 of 29 rows, under gutter()'s quarter share, so it reads as one column.
  for (const want of PERSONAS.filter(p => p.file !== "cassandra-reyes" && p.file !== "nora-data")) {
    test(`${want.file} set in two columns matches the clean parse (${name})`, () => {
      const { top, left, right } = sidebarLayout(fixture(want.file));
      assert.deepEqual(read(pdfLines(page(top, left, right, pieces)).join("\n")), read(fixture(want.file)));
    });
  }
}

test("a one-column PDF matches the clean parse", () => {
  const text = fixture("elena-marsh");
  const lines = text.split("\n").filter(l => l.trim()).flatMap(l => wrap(l, 90));
  assert.deepEqual(read(pdfLines(page(lines, [], [], wholeLine)).join("\n")), read(text));
});

// ---- Privacy ----
test("STORED_KEYS is the whole of what may be stored", () => {
  assert.deepEqual([...STORED_KEYS].sort(), ["degree", "evidence", "level", "name", "role", "skills", "years"]);
});

for (const want of PERSONAS) test(`the ${want.file} profile holds only derived facts`, () => {
  const text = fixture(want.file), profile = { name: resumeLabel(`${want.file}.pdf`), ...read(text) }, json = JSON.stringify(profile);
  assert.deepEqual(Object.keys(profile).sort(), [...STORED_KEYS].sort());
  assert.doesNotMatch(json, want.secrets);
  const names = new Set(Object.keys(keywords));
  assert.ok(profile.skills.every(k => names.has(k)));
  assert.deepEqual(Object.keys(profile.evidence).sort(), [...profile.skills].sort());
  for (const e of Object.values(profile.evidence)) assert.deepEqual(Object.keys(e).sort(), ["recent", "strength", "years"]);
  for (const line of text.split("\n").filter(l => l.trim().split(/\s+/).length >= 3)) assert.ok(!json.includes(line.trim()), line);
});

const jobLines = ["• Built REST APIs in Java and Spring Boot.", "• Added Kafka streams for settlement."];
for (const [layout, text] of [
  ["above the dates", ["EXPERIENCE", "Sentry Harbor Bank, Toronto, ON", "Software Engineer II", "Jun 2019 – Feb 2021", ...jobLines]],
  ["on the date line", ["EXPERIENCE", "Software Engineer II — Sentry Harbor Bank    Jun 2019 – Feb 2021", ...jobLines]],
  ["under the date line", ["EXPERIENCE", "Software Engineer II    Jun 2019 – Feb 2021", "Sentry Harbor Bank, Toronto, ON", ...jobLines]],
  ["under the title and dates", ["EXPERIENCE", "Software Engineer II", "Jun 2019 – Feb 2021", "Sentry Harbor Bank, Toronto, ON", ...jobLines]],
  ["in a job with no dates", ["EXPERIENCE", "Software Engineer II — Sentry Harbor Bank", ...jobLines]],
]) test(`an employer named like a skill stays out when it sits ${layout}`, () => {
  const p = read(text.join("\n"));
  assert.ok(!p.skills.includes("Sentry"), p.skills.join());
  assert.ok(p.skills.includes("Kafka"), "the job's own skills still count");
});

test("a job's first line of work still counts when the employer is above the dates", () => {
  const p = read(["EXPERIENCE", "Senior Software Engineer    Mar 2021 – Present", "• Run a Kafka platform.", "• Wrote Terraform."].join("\n"));
  assert.equal(p.evidence.Kafka.strength, 3);
});

test("the person's name stays out of a resume with no headings", () => {
  const p = read(["CASSANDRA REYES", "Denver, CO | cassandra.reyes@example.com", "Site Reliability Engineer", "Northgate Streaming, Denver, CO",
    "Nov '22 - Present", "- Run Kubernetes clusters and Terraform.", "- Wrote Python tooling."].join("\n"));
  assert.ok(!p.skills.includes("Cassandra"), p.skills.join());
  assert.ok(p.skills.includes("Kubernetes"));
});

test("the person's name stays out of a one-line header", () => {
  const header = "CASSANDRA REYES | Site Reliability Engineer | Denver, CO | cassandra.reyes@example.com | 720-555-0175 | linkedin.com/in/creyes-example";
  assert.ok(header.split(/\s+/).length >= 12);
  const p = read([header, "SKILLS", "Kubernetes, Terraform"].join("\n"));
  assert.deepEqual(p.skills, ["Kubernetes", "Terraform"]);
});

test("skills listed before the first job still count in a resume with no headings", () => {
  const p = read(["Jane Doe", "jane@example.com", "I write software in these languages and tools.", "Java, Kafka, PostgreSQL", "Everything else is on request.",
    "Senior Software Engineer", "2021 - Present", "- Built services in Java."].join("\n"));
  assert.deepEqual(p.skills.filter(k => k !== "Java"), ["Kafka", "PostgreSQL"]);
  assert.equal(p.evidence.Kafka.strength, 1);
});

test("a bare pasted list of skills is not taken for a name", () => {
  assert.ok(["Java", "Kafka", "AWS"].every(k => read("Java Kafka AWS").skills.includes(k)));
  assert.ok(read("Java, Kafka\nAWS, Docker").skills.includes("Kafka"));
});

// ---- Labels and old profiles ----
test("resumeLabel never carries any of the file name", () => {
  assert.equal(resumeLabel("Jane_Doe_Resume.PDF"), "PDF resume");
  assert.equal(resumeLabel("Jane Doe.docx"), "Word resume");
  assert.equal(resumeLabel("jane-doe.txt"), "Text resume");
  assert.equal(resumeLabel("Pasted resume"), "Text resume");
  assert.equal(resumeLabel("Jane.Doe"), "Text resume");
});

test("an old profile keeps working and loses its file name", () => {
  assert.deepEqual(upgradeProfile({ name: "Jane_Doe_Resume.pdf", skills: ["Java", "Kafka"], years: 5 }),
    { name: "PDF resume", skills: ["Java", "Kafka"], years: 5, evidence: {}, role: null, level: null, degree: null });
  assert.equal(upgradeProfile(null), null);
});

test("a malformed saved profile reads as no profile", () => {
  for (const bad of ["abc", 5, [], {}, { skills: null }]) assert.equal(upgradeProfile(bad), null, JSON.stringify(bad));
  assert.deepEqual(upgradeProfile({ skills: [], evidence: null }).evidence, {});
  assert.deepEqual(upgradeProfile({ skills: ["Java", 7], years: "nine", level: 5, role: {}, degree: [] }),
    { name: "Text resume", skills: ["Java"], years: null, evidence: {}, role: null, level: null, degree: null });
});

test("upgrading is stable across page loads", () => {
  for (const file of ["cv.pdf", "cv.docx", "cv.txt", "Pasted resume"]) {
    const once = upgradeProfile({ name: file, skills: [], years: null });
    assert.deepEqual(upgradeProfile(once), once);
  }
});

test("a current profile survives upgrading, and unknown keys don't", () => {
  const facts = read(fixture("priya-raman")), stored = { name: "PDF resume", ...facts };
  assert.deepEqual(upgradeProfile(stored), stored);
  const upgraded = upgradeProfile({ ...stored, text: "the whole resume", email: "jane@example.com" });
  assert.deepEqual(Object.keys(upgraded).sort(), [...STORED_KEYS].sort());
});

// ---- Loading ----
test("loads as a classic script and leaks nothing into global scope", () => {
  const code = fs.readFileSync(source, "utf8"), context = vm.createContext({ window: {} });
  vm.runInContext(code, context);
  assert.deepEqual(Object.keys(context), ["window"]);
  assert.deepEqual(Object.keys(context.window), ["wresume"]);
  assert.deepEqual(Object.keys(context.window.wresume).sort(), ["STORED_KEYS", "parseResume", "pdfLines", "resumeLabel", "upgradeProfile"]);
  const declared = [...code.matchAll(/^\s*(?:const|let|function)\s+(\w+)/gm)].map(m => m[1]);
  assert.ok(declared.length > 20);
  for (const name of declared) assert.equal(vm.runInContext(`typeof ${name}`, context), "undefined", name);
});
