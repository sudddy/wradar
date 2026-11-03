"use strict";
// wradar match. Reads a posting in the order a recruiter does: title, seniority, years, top must-haves, the rest.
// buildStats(jobs) runs once; score(profile, job, stats) is pure apart from caches inside stats.
// An IIFE because this loads as a classic script beside app.js, which declares esc, list, plural, LEVELS and score too.
(() => {

const LEVELS = ["Junior", "Mid", "Senior", "Staff+"];
const MAX = { Role: 20, Seniority: 15, Years: 15, "Top must-haves": 36, "Everything else": 10, Degree: 4 };
const TIERS = [["Hot", 75], ["Warm", 65], ["Cool", 0]];
const TOP_N = 5, TOP_WEIGHT = [3, 2.5, 2, 1.5, 1], TITLE_WEIGHT = 4;
const UNSTATED = { name: "Mid", soft: true, unstated: true };
const GRAD = /\b(?:new grad|university grad|graduate|early career|emerging talent|intern(?:ship)?|apprentice)\b/i;
const NO_STACK = "It names no stack, so check the posting yourself.";
const NO_LIST = "It has no clear requirements list, so check the posting yourself.";

// Same-kind must skills are one requirement met by any member: 68-96% of such pairs share an "or / such as" clause.
const KINDS = {
  language: ["Java", "Python", "TypeScript", "JavaScript", "Go", "Kotlin", "Scala", "Rust", "C++", "C#", ".NET", "Ruby", "PHP", "Elixir", "Swift"],
  cloud: ["AWS", "GCP", "Azure"],
  "relational database": ["PostgreSQL", "MySQL", "SQL Server", "CockroachDB"],
  "NoSQL database": ["MongoDB", "Cassandra", "DynamoDB"],
  "message queue": ["Kafka", "RabbitMQ", "SQS", "Kinesis", "Pub/Sub", "Pulsar", "NATS"],
  "infrastructure tool": ["Terraform", "Pulumi", "CloudFormation", "Ansible"],
  "CI system": ["Jenkins", "GitHub Actions", "GitLab CI", "CircleCI", "Argo CD"],
  "monitoring tool": ["Datadog", "Prometheus", "Grafana", "Splunk", "New Relic", "OpenTelemetry"],
  "UI framework": ["React", "Angular", "Vue.js"],
  "ML framework": ["PyTorch", "TensorFlow"],
  warehouse: ["Snowflake", "BigQuery", "Redshift", "ClickHouse"],
};
const KIND_OF = Object.fromEntries(Object.entries(KINDS).flatMap(([kind, names]) => names.map(n => [n, kind])));
const NOT_STACK = new Set(["Agile", "Mentoring", "Cross-functional", "Technical Leadership", "Code Review", "Jira", "Git", "On-call", "SaaS", "B2B",
  "Payments", "Fintech", "Banking", "Billing", "Fraud / Risk", "Ledgers", "KYC / AML", "AI Coding Tools"]);

// Having the first skill shows the second, even if the resume never names it.
const IMPLIES = {
  "Spring Boot": ["Java"], Hibernate: ["Java"], Django: ["Python"], FastAPI: ["Python"], Flask: ["Python"], PyTorch: ["Python"],
  "Ruby on Rails": ["Ruby"], "Next.js": ["React"], React: ["JavaScript"], TypeScript: ["JavaScript"], "Node.js": ["JavaScript"],
  "React Native": ["React"], EKS: ["Kubernetes", "AWS"], ECS: ["AWS"], Kubernetes: ["Docker"], BigQuery: ["GCP", "SQL"],
  Redshift: ["AWS", "SQL"], PostgreSQL: ["SQL"], MySQL: ["SQL"], "SQL Server": ["SQL"],
  Terraform: ["Infrastructure as Code"], Pulumi: ["Infrastructure as Code"], CloudFormation: ["Infrastructure as Code", "AWS"],
};

const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const ROLE_NEAR = {
  [pair("Backend", "Full stack")]: .8, [pair("Frontend", "Full stack")]: .8, [pair("Data", "ML / AI")]: .65, [pair("Backend", "Data")]: .55,
  [pair("Backend", "DevOps / SRE")]: .55, [pair("DevOps / SRE", "Security")]: .5, [pair("Backend", "ML / AI")]: .45, [pair("Backend", "Security")]: .4,
  [pair("Frontend", "Mobile")]: .4, [pair("Backend", "Mobile")]: .25, [pair("Backend", "Embedded")]: .25, [pair("DevOps / SRE", "Data")]: .3,
  [pair("Full stack", "Data")]: .3, [pair("Full stack", "Mobile")]: .35, [pair("Full stack", "DevOps / SRE")]: .35, [pair("Full stack", "ML / AI")]: .3,
};
const roleFit = (mine, theirs) => (mine === theirs ? 1 : ROLE_NEAR[pair(mine, theirs)] ?? .15);
// 47% of titles carry no family word and fall back to skills, so a word a recruiter would stop at has to be caught here.
const OFF_TRACK = /\b(?:network(?:ing)? (?:engineer|connectivity)|fiber|pcb|rtl|asic|fpga|silicon|physical design|design verification|formal verification|mixed signal|risc-v|controls? (?:systems? )?engineer|power generation|fluids|cooling|sensor|robotics|compiler|kernel|graphics|gpu|mainframe|salesforce|av engineer|commissioning|3d programmer|yield|device engineer|audio engineer|bringup|eda|ic design|signal integrity|power integrity|transmission|power plant|manufacturing|cabling|safety and environment|thin films?|equipment|facilities|die-to-die|legal engineer|lab operations|rendering|it engineer|financial systems|erp)\b/i;
// A customer-facing or specialist track, whatever family the title names.
const SIDE_TRACK = /\bforward[- ]deploy|\bdeploy(?:ed|ment) (?:engineer|architect)|\bfde\b|\bprofessional services\b|developer (?:relations|advocate)|\bimplementation\b|\bconsultant\b|\bpresales\b|\bpartner engineer\b|\bsuccess engineer\b|\bescalation engineer\b|\bdesign engineer\b|\bauditor\b|\b(?:ml|inference) performance\b|\bsdn\b|\bnetwork(?:ing)?\b(?! security)/i;
// A topic that moves a title off its family, unless the title names the person's own family ("Data Engineer, Marketing").
const SIDE_TOPIC = /\bgtm\b|\bmarketing\b|\bmartech\b|\benablement\b|\bautomation engineer\b|\bbusiness systems\b|\bstorage\b/i;
const SYSTEMS_TITLE = /(?<!distributed )\b(?:systems?|production) engineer\b/i;
// fetch_jobs.py family() falls back to skills for these three, so job.role alone doesn't say the title named them.
const FAMILY_WORDS = { "Full stack": /full[- ]?stack/i, Backend: /back[- ]?end|server[- ]side|\bapi\b|distributed systems|\bpayments?\b|ledger|integrations?\b/i,
  Frontend: /front[- ]?end|\bui\b|\bweb developer/i };

const DEGREE_RANK = { "Associate": 0, "Bachelor's": 1, "Master's": 2, "PhD": 3, bachelor: 1, master: 2, phd: 3 };
const DEGREE_NAME = { bachelor: "bachelor's", master: "master's", phd: "PhD" };

const levelOf = p => p.level || (p.years == null ? null : p.years < 2 ? "Junior" : p.years < 5 ? "Mid" : "Senior");
const list = a => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const article = word => (/^(?:ML|[AEIOU])/.test(word) ? "an" : "a");
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TITLE_RX = {};
function inTitle(skill, title) {
  const rx = TITLE_RX[skill] ||= skill === "Go" ? /\b(?:Go|Golang)\b(?!-)/ : new RegExp(`(?<![\\w+#.])${esc(skill)}(?![\\w+#])`, "i");
  return rx.test(title);
}

// A title with no level word is stored as Mid, so that value says nothing. The years bar is the only other evidence.
function readLevel(job) {
  if (GRAD.test(job.title)) return { name: "Junior", soft: false, grad: true };
  const flat = /member of technical staff/i.test(job.title);
  if (!flat && (job.level !== "Mid" || /\b(?:ii|mid|sde ?2)\b/i.test(job.title))) return { name: job.level, soft: false };
  const y = job.years_required;
  return y == null ? null : { name: y < 2 ? "Junior" : y < 5 ? "Mid" : "Senior", soft: true };
}

// A title with no family word says nothing about the family, so the skills cast the vote. Too few or too even a vote
// stays unknown, or keeps the family fetch_jobs.py guessed from skills, as read from skills.
function readRole(job, pool, lift) {
  if (OFF_TRACK.test(job.title)) return { name: "Specialist", read: false };
  if (/\bsecurity\b/i.test(job.title)) return { name: "Security", read: false };  // FAMILIES tries backend and frontend words first
  if (SYSTEMS_TITLE.test(job.title) && (job.role === "General" || job.role === "Backend")) return { name: "DevOps / SRE", read: false };
  if (job.role !== "General" && (!FAMILY_WORDS[job.role] || FAMILY_WORDS[job.role].test(job.title))) return { name: job.role, read: false };
  const votes = {};
  for (const k of pool) for (const [fam, x] of Object.entries(lift[k] || {})) if (x > 1) votes[fam] = (votes[fam] || 0) + Math.log2(x);
  const [a, b] = Object.entries(votes).sort((x, y) => y[1] - x[1]);
  if (a && pool.length >= 3 && a[1] >= 1.5 && a[1] >= 1.5 * (b ? b[1] : 0)) return { name: a[0], read: true };
  return job.role === "General" ? null : { name: job.role, read: true };
}

// Same-kind skills a title joins with "or" or "/" ("Java, Go or Kotlin", "Python/Golang") are one requirement; "and" keeps them apart.
function orJoined(title, names) {
  const at = names.map(k => TITLE_RX[k].exec(title)).sort((a, b) => a.index - b.index);
  const gaps = at.slice(1).map((m, i) => title.slice(at[i].index + at[i][0].length, m.index));
  return gaps.every(g => /^\s*(?:,|\/|,?\s*or)\s*$/i.test(g)) && gaps.some(g => /\/|\bor\b/i.test(g));
}

function planJob(job, ctx) {
  const others = job.skills.filter(k => !job.must.includes(k) && !job.nice.includes(k));
  const split = job.must.length > 0;
  const pool = split ? job.must : others;
  const role = readRole(job, pool, ctx.lift);
  const core = ctx.core[role ? role.name : ""] || ctx.core[""];
  const groups = new Map(), soft = [], kinds = {};
  const named = new Set(pool.filter(k => inTitle(k, job.title)));
  for (const k of named) if (KIND_OF[k]) (kinds[KIND_OF[k]] ||= []).push(k);
  const anyOf = new Set(Object.values(kinds).filter(a => a.length > 1 && orJoined(job.title, a)).flat());
  for (const k of pool) {
    const titled = named.has(k);
    if (NOT_STACK.has(k) && !titled) { soft.push(k); continue; }
    const key = anyOf.has(k) ? `title ${KIND_OF[k]}` : titled || !KIND_OF[k] ? k : KIND_OF[k];
    const g = groups.get(key) || { key, kind: KIND_OF[k] || null, names: [], titled: false, rank: 0, stack: !NOT_STACK.has(k) };
    g.names.push(k);
    g.titled ||= titled;
    g.rank = Math.max(g.rank, core[k] || 0);
    groups.set(key, g);
  }
  const reqs = [...groups.values()].sort((a, b) => b.titled - a.titled || b.rank - a.rank);
  return { split, role, level: readLevel(job), top: reqs.slice(0, TOP_N), more: reqs.slice(TOP_N), soft, nice: job.nice, plain: split ? others : [] };
}

function buildStats(jobs) {
  const count = {}, byRole = {}, asked = {};
  for (const j of jobs) {
    byRole[j.role] = (byRole[j.role] || 0) + 1;
    if (j.years_required != null) (asked[j.level] ||= []).push(j.years_required);
    for (const k of j.must.length ? j.must : j.skills) ((count[j.role] ||= {})[k] = (count[j.role][k] || 0) + 1);
  }
  const total = {}, lift = {}, core = { "": {} };
  const named = Object.entries(count).filter(([f]) => f !== "General");
  const N = named.reduce((s, [f]) => s + byRole[f], 0);
  for (const [, c] of named) for (const [k, n] of Object.entries(c)) total[k] = (total[k] || 0) + n;
  for (const [f, c] of named) {
    core[f] = {};
    for (const [k, n] of Object.entries(c)) {
      const share = n / byRole[f], x = share / (total[k] / N);
      (lift[k] ||= {})[f] = x;
      core[f][k] = share * Math.log2(1 + x);
    }
  }
  for (const [k, n] of Object.entries(total)) core[""][k] = n / N;
  const ask = Object.fromEntries(Object.entries(asked).map(([l, a]) => [l, a.sort((x, y) => x - y)[a.length >> 1]]));
  const df = {};
  for (const j of jobs) for (const k of j.must) df[k] = (df[k] || 0) + 1;
  const stats = { ask, df, n: jobs.length, plans: new Map(), credits: new WeakMap() };
  for (const j of jobs) stats.plans.set(j, planJob(j, { lift, core }));
  return stats;
}

// Named in the latest job 1, an older job or project .8, listed only .5. Stale use loses a little; dates the resume lacks cost nothing.
// No evidence means an old saved resume or a hand-added skill, which says nothing against the skill, so it earns .8.
function credit(ev) {
  const base = !ev ? .8 : ev.strength === 3 ? 1 : ev.strength === 2 ? .8 : .5;
  return base * (ev?.recent == null || ev.recent <= 24 ? 1 : ev.recent <= 60 ? .9 : .75);
}

// Cached per profile, and rebuilt when its skills array changes: app.js keeps the object and swaps the array on every edit.
function creditsOf(p, stats) {
  let c = stats.credits.get(p);
  if (c?.from === p.skills) return c;
  c = { from: p.skills, skill: {}, kind: {}, via: {} };
  for (const k of p.skills) c.skill[k] = credit(p.evidence?.[k]);
  for (const k of p.skills) for (const to of IMPLIES[k] || []) {
    const v = Math.min(.8, c.skill[k]);
    if (v > (c.skill[to] || 0)) { c.skill[to] = v; c.via[to] = k; }
  }
  for (const [k, v] of Object.entries(c.skill)) {
    const kind = KIND_OF[k];
    if (kind && v >= .5 && v > (c.skill[c.kind[kind]] || 0)) c.kind[kind] = k;
  }
  stats.credits.set(p, c);
  return c;
}

function meet(req, c) {
  let best = 0, name = null;
  for (const k of req.names) if ((c.skill[k] || 0) > best) { best = c.skill[k]; name = k; }
  if (best) return { credit: best, name, near: null };
  const near = req.kind && c.kind[req.kind];
  return { credit: near ? (req.kind === "language" ? .2 : .35) : 0, name: null, near: near || null };
}

const reqLabel = r => (r.names.length > 1 ? r.names.slice(0, 3).join(" or ") : r.names[0]);

function levelFit(mine, job, years, stats) {
  const d = LEVELS.indexOf(job) - LEVELS.indexOf(mine);
  if (!d) return 1;
  if (d === 1) return years != null && years >= (stats.ask[job] ?? 99) ? .8 : .5;
  if (d === -1) return mine === "Staff+" ? .8 : .65;
  return d === 2 ? .1 : d === -2 ? .3 : 0;
}

function coverage(plan, c) {
  let sum = 0, weight = 0, confirmed = 0;
  const met = [], missed = [], weak = [];
  plan.top.forEach((r, i) => {
    const w = r.titled ? TITLE_WEIGHT : TOP_WEIGHT[i], m = meet(r, c);
    sum += w * m.credit;
    weight += w;
    if (m.credit >= .5) { confirmed++; m.credit < .7 ? weak.push(c.via[m.name] || m.name) : met.push(m.name); }  // a weak implied skill is weak for the one the resume names
    else missed.push({ req: r, near: m.near });
  });
  const pad = (TOP_N - plan.top.length) * 1.25;  // each empty slot pulls toward .5: few named skills prove little either way
  return { value: (sum + pad * .5) / (weight + pad), confirmed, met, weak, missed };
}

function everythingElse(plan, c) {
  let sum = 0, weight = 0;
  for (const r of plan.more) { sum += meet(r, c).credit; weight += 1; }
  for (const k of plan.soft) { sum += .5 * (c.skill[k] || 0); weight += .5; }
  for (const k of plan.nice) { sum += .75 * (c.skill[k] || 0); weight += .75; }
  for (const k of plan.plain) { sum += .25 * (c.skill[k] || 0); weight += .25; }
  return weight ? sum / weight : null;
}

function degreeFit(want, have) {
  if (!want || !have) return null;
  if (DEGREE_RANK[have] >= DEGREE_RANK[want.level]) return 1;
  return want.req === "required" ? 0 : .5;
}

function score(p, job, stats) {
  const plan = stats.plans.get(job), c = creditsOf(p, stats);
  const fits = [], gaps = [], next = [], caps = [], parts = [];
  const add = (name, value, note) => parts.push({ name, got: value == null ? 0 : Math.round(value * MAX[name] * 10) / 10, max: value == null ? 0 : MAX[name], note });
  const cap = (at, why) => caps.push([at, why]);

  // 1. Title: same family?
  const track = p.role === "General" ? null : p.role;  // a resume read as General says nothing about its family
  const own = plan.role && !plan.role.read && plan.role.name === track;
  const side = SIDE_TRACK.test(job.title) || !own && SIDE_TOPIC.test(job.title);
  const family = plan.role && track ? (plan.role.read ? .85 : 1) * roleFit(track, plan.role.name) : null;
  const role = side ? Math.min(family ?? 1, .45) : family;
  add("Role", role, role != null ? (side ? "Different track" : `${p.role} to ${plan.role.name}${plan.role.read ? " (read from skills)" : ""}`)
    : !plan.role ? "Title names no family" : "No role found on your resume");
  const offTrack = side ? "This is a different track: customer-facing, or a specialty your resume doesn't show."
    : plan.role && `${plan.role.read ? "Its skills read like" : "This is"} ${plan.role.name === "Specialist" ? "a specialist" : `${article(plan.role.name)} ${plan.role.name}`} role${plan.role.read ? "," : ""} and your track is ${p.role}.`;
  if (role != null && role >= .85) fits.push(`Your ${p.role} background fits this role.`);
  else if (role != null && role >= .5) next.push(`Describe your ${p.role} work in ${plan.role.name} terms in your opening lines.`);
  else if (role != null) gaps.push(offTrack);
  if (role != null && role < .3) cap(50, offTrack);
  else if (role != null && role < .5) cap(65, offTrack);

  // 2. Seniority, both directions. A level guessed from the years bar counts half.
  const mine = levelOf(p), lv = plan.level || (mine === "Junior" ? UNSTATED : null);
  let level = lv && mine ? levelFit(mine, lv.name, p.years, stats) : null;
  if (level != null && lv.soft) level = 1 - (1 - level) / 2;
  add("Seniority", level, level != null ? `${mine} to ${lv.name}${lv.soft ? " (read from years)" : ""}` : !lv ? "Level not stated" : "No level found on your resume");
  if (level != null) {
    const d = LEVELS.indexOf(lv.name) - LEVELS.indexOf(mine);
    if (lv.unstated) cap(69, "It states no level, and most postings like this ask for 2 or more years.");
    else if (!d) fits.push(`The level matches your ${mine} experience.`);
    else if (d === 1) next.push(`This is a step up: show ${lv.name} scope, such as what you led and decided.`);
    else if (d === -1) next.push("This sits below your level: say why it suits you, so you don't read as a flight risk.");
    else gaps.push(`${lv.name} is ${plural(Math.abs(d), "level")} ${d > 0 ? "above" : "below"} your ${mine} experience.`);
    if (d === 1 && !lv.soft) cap(74, `This is a step up from your ${mine} experience.`);
    if (d === -1 && !lv.soft) cap(85, `This sits one level below your ${mine} experience.`);
    if (Math.abs(d) >= 2) cap(lv.soft ? 74 : d > 0 ? 45 : 60, `${lv.name} is ${plural(Math.abs(d), "level")} ${d > 0 ? "above" : "below"} your ${mine} experience.`);
  }
  if (lv?.grad && p.years >= 3) cap(49, "This is an early-career program, and your experience is past it.");

  // 3. Years, as a ratio: one year short means more at 3 than at 10.
  const bar = job.years_required, ratio = bar != null && p.years != null ? p.years / bar : null;
  const years = ratio == null ? null : ratio >= 1 ? 1 : Math.max(0, (ratio - .4) / .6);
  add("Years", years, ratio != null ? `${p.years} against ${bar}+` : bar == null ? "No years stated" : "No years found on your resume");
  if (ratio != null && ratio >= 1) fits.push(`You have ${plural(p.years, "year")}; it asks for ${bar}+.`);
  else if (ratio != null) {
    const short = +(bar - p.years).toFixed(1), why = `It asks for ${bar}+ years and you have ${p.years}.`;
    gaps.push(why);
    next.push(`You are ${plural(short, "year")} short: ${ratio >= .8 ? "apply anyway and open with your biggest shipped result" : "go in through a referral if you can"}.`);
    if (ratio < .5) cap(50, why);
    if (lv && mine && LEVELS.indexOf(lv.name) > LEVELS.indexOf(mine)) cap(74, `It's a step up and ${why.toLowerCase()}`);
  }

  // 4. Top must-haves, then the whole list by information.
  const cov = coverage(plan, c), n = plan.top.length;
  add("Top must-haves", n ? cov.value : null, n ? `${cov.confirmed} of ${n}: ${plan.top.map(reqLabel).join(", ")}` : "No stack named");
  if (cov.met.length) {
    fits.push(`Strong on ${list(cov.met.slice(0, 3))}.`);
    const named = plan.top.find(r => r.titled && r.names.includes(meet(r, c).name));
    const lead = cov.met[0], rare = Math.max(1, Math.round(100 * (stats.df[lead] || 0) / stats.n));
    next.unshift(named ? `The title names ${meet(named, c).name}: put it in your headline.`
      : rare <= 5 ? `Lead with ${lead}: only ${rare}% of postings ask for it.` : `Lead with ${list(cov.met.slice(0, 2))} in your opening lines.`);
  }
  const weak = [...new Set(cov.weak)], listed = weak.filter(k => !(p.evidence?.[k]?.strength > 1)), stale = weak.filter(k => p.evidence?.[k]?.strength > 1);
  const listedLine = `${list(listed.slice(0, 2))} ${listed.length > 1 ? "are" : "is"} only listed on your resume, not shown in a job.`;
  const staleLine = `Your last use of ${list(stale.slice(0, 2))} looks old: add anything recent.`;
  const missedLine = `Not on your resume: ${list(cov.missed.slice(0, 3).map(m => reqLabel(m.req)))}.`;
  const onlyLine = `Its stack is just ${list(plan.top.map(r => (r.names.length > 1 ? `one ${r.kind}` : r.names[0])))}, so check the posting yourself.`;
  if (listed.length) next.push(`${list(listed.slice(0, 2))} ${listed.length > 1 ? "are" : "is"} only listed: if you used ${listed.length > 1 ? "them" : "it"} at work, show that in a job bullet.`);
  if (stale.length) gaps.push(staleLine);
  if (cov.missed.length) {
    gaps.push(missedLine);
    const m = cov.missed[0];
    const pct = Math.round(100 * (stats.df[m.req.names[0]] || 0) / stats.n);
    next.push(m.near ? `Name ${m.near} as your closest match to ${reqLabel(m.req)}.`
      : `If you have used ${reqLabel(m.req)}, add it to your resume.${pct >= 5 ? ` If not, ${pct}% of postings ask for it, so it's worth learning.` : ""}`);
  }
  const lost = plan.top.find(r => r.titled && r.stack && meet(r, c).credit < .5);
  if (lost) cap(60, `The title names ${reqLabel(lost)}, which is not on your resume.`);
  // These caps read the weighted value; the reason says what is true by count.
  const thin = !n ? NO_STACK : cov.missed.length * 2 > n ? "Most of its top must-haves are not on your resume." : cov.missed.length ? missedLine
    : listed.length ? listedLine : stale.length ? staleLine : onlyLine;
  if (cov.value < .5) cap(54, thin);
  else if (cov.value < .7 || cov.missed.length >= 2) cap(74, thin);
  if (!n && !(role >= .5)) cap(54, NO_STACK);
  if (!plan.split) {  // a skill mentioned anywhere is weaker evidence than one in the requirements
    gaps.push(NO_LIST);
    cap(85, NO_LIST);
  }

  // 5. Everything else.
  const rest = everythingElse(plan, c);
  const counts = [[plan.more.length + plan.soft.length, "other must-have"], [plan.nice.length, "nice-to-have"], [plan.plain.length, "mention"]];
  add("Everything else", rest, rest == null ? "Nothing else named" : list(counts.filter(([k]) => k).map(([k, word]) => plural(k, word))));
  const bonus = plan.nice.filter(k => (c.skill[k] || 0) >= .8);
  if (bonus.length) fits.push(`Nice-to-haves you already have: ${list(bonus.slice(0, 3))}.`);

  const degree = degreeFit(job.degree, p.degree);
  add("Degree", degree, !job.degree ? "No degree stated" : !p.degree ? "No degree found on your resume" : `${DEGREE_NAME[job.degree.level]} ${job.degree.req}`);
  if (degree === 0) gaps.push(`It lists a ${DEGREE_NAME[job.degree.level]} as required.`);

  // Hot needs evidence, not just silence.
  const known = (role != null) + (level != null) + (years != null), stated = (plan.role != null) + (plan.level != null) + (bar != null);
  if (!cov.confirmed) cap(60, n ? "None of its top must-haves are confirmed by your resume." : NO_STACK);
  else if (cov.confirmed < 2) cap(65, n > 1 ? "Only one of its top must-haves is confirmed by your resume." : onlyLine);
  else if (cov.confirmed < 3 && cov.missed.length) cap(74, "Fewer than three of its top must-haves are confirmed by your resume.");
  else if (known < 2) cap(74, stated < 2 ? "It says too little about the role or level, so check the posting yourself."
    : "Your resume shows too little about your role or level, so check the posting yourself.");
  if (role == null && cov.missed.length) cap(74, !plan.role ? "Its title names no family, so check the posting yourself." : "Your resume shows no role family, so check the posting yourself.");

  const max = parts.reduce((s, x) => s + x.max, 0);
  const exact = max ? 100 * parts.reduce((s, x) => s + x.got, 0) / max : 0, raw = Math.round(exact);
  const low = caps.reduce((a, x) => (x[0] < a[0] ? x : a), [101, ""]);
  const held = raw > low[0] ? { at: low[0], why: low[1] } : null;
  // The binding reason comes first, and no gap after it says the same again ("names no stack" already says to check the posting).
  const said = held ? held.why.toLowerCase() : "";
  const repeats = g => said.includes(g.toLowerCase().slice(0, -1)) || (held?.why === NO_STACK && g === NO_LIST);
  const shown = [...new Set([...(held ? [held.why] : []), ...gaps.filter(g => !repeats(g))])];
  const final = Math.min(raw, low[0]);
  return { score: final, tier: TIERS.find(t => final >= t[1])[0], parts, held, fits: fits.slice(0, 4), gaps: shown.slice(0, 3), next: next.slice(0, 3),
    tie: exact };
}

const wmatch = { score, buildStats, TIERS, levelOf };
if (typeof window !== "undefined") window.wmatch = wmatch;
if (typeof module !== "undefined") module.exports = wmatch;
})();
