"use strict";
// Synthetic jobs and profiles shared by match.test.js and match-fields.test.js.
const { score, buildStats } = require("../docs/match.js");

const MUST = ["Java", "Kafka", "AWS", "PostgreSQL", "Kubernetes"];
const job = ({ must = MUST, nice = [], ...over } = {}) => ({ title: "Senior Backend Engineer", role: "Backend", level: "Senior",
  must, nice, skills: [...must, ...nice], years_required: 5, degree: null, ...over });
const on = (p, j, others = []) => score(p, j, buildStats([j, ...others]));
const part = (r, name) => r.parts.find(x => x.name === name);
const lines = r => [...r.fits, ...r.gaps, ...r.next, ...r.parts.map(x => x.note), ...(r.held ? [r.held.why] : [])];

const ev = (strength, recent) => ({ strength, years: 3, recent });
const old = { name: "resume.txt", skills: MUST, years: 8 };
const full = { ...old, name: "PDF resume", role: "Backend", level: "Senior", degree: "Bachelor's",
  evidence: Object.fromEntries(MUST.map(k => [k, ev(3, 0)])) };
// The fields synthetic jobs use, named as jobs.js rules.fields names them.
const ENG = ["Backend", "Frontend", "Full stack", "Mobile", "Security", "ML / AI", "Data", "DevOps / SRE", "QA / Test", "Embedded", "General", "Hardware"];
const RULES = { fields: { ...Object.fromEntries(ENG.map(f => [f, "Engineering"])), Sales: "Sales", "Solutions & presales": "Sales",
  "Customer success": "Customer", Marketing: "Marketing", Accounting: "Finance", Finance: "Finance", Recruiting: "People", Clinical: "Healthcare",
  Cybersecurity: "IT & security", "Revenue operations": "Operations", Analytics: "Data & research", Other: "Other", "FP&A": "Finance", HR: "People", SDR: "Sales", SEO: "Marketing" } };
const onAll = (p, j, others = []) => score(p, j, buildStats([j, ...others], RULES));
const person = (role, level, years, skills, over = {}) => ({ name: "PDF resume", role, level, years, degree: "Bachelor's", skills,
  evidence: Object.fromEntries(skills.map(k => [k, ev(3, 0)])), ...over });

module.exports = { MUST, job, on, part, lines, ev, old, full, onAll, person };
