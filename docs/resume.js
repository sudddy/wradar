"use strict";
// wradar resume reader. Turns resume text into derived facts; the text, the name and employers are never returned.
// An IIFE because this loads as a classic script beside app.js and match.js.
(() => {

const STORED_KEYS = ["name", "skills", "years", "evidence", "role", "level", "degree"];

// ---- Lines ----
const toLines = text => text.replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/\t/g, "    ").split("\n").filter(l => l.trim());

const joinRow = parts => parts.reduce((s, p, i) => {
  if (!i) return p.str;
  const gap = p.x - (parts[i - 1].x + parts[i - 1].w);
  return s + (gap > 2 * p.h ? "   " : gap > 0.15 * p.h && !s.endsWith(" ") ? " " : "") + p.str;
}, "");

// An x that few pieces cross, with a real share of rows on its right. Right-aligned dates fail the share test.
// A column shares a left edge; locations and dates set against the right margin share a right edge instead.
function gutter(rows, parts) {
  const lo = Math.min(...parts.map(p => p.x)), hi = Math.max(...parts.map(p => p.x + p.w));
  const crossing = x => parts.filter(p => p.x < x && p.x + p.w > x).length;
  let best = null;
  for (let f = 0.15; f <= 0.85; f += 0.01) {
    const x = lo + f * (hi - lo), n = crossing(x);
    if (!best || n < best.n) best = { n, from: x, to: x };
    else if (n === best.n && x - best.to < 0.02 * (hi - lo)) best.to = x;
  }
  const x = (best.from + best.to) / 2;
  const left = rows.filter(r => r.parts.some(p => p.x < x)), right = rows.filter(r => r.parts.some(p => p.x >= x));
  const mostlyDates = side => side.filter(r => r.parts.some(p => RANGES.some(([rx]) => rx.test(p.str)))).length * 2 > side.length;
  const edges = right.map(r => { const ps = r.parts.filter(p => p.x >= x), last = ps[ps.length - 1]; return [ps[0].x, last.x + last.w]; });
  const shared = i => Math.max(...edges.map(e => edges.filter(f => Math.abs(f[i] - e[i]) < 1).length));
  return best.n <= 0.1 * rows.length && left.length >= 6 && right.length >= 6 && right.length >= 0.25 * rows.length
    && !mostlyDates(left) && !mostlyDates(right) && shared(0) >= shared(1) ? x : null;
}

// PDF.js items to reading-order lines. Rows come from y, so hasEOL adds nothing; empty items are dropped.
function pdfLines(items) {
  const parts = items.filter(t => t.str.trim()).map(t => ({ str: t.str, x: t.transform[4], y: t.transform[5], w: t.width, h: Math.abs(t.transform[3]) || t.height || 10 }));
  if (!parts.length) return [];
  const rows = [];
  for (const p of [...parts].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && row.y - p.y < 0.5 * Math.min(row.h, p.h)) row.parts.push(p);
    else rows.push({ y: p.y, h: p.h, parts: [p] });
  }
  rows.forEach(r => r.parts.sort((a, b) => a.x - b.x));
  const cut = gutter(rows, parts), out = [];
  let left = [], right = [];
  const flush = () => { out.push(...left, ...right); left = []; right = []; };
  for (const r of rows) {
    if (cut == null || r.parts.some(p => p.x < cut && p.x + p.w > cut)) { flush(); out.push(joinRow(r.parts)); continue; }
    const l = r.parts.filter(p => p.x < cut), rr = r.parts.filter(p => p.x >= cut);
    if (l.length) left.push(joinRow(l));
    if (rr.length) right.push(joinRow(rr));
  }
  flush();
  return out;
}

// Plain text that kept its columns (pdftotext -layout, some pastes): each run of words is an item at its character position.
function splitColumns(lines) {
  if (!lines.some(l => /\S {3,}\S/.test(l))) return lines;
  return pdfLines(lines.flatMap((l, y) => [...l.matchAll(/\S+(?: {1,2}\S+)*/g)]
    .map(m => ({ str: m[0], transform: [1, 0, 0, 1, m.index, -y], width: m[0].length, height: 1 }))));
}

// ---- Sections ----
const SECTION_WORDS = {
  summary: "summary profile about objective overview highlights statement introduction bio snapshot",
  skills: "skills skill competencies competency technologies technology stack tools toolbox toolkit expertise proficiencies frameworks",
  experience: "experience experiences employment history background positions internship internships",
  projects: "projects project portfolio source",
  education: "education academics academic degrees qualifications",
  certifications: "certifications certification certificates certificate licenses licences credentials courses coursework training",
  other: "volunteer volunteering interests hobbies references awards honors honours publications patents activities achievements accomplishments memberships affiliations languages talks speaking community leadership teaching extracurricular",
};
const SECTION_OF = Object.fromEntries(Object.entries(SECTION_WORDS).flatMap(([s, w]) => w.split(" ").map(x => [x, s])));
const FILLER = new Set("a and the of my in for me areas area work career professional relevant selected technical tech core key additional other personal recent previous prior related industry software engineering notable side open research programming earlier".split(" "));
const BULLET = /^\s*[-*•·▪◦‣●■□○–—>]\s+/;

// colons: whether a line ending in a colon can be a heading here.
function heading(line, colons) {
  if (BULLET.test(line) || line.length > 45 || /\d/.test(line) || !colons && /:\s*$/.test(line)) return null;
  const flat = /^(?:\S\s+){3,}\S$/.test(line.trim()) ? line.trim().replace(/\s{2,}/g, "|").replace(/\s/g, "").replace(/\|/g, " ") : line;
  const words = flat.toLowerCase().replace(/&/g, " and ").replace(/[^a-z ]/g, " ").trim().split(/\s+/);
  if (!words[0] || words.length > 6) return null;
  const named = SECTION_OF[words[words.length - 1]] === "experience" && !/[.,]/.test(line);  // "Software Development Experience"
  let section = null;
  for (const w of words) {
    if (SECTION_OF[w]) section ||= SECTION_OF[w];
    else if (!FILLER.has(w) && !named) return null;
  }
  return section || (words.some(w => w === "career" || w === "work") ? "experience" : null);
}

// A heading inside Experience is part of a job ("Key Achievements") when the job's own lines follow it and then another
// job title, before the next heading. A section such as "Volunteer Experience" opens straight onto a job.
const SUB = new Set(["summary", "skills", "projects", "other"]);
function inJob(lines, i, colons, today, fam) {
  const next = lines.findIndex((l, k) => k > i && heading(l, colons));
  const { blocks, rest } = jobBlocks(lines.slice(i + 1, next < 0 ? lines.length : next), today, fam);
  return rest.length > 0 && blocks.some(b => b.title);
}

function sections(lines, today, fam) {
  const out = { head: [], summary: [], skills: [], experience: [], projects: [], education: [], certifications: [], other: [] };
  let at = "head", colons = false;  // colons: the section's own heading ended in one, so this resume writes headings that way
  lines.forEach((line, i) => {
    const h = heading(line, colons || at !== "experience" && at !== "projects");  // otherwise "Tech stack:" inside a job
    if (h && !(at === "experience" && SUB.has(h) && inJob(lines, i, colons, today, fam))) { at = h; colons = /:\s*$/.test(line); }
    else out[at].push(line);
  });
  return out;
}

// ---- Dates (months since year 0) ----
const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, spr: 3, sum: 6, fal: 9, aut: 9, win: 12 };
const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter)\\.?";
const WHEN = `\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|(?:\\d{1,2}\\s+)?${MON}(?:\\s+\\d{1,2}(?:,\\s*|\\s+)(?=\\d{4}))?\\s*,?\\s*['’]?\\d{2,4}`
  + `|\\d{1,2}[/.-]\\d{4}|\\d{4}[/.-]\\d{1,2}(?!\\d)|\\d{1,2}/\\d{2}(?!\\d)|(?:19|20)\\d{2}`;
const OPEN = "present|current|now|today|ongoing|date|(?:till|to)\\s+(?:date|now|present|today)";
const DASH = "-\\u2010-\\u2015";  // hyphen, non-breaking hyphen, figure dash, en and em dash, horizontal bar
const RANGES = [
  [new RegExp(`(?<![\\w/.-])(${WHEN})\\s*(?:[${DASH}−~]+|\\bto\\b|\\buntil\\b|\\bthrough\\b|\\btill\\b)\\s*(${WHEN}|${OPEN})(?![\\w/])`, "i"), m => [m[1], m[2]]],
  [new RegExp(`\\b(${MON})\\s*[${DASH}]\\s*(${MON})\\s*,?\\s*['’]?(\\d{2,4})`, "i"), m => [`${m[1]} ${m[3]}`, `${m[2]} ${m[3]}`]],
  [new RegExp(`\\bsince\\s+(${WHEN})|(?<![\\w/.-])(${WHEN})\\s*[${DASH}]\\s*$`, "i"), m => [m[1] || m[2], "present"]],
];
const SEASON_YEAR = /\b(?:spring|summer|fall|autumn|winter)\s+['’]?\d{2,4}\b/gi;
const fullYear = y => y.length === 2 ? (+y > 50 ? 1900 : 2000) + +y : +y;

function point(s, isEnd, today) {
  s = s.toLowerCase().trim()  // a day is dropped: 03/15/2021 or 15/03/2021, 15 mar 2021, mar 15, 2021
    .replace(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/, (_, a, b, y) => `${+a > 12 ? b : a}/${y}`)
    .replace(/^\d{1,2}\s+(?=[a-z])|(?<=[a-z.])\s+\d{1,2}(?:,\s*|\s+)(?=\d{4}$)/, " ").trim();
  if (new RegExp(`^(?:${OPEN})$`).test(s)) return today;
  let m;
  if ((m = s.match(/^([a-z]+)\.?\s*,?\s*['’]?(\d{2,4})$/))) return fullYear(m[2]) * 12 + MONTH[m[1].slice(0, 3)] - 1;
  if ((m = s.match(/^(\d{4})[/.-](\d{1,2})$/))) return +m[2] > 12 ? null : +m[1] * 12 + +m[2] - 1;
  if ((m = s.match(/^(\d{1,2})[/.-](\d{2,4})$/))) return +m[1] > 12 ? null : fullYear(m[2]) * 12 + +m[1] - 1;
  return +s * 12 + (isEnd ? 5 : 6);  // a bare year means mid-year, so 2018 - 2021 is 3 years
}

function dateRange(line, today) {
  if (BULLET.test(line)) return null;
  for (const [rx, pick] of RANGES) {
    const m = line.match(rx);
    if (!m) continue;
    if (line.length > 90 && m.index > 3 && m.index + m[0].length < line.length - 3) continue;  // a date inside a sentence
    const [a, b] = pick(m), end = Math.min(point(b, true, today) ?? -1, today);
    let start = point(a, false, today);
    if (/^\d{4}$/.test(a) && end >= +a * 12) start = Math.min(start, end);  // "2023 - 2023", or "2026 - Present" before July 2026
    if (start != null && end >= start) return { start, end };
  }
  return null;
}

const undated = l => RANGES.reduce((s, [rx]) => s.replace(rx, " "), l).replace(SEASON_YEAR, " ");

function merged(spans) {
  let total = 0, until = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b + 1 > until) { total += b + 1 - Math.max(a, until); until = b + 1; }
  }
  return total;
}
const half = months => Math.floor(months / 6) / 2;  // rounds down: postings ask for "N+ years"

// ---- Experience entries ----
const TECH_TITLE = /\b(?:engineer|developer|programmer|swe|sde|sre|devops|architect|scientist|technical staff|tech lead|technical lead|engineering (?:manager|lead|director)|(?:director|head|vp) of engineering|cto)\b|\b(?:software|web|data|engineering|development|machine learning|ml|ai)\b[\w\s/-]*\bintern(?:ship)?\b/i;
const NOT_TECH = /\b(?:mechanical|civil|electrical|chemical|structural|industrial|process|manufacturing|sales|field|biomedical|environmental|aerospace|stationary|sound|audio)\b/i;
const SOFT = /^(?:Agile|Mentoring|Cross-functional|Technical Leadership|Code Review|Jira|Payments|Fintech|Banking|Billing|SaaS|B2B|Fraud \/ Risk|On-call|Ledgers|KYC \/ AML)$/;

const headerLike = l => {
  if (BULLET.test(l) || l.length > 75 || l.includes(":") || /(?<!\b(?:Inc|Ltd|Corp|Co|LLC))[.;]$/.test(l.trim())) return false;
  const words = l.trim().split(/\s+/).filter(w => /[A-Za-z]/.test(w));
  return words.filter(w => /[A-Z]/.test(w)).length * 2 > words.length;  // iOS and .NET count as capitalised
};

function findTitle(s, fam) {
  for (const part of s.split(/\s*[|•·@]\s*|\s+[-–—]\s+|\s{2,}|\s+at\s+/)) {
    const bits = part.split(/,\s+/), i = bits.findIndex(b => TECH_TITLE.test(b) && !NOT_TECH.test(b));
    if (i < 0) continue;
    const tail = bits[i + 1];  // "Software Engineer, Backend"; a one or two word tail that names a family belongs to the title
    return bits[i].trim() + (tail && tail.split(/\s+/).length <= 2 && fam.some(([, rx]) => rx.test(tail)) ? `, ${tail.trim()}` : "");
  }
  return null;
}

function jobBlocks(lines, today, fam) {
  const hits = [];
  lines.forEach((l, i) => { const span = dateRange(l, today); if (span) hits.push({ i, ...span }); });
  const heads = hits.map((h, k) => {
    const floor = k ? hits[k - 1].i : -1, next = k + 1 < hits.length ? hits[k + 1].i : lines.length;
    let top = h.i, bottom = h.i, title = findTitle(undated(lines[h.i]), fam);
    const onDates = !!title;
    while (top - 1 > floor && h.i - top < 2 && headerLike(lines[top - 1])) { top--; title ||= findTitle(lines[top], fam); }
    while (!title && bottom + 1 < next && bottom - h.i < 2 && headerLike(lines[bottom + 1])) { bottom++; title = findTitle(lines[bottom], fam); }
    // The employer, which may share a name with a skill, sits below when no header line besides the title's sits above.
    // A long line there is the first line of work.
    const employer = bottom - top > (onDates ? 0 : 1), below = lines[bottom + 1];
    if (title && !employer && bottom + 1 < next && headerLike(below) && below.split(/\s+/).length <= 6) bottom++;
    return { ...h, top, bottom, title };
  });
  const blocks = heads.map((h, k) => ({ kind: "job", start: h.start, end: h.end, title: h.title,
    body: lines.slice(h.bottom + 1, k + 1 < heads.length ? heads[k + 1].top : lines.length) }));
  return { blocks, rest: heads.length ? lines.slice(0, heads[0].top) : lines };
}

function projectBlocks(lines, today) {
  const hits = lines.flatMap((l, i) => { const s = dateRange(l, today); return s ? [{ i, ...s }] : []; });
  if (!hits.length) return lines.length ? [{ kind: "project", start: null, end: null, title: null, body: lines }] : [];
  return hits.map((h, k) => ({ kind: "project", start: h.start, end: h.end, title: null,
    body: lines.slice(k ? hits[k].i : 0, k + 1 < hits.length ? hits[k + 1].i : lines.length) }));
}

// ---- Facts ----
const scanText = lines => lines.map(l => undated(l).replace(BULLET, "").replace(/\s*[|•·;:]\s*/g, ", ")).join(" ");
const foundIn = (lines, skills) => { const t = scanText(lines); return skills.filter(([, rxs]) => rxs.some(r => r.test(t))).map(([n]) => n); };
const statedYears = t => { const m = t.match(/(\d{1,2})\s*\+?\s*years?(?:\s+of)?(?:\s+[\w\/&-]+){0,5}?\s+experience/i); return m ? +m[1] : null; };
const CONTACT = /@|https?:|www\.|\.com\b/i;
// With no headings the lines before the first job still hold the name and contact details, and a name can read as a skill.
const notContact = (l, i, all) => all.length === 1 || !CONTACT.test(l) && (i > 0 || l.split(/\s+/).length > 4 || /[\d,:]/.test(l));

function evidence(blocks, listed, today) {
  const newest = Math.max(...blocks.filter(b => b.tech && b.end != null).map(b => b.end));
  const seen = {};
  const at = k => seen[k] ||= { strength: 1, spans: [], last: null };
  for (const b of blocks) for (const k of b.found) {
    const e = at(k), dated = b.end != null, job = b.kind === "job";
    e.strength = Math.max(e.strength, job && b.tech && dated && b.end >= newest - 3 ? 3 : 2);
    if (job && dated) e.spans.push([b.start, b.end]);
    if (dated) e.last = Math.max(e.last ?? -1, b.end);
  }
  listed.forEach(at);
  return Object.fromEntries(Object.entries(seen).map(([k, e]) => [k, { strength: e.strength, years: half(merged(e.spans)), recent: e.last == null ? null : today - e.last }]));
}

const DEGREES = [
  ["PhD", /\bph\.? ?d\b|\bd\.? ?phil\b|\bdoctorate\b|\bdoctor of\b/i, /$^/],
  ["Master's", /\bmaster(?:\s+of|\s+in|\s+degree|['’]s|s\b)/i, /\b(?:M\.?S(?:c|CS|EE?)?|M\.S|M\.?Eng|M\.?Tech|M\.?B\.?A|M\.?C\.?A|M\.?C\.?S|M\.?Ed|M\.A)\b(?!\s+(?:Office|Excel|Word|Project|SQL|Access|Azure|Teams)\b)|\bMA\b(?=\s+(?:in|of)\b|\s*[,(]|\s*$)/],
  ["Bachelor's", /\bbachelor(?:\s+of|\s+in|\s+degree|['’]s|s\b)/i, /\b(?:B\.?S(?:c|CS|EE?)?|B\.?Eng|B\.?Tech|B\.?B\.?A|B\.?C\.?A|B\.?C\.?S|B\.?Com|B\.A|B\.E)\b|\b(?:BA|BE)\b(?=\s+(?:in|of)\b|\s*[,(]|\s*$)/],
  ["Associate", /\bassociate(?:['’]?s)?\s+(?:of|in|degree)\b/i, /\b(?:A\.A\.S|A\.S|A\.A|AAS)\b/],
];
const NOT_HELD = /\b(?:expected|anticipated|in progress|candidate|pursuing|ongoing|incomplete|abd|not completed)\b/i;
const STATE = /,\s*M[AS](?=\s*,?\s*(?:\d|[|(]|$))/g;  // the place that ends "Boston, MA" or "Oxford, MS 38655, 2018"

function degreeOf(lines) {
  lines = lines.map(l => l.replace(STATE, ""));
  const held = lines.filter((l, i) => !NOT_HELD.test(l) && !NOT_HELD.test(lines[i + 1] || ""));
  return DEGREES.find(([, word, abbr]) => held.some(l => word.test(l) || abbr.test(l)))?.[0] ?? null;
}

function familyOf(title, found, fam, rules) {
  const hit = fam.find(([, rx]) => rx.test(title));
  if (hit) return hit[0];
  const count = set => found.filter(k => set.includes(k)).length;
  const be = count(rules.backend) >= 2, fe = count(rules.frontend) >= 2;
  return be && fe ? "Full stack" : be ? "Backend" : fe ? "Frontend" : "General";
}

// A title with no level word leaves level null; levelOf in match.js fills it from years, so edits to years and old profiles both work.
function levelFromTitle(title, rules) {
  return rules.levels.find(([, rx]) => new RegExp(rx, "i").test(title))?.[0] ?? null;
}

function parseResume(text, skills, rules, now = new Date()) {
  rules = { levels: [], families: [], backend: [], frontend: [], ...rules };  // a jobs.js from before these were exported has none
  const today = now.getFullYear() * 12 + now.getMonth();
  const fam = rules.families.map(([n, rx]) => [n, new RegExp(rx, "i")]);  // Python reads these with re.I
  const lines = splitColumns(toLines(text)).map(l => l.trim()).filter(Boolean);
  const sec = sections(lines, today, fam);
  const headed = sec.head.length < lines.length;
  const intro = sec.head.filter(l => l.split(/\s+/).length >= 12 && !CONTACT.test(l));

  const expLines = headed ? sec.experience : sec.head;
  let { blocks: jobs, rest } = jobBlocks(expLines, today, fam);
  if (headed && !jobs.length && expLines.length) { jobs = [{ kind: "job", start: null, end: null, title: null, body: expLines.filter(l => !headerLike(l)) }]; rest = []; }
  jobs.forEach(b => {
    b.found = foundIn([b.title || "", ...b.body], skills);
    b.tech = !!b.title || b.found.filter(k => !SOFT.test(k)).length >= 3;
  });
  const projects = projectBlocks(sec.projects, today);
  projects.forEach(b => { b.found = foundIn(b.body, skills); });

  const listed = foundIn([...intro, ...sec.summary, ...sec.skills, ...sec.education, ...sec.certifications, ...sec.other, ...rest.filter(notContact)], skills);
  const ev = evidence([...jobs, ...projects], listed, today);
  const names = skills.map(([n]) => n).filter(k => ev[k]);

  const worked = jobs.filter(b => b.tech && b.end != null);
  const months = merged(worked.map(b => [b.start, b.end]));
  const stated = statedYears(scanText(headed ? [...intro, ...sec.summary] : lines));
  const leftOut = jobs.some(b => !b.tech && b.end != null);  // stated years may count work outside tech
  const years = !months ? stated : leftOut ? half(months) : Math.max(half(months), stated ?? 0);

  const cur = [...worked].sort((a, b) => b.end - a.end || b.start - a.start)[0];
  const title = cur?.title || [...sec.head.slice(0, 6), ...expLines.slice(0, 4)].map(l => findTitle(l, fam)).find(Boolean) || null;
  return {
    skills: names, years, evidence: ev,
    role: title || cur ? familyOf(title || "", cur?.found || names, fam, rules) : null,
    level: title ? levelFromTitle(title, rules) : null,
    degree: degreeOf(sec.education.length ? sec.education : lines),
  };
}

const LABELS =["PDF resume", "Word resume", "Text resume"];
const resumeLabel = file => /\.pdf$/i.test(file) ? LABELS[0] : /\.docx?$/i.test(file) ? LABELS[1] : LABELS[2];  // file names often hold the person's name

// A stored value that isn't a profile reads as none, so the page still loads and offers to read a resume again.
const text = v => (typeof v === "string" ? v : null);
const upgradeProfile = p => p && Array.isArray(p.skills) ? {
  ...Object.fromEntries(STORED_KEYS.filter(k => k in p).map(k => [k, p[k]])),
  skills: p.skills.filter(k => typeof k === "string"),
  years: Number.isFinite(p.years) ? p.years : null,  // a value of the wrong type would stop scoring for every job
  role: text(p.role), level: text(p.level), degree: text(p.degree),
  evidence: p.evidence && typeof p.evidence === "object" ? p.evidence : {},
  name: LABELS.includes(p.name) ? p.name : resumeLabel(p.name),
} : null;

const wresume = { parseResume, pdfLines, upgradeProfile, resumeLabel, STORED_KEYS };
if (typeof window !== "undefined") window.wresume = wresume;
if (typeof module !== "undefined") module.exports = wresume;
})();
