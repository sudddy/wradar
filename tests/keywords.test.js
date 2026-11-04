"use strict";
// One alias or rule that JavaScript rejects stops docs/app.js at load and blanks the page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(read("docs/jobs.js"), sandbox);
const D = sandbox.window.JOB_DATA;

// The same construction as SKILLS in docs/app.js.
const rxEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compile = a => (a.startsWith("re:")
  ? new RegExp(a.slice(3))
  : new RegExp("(?<![A-Za-z0-9])" + rxEscape(a.replace(/^=/, "")) + "(?![A-Za-z0-9+#])", a.startsWith("=") ? "" : "i"));
const aliases = kw => Object.entries(kw).filter(([k]) => !k.startsWith("_")).flatMap(([, a]) => a);
const kw = JSON.parse(read("keywords.json"));
const found = s => Object.entries(kw).filter(([k, a]) => !k.startsWith("_") && a.some(x => compile(x).test(s))).map(([k]) => k).sort();
const expect = cases => { for (const [s, want] of cases) assert.deepEqual(found(s), want, s); };

test("a Python-only regex is caught", () => {
  assert.throws(() => compile("re:(?P<go>Go)"), SyntaxError);
  assert.throws(() => new RegExp("(?P<go>Go)", "i"), SyntaxError);
});

for (const [from, words] of [["keywords.json", kw], ["docs/jobs.js", D.keywords]]) {
  test(`every alias in ${from} compiles`, () => {
    const all = aliases(words);
    assert.ok(all.length > 100, `only ${all.length} aliases`);
    for (const a of all) assert.doesNotThrow(() => compile(a), a);
  });
}

test("no alias belongs to two skills", () => {
  const owner = new Map();
  for (const [k, a] of Object.entries(kw).filter(([k]) => !k.startsWith("_"))) for (const x of a) {
    const key = /^(?:=|re:)/.test(x) ? x : x.toLowerCase();
    assert.ok(!owner.has(key) || owner.get(key) === k, `${x} is in ${owner.get(key)} and ${k}`);
    owner.set(key, k);
  }
});

test("mobile skills are read as whole words, without the common false hits", () => {
  assert.deepEqual(found("Ship native iOS apps in Swift, SwiftUI and UIKit, with some Objective-C/C++."), ["C++", "Objective-C", "Swift", "SwiftUI", "UIKit", "iOS"]);
  assert.deepEqual(found("Android apps in Kotlin and Jetpack Compose."), ["Android", "Jetpack Compose", "Kotlin"]);
  assert.deepEqual(found("Flash the BIOS, wire the sensor IOs and compose a summary."), []);
});

test("office tools are not read from plain words", () => expect([
  ["Excel at turning chaos into process, excel in ambiguity, put your Word into action, with Access to a learning stipend.", []],
  ["Partner with Sales and Support teams. Interviews happen over Microsoft Teams or Zoom.", []],
  ["Advanced Excel (pivot tables, VLOOKUP) and Microsoft Office: Word, Access and PowerPoint.", ["Excel", "Microsoft Office", "PowerPoint"]],
  ["Microsoft 365 (Teams, Outlook, SharePoint).", ["Microsoft Office"]],
]));

test("a tool named like a common word counts only as the tool", () => expect([
  ["Lead community outreach to local schools; Outreach Days run each spring.", []],
  ["Experience with Salesforce, Outreach, or Gong.", ["Gong", "Outreach", "Salesforce"]],
  ["A typical workday starts at 9. Budgets live in Workday Adaptive Planning.", ["Adaptive Planning"]],
  ["Run payroll in Workday or ADP.", ["ADP", "Payroll", "Workday"]],
  ["Lever Ownership is our value: find the lever, and cut Greenhouse Gas and greenhouse gas emissions.", []],
  ["Hands-on with an ATS such as Greenhouse, Lever, or Ashby.", ["Applicant Tracking Systems", "Greenhouse", "Lever"]],
  ["We reject the notion that great work needs long hours.", []],
  ["Keep plans in Notion, Asana or Confluence.", ["Work Management Tools"]],
  ["Sketch out a plan and sketch ideas on a whiteboard.", []],
  ["Prototype in Figma, Sketch or Adobe XD.", ["Figma", "Sketch / Adobe XD"]],
  ["A 50,000 square foot site near Times Square, with Square footage to spare.", []],
  ["Experience with Square or Toast POS.", ["Point of Sale"]],
  ["Starting Monday, we work Monday to Friday.", []],
  ["Track tasks in monday.com or Asana.", ["Work Management Tools"]],
  ["Enter your zip code. Zip codes and ZIP code fields are required.", []],
  ["Route intake requests through Coupa or Zip.", ["Coupa", "Zip"]],
  ["Run Spark jobs on AWS EMR and automate certificate renewal.", ["AWS", "Spark"]],
  ["Chart in the EMR/EHR and own customer renewals.", ["EHR Systems", "Renewals & Retention"]],
]));

test("R, spoken languages, supply chain and privacy skip their look-alikes", () => expect([
  ["Fund R&D, migrate SAP R/3 and resell Acme(R) parts.", ["SAP"]],
  ["Query data in Python, R, or SQL.", ["Python", "R", "SQL"]],
  ["Reconcile A/R and A/P, and partner with R & D teams on the R and D budget.", ["Accounts Payable", "Accounts Receivable"]],
  ["Model it in Python/R.", ["Python", "R"]],
  ["Sell to Japanese enterprises and German automakers from our French office.", []],
  ["Fluent in Spanish and bilingual English/French.", ["French", "Spanish"]],
  ["Harden our software supply chain and supply chain security.", []],
  ["Run supply chain operations for the region.", ["Supply Chain Management"]],
  ["Read our Data Privacy Notice before you apply.", []],
  ["Advise product teams on data privacy and GDPR.", ["Privacy Law"]],
]));

test("a skill's own phrase does not also tag an unrelated skill", () => expect([
  ["Tune our security information and event management (SIEM) rules.", ["Security Operations (SIEM / EDR)"]],
  ["Own enterprise performance management (EPM) and application performance management (APM) tools.", ["EPM Tools"]],
  ["Handle benefits renewals and office lease renewals.", ["Benefits Administration"]],
  ["Build learning experience design for new hires.", ["Instructional Design"]],
  ["Run event management for our summit.", ["Event Planning"]],
  ["Coach managers on performance management.", ["Performance Management"]],
  ["Own customer renewals and experience design.", ["Renewals & Retention", "UX Design"]],
]));

test("an acronym counts only in the sense its skill means", () => expect([
  ["Write firmware for DSPs and MCUs, and keep the System Security Plan (SSP) current.", []],
  ["Buy media through demand-side platforms.", ["Programmatic Advertising"]],
  ["Partner with the Technical Account Manager (TAM).", []],
  ["Size the TAM/SAM/SOM for a new market.", ["Market Research"]],
  ["F-1 students on CPT/OPT or Curricular Practical Training (CPT) are welcome.", []],
  ["Code claims with CPT and ICD-10.", ["Medical Coding & Billing"]],
  ["Built services with Spring Boot and Spring AOP.", ["Spring Boot"]],
  ["Own the AOP.", ["FP&A"]],
  ["Commuter benefits cover the MTA.", []],
]));

for (const name of ["levels", "families"]) {
  test(`every rules.${name} pattern compiles`, () => {
    const rules = D.rules[name];
    assert.ok(rules.length > 2, `only ${rules.length} rules`);
    for (const [label, rx] of rules) assert.doesNotThrow(() => new RegExp(rx, "i"), label);
  });
}
