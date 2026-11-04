"use strict";
// wradar match. Reads a posting in the order a recruiter does: title, seniority, years, top must-haves, the rest.
// buildStats(jobs, rules) runs once; score(profile, job, stats) is pure apart from caches inside stats.
// An IIFE because this loads as a classic script beside app.js, which declares esc, list, plural, LEVELS and score too.
(() => {

// One ladder, two tracks. Staff+ and Manager share a rank: moving between them changes the track, not the level.
const RANK = { Intern: 0, Junior: 1, Mid: 2, Senior: 3, "Staff+": 4, Manager: 4, "Senior Manager": 5, Director: 6, "Senior Director": 6, VP: 7, "C-level": 8 };
const BOSS = new Set(["Manager", "Senior Manager", "Director", "Senior Director", "VP", "C-level"]);
const MAX = { Role: 20, Seniority: 15, Years: 15, "Top must-haves": 36, "Everything else": 10, Degree: 4 };
const TIERS = [["Hot", 75], ["Warm", 65], ["Cool", 0]];
const TOP_N = 5, TOP_WEIGHT = [3, 2.5, 2, 1.5, 1], TITLE_WEIGHT = 4;
const UNSTATED = { name: "Mid", soft: true, unstated: true };
const INTERN = /\bintern(?:ship)?s?\b/i;
const GRAD = /\b(?:new grad|university grad|graduate|early career|emerging talent|apprentice)\b/i;
const NO_STACK = "It names none of the skills wradar knows, so check the posting yourself.";
const NO_LIST = "It has no clear requirements list, so check the posting yourself.";
const NO_TEAM = "It manages a team, and your resume shows no people you managed.";

// Same-kind must skills are one requirement met by any member: 68-96% of such pairs share an "or / such as" clause.
const KINDS = {
  language: ["Java", "Python", "TypeScript", "JavaScript", "Go", "Kotlin", "Scala", "Rust", "C++", "C#", ".NET", "Ruby", "PHP", "Elixir", "Swift", "R",
    "SAS / Stata / SPSS"],
  cloud: ["AWS", "GCP", "Azure"],
  "relational database": ["PostgreSQL", "MySQL", "SQL Server", "CockroachDB"],
  "NoSQL database": ["MongoDB", "Cassandra", "DynamoDB"],
  "message queue": ["Kafka", "RabbitMQ", "SQS", "Kinesis", "Pub/Sub", "Pulsar", "NATS"],
  "infrastructure tool": ["Terraform", "Pulumi", "CloudFormation", "Ansible"],
  "CI system": ["Jenkins", "GitHub Actions", "GitLab CI", "CircleCI", "Argo CD"],
  "monitoring tool": ["Datadog", "Prometheus", "Grafana", "Splunk", "New Relic", "OpenTelemetry"],
  "UI framework": ["React", "Angular", "Vue.js"],
  "ML framework": ["PyTorch", "TensorFlow"],
  warehouse: ["Snowflake", "BigQuery", "Redshift", "ClickHouse", "Databricks"],
  spreadsheet: ["Excel", "Google Sheets"],
  CRM: ["Salesforce", "HubSpot", "Microsoft Dynamics", "CRM"],
  ERP: ["NetSuite", "SAP", "Oracle ERP", "QuickBooks", "ERP Systems"],
  HRIS: ["Workday", "ADP", "HRIS"],
  ATS: ["Greenhouse", "Lever", "Applicant Tracking Systems"],
  "marketing automation tool": ["Marketo", "Braze", "Klaviyo", "Salesforce Marketing Cloud", "Marketing Automation"],
  "ad platform": ["Google Ads", "Meta Ads", "LinkedIn Ads"],
  "web analytics tool": ["Google Analytics", "Adobe Analytics"],
  "product analytics tool": ["Amplitude", "Mixpanel", "Product Analytics"],
  "BI tool": ["Tableau", "Looker", "Power BI", "Metabase", "Business Intelligence"],
  "design tool": ["Figma", "Sketch / Adobe XD"],
  "graphics tool": ["Adobe Creative Suite", "Canva"],
  "help desk": ["Zendesk", "Intercom", "ServiceNow", "Ticketing Systems"],
  "sales engagement tool": ["Outreach", "Salesloft", "Apollo.io"],
  "prospecting data tool": ["ZoomInfo", "LinkedIn Sales Navigator"],
  "sales methodology": ["MEDDICC", "Sales Methodology"],
  "planning tool": ["Anaplan", "Adaptive Planning", "EPM Tools"],
  "procurement tool": ["Coupa", "SAP Ariba", "Zip"],
  "device management tool": ["Jamf", "Microsoft Intune", "MDM"],
  "automation tool": ["Workato", "Zapier", "Workflow Automation"],
  "advisory background": ["Investment Banking", "Management Consulting", "Private Equity / VC"],
};
const KIND_OF = Object.fromEntries(Object.entries(KINDS).flatMap(([kind, names]) => names.map(n => [n, kind])));
// Practices and office tools say little in any posting. Industry and domain words are background in an engineering posting,
// but the job itself elsewhere: Payments for an Account Executive, KYC / AML for a compliance analyst, Recruiting for a recruiter.
const PRACTICE = new Set(["Agile", "Mentoring", "Cross-functional", "Technical Leadership", "Code Review", "Jira", "Git", "On-call", "AI Coding Tools",
  "Generative AI Tools", "Stakeholder Management", "Executive Presence", "Presentation Skills", "Facilitation", "Negotiation", "Design Thinking",
  "Microsoft Office", "Google Workspace", "PowerPoint", "Work Management Tools"]);
const DOMAIN = new Set(["SaaS", "B2B", "Payments", "Fintech", "Banking", "Billing", "Fraud / Risk", "Ledgers", "KYC / AML", "Go-to-Market", "E-commerce",
  "Healthcare", "Telehealth", "Insurance", "Public Sector", "Restaurant & Hospitality", "Retail Operations", "Point of Sale", "Fleet & Telematics", "Payroll",
  "DEI Programs", "Troubleshooting", "Data Analysis", "Project Management", "Program Management", "Recruiting", "Customer Success", "Business Operations",
  "Strategic Planning"]);
const isSoft = (k, eng) => PRACTICE.has(k) || eng && DOMAIN.has(k);
// A licence or certificate is held or not: listed under Certifications, it proves as much as a job bullet does.
const CREDENTIALS = new Set(["CPA", "CFA", "PMP", "HR Certification", "FINRA Licenses", "Law Degree & Bar", "Clinical Licensure", "Insurance License"]);

// Having the first skill shows the second, even if the resume never names it.
const IMPLIES = {
  "Spring Boot": ["Java"], Hibernate: ["Java"], Django: ["Python"], FastAPI: ["Python"], Flask: ["Python"], PyTorch: ["Python"],
  "Ruby on Rails": ["Ruby"], "Next.js": ["React"], React: ["JavaScript"], TypeScript: ["JavaScript"], "Node.js": ["JavaScript"],
  "React Native": ["React"], EKS: ["Kubernetes", "AWS"], ECS: ["AWS"], Kubernetes: ["Docker"], BigQuery: ["GCP", "SQL"],
  Redshift: ["AWS", "SQL"], PostgreSQL: ["SQL"], MySQL: ["SQL"], "SQL Server": ["SQL"],
  Terraform: ["Infrastructure as Code"], Pulumi: ["Infrastructure as Code"], CloudFormation: ["Infrastructure as Code", "AWS"],
  Salesforce: ["CRM"], HubSpot: ["CRM", "Marketing Automation"], "Microsoft Dynamics": ["CRM", "ERP Systems"], NetSuite: ["ERP Systems"],
  SAP: ["ERP Systems"], "Oracle ERP": ["ERP Systems"], QuickBooks: ["ERP Systems"], Workday: ["HRIS"], ADP: ["HRIS"],
  Greenhouse: ["Applicant Tracking Systems"], Lever: ["Applicant Tracking Systems"], Zendesk: ["Ticketing Systems"], Intercom: ["Ticketing Systems"],
  ServiceNow: ["Ticketing Systems"], Tableau: ["Business Intelligence", "Data Visualization"], Looker: ["Business Intelligence", "Data Visualization"],
  "Power BI": ["Business Intelligence", "Data Visualization"], Metabase: ["Business Intelligence", "Data Visualization"],
  Marketo: ["Marketing Automation"], Braze: ["Marketing Automation"], Klaviyo: ["Marketing Automation"],
  "Salesforce Marketing Cloud": ["Marketing Automation", "Salesforce"], "Google Ads": ["Performance Marketing"], "Meta Ads": ["Performance Marketing"],
  "LinkedIn Ads": ["Performance Marketing"], Amplitude: ["Product Analytics"], Mixpanel: ["Product Analytics"], Jamf: ["MDM"], "Microsoft Intune": ["MDM"],
  Outreach: ["Prospecting"], Salesloft: ["Prospecting"], "Apollo.io": ["Prospecting"], ZoomInfo: ["Prospecting"], "LinkedIn Sales Navigator": ["Prospecting"],
  Anaplan: ["FP&A"], "Adaptive Planning": ["FP&A"], "EPM Tools": ["FP&A"], "BlackLine / FloQast": ["Month-end Close", "Account Reconciliation"],
  "Zuora / Chargebee": ["Billing"], Coupa: ["Procurement"], "SAP Ariba": ["Procurement"], Zip: ["Procurement"],
  "Customer Success Platforms": ["Customer Success"], PMP: ["Project Management"], "Lean Six Sigma": ["Process Improvement"], CPA: ["GAAP"],
  "Revenue Recognition": ["GAAP"], "FINRA Licenses": ["Financial Services Regulation"], Okta: ["SAML / SSO"], Shopify: ["E-commerce"],
  MEDDICC: ["Sales Methodology"],
};

const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const ROLE_NEAR = {
  [pair("Backend", "Full stack")]: .8, [pair("Frontend", "Full stack")]: .8, [pair("Data", "ML / AI")]: .65, [pair("Backend", "Data")]: .55,
  [pair("Backend", "DevOps / SRE")]: .55, [pair("DevOps / SRE", "Security")]: .5, [pair("Backend", "ML / AI")]: .45, [pair("Backend", "Security")]: .4,
  [pair("Frontend", "Mobile")]: .4, [pair("Backend", "Mobile")]: .25, [pair("Backend", "Embedded")]: .25, [pair("DevOps / SRE", "Data")]: .3,
  [pair("Full stack", "Data")]: .3, [pair("Full stack", "Mobile")]: .35, [pair("Full stack", "DevOps / SRE")]: .35, [pair("Full stack", "ML / AI")]: .3,
  [pair("Sales", "Customer success")]: .6, [pair("Customer success", "Support")]: .55, [pair("Solutions & presales", "Sales")]: .5,
  [pair("Solutions & presales", "Customer success")]: .5, [pair("Solutions & presales", "Backend")]: .3, [pair("Solutions & presales", "Full stack")]: .3,
  [pair("Marketing", "Communications")]: .65, [pair("Marketing", "Developer relations")]: .4, [pair("Marketing", "Product management")]: .45,
  [pair("Developer relations", "Full stack")]: .3, [pair("Product management", "Program management")]: .55,
  [pair("Product management", "Business operations")]: .4, [pair("Product management", "Design")]: .3,
  [pair("Business operations", "Revenue operations")]: .55, [pair("Business operations", "Finance")]: .5, [pair("Revenue operations", "Sales")]: .5,
  [pair("Revenue operations", "Marketing")]: .4, [pair("Business operations", "Supply chain")]: .5, [pair("Business operations", "Administrative")]: .4,
  [pair("Accounting", "Finance")]: .6, [pair("Accounting", "Risk & compliance")]: .5, [pair("Recruiting", "People & HR")]: .5,
  [pair("Education", "People & HR")]: .3, [pair("Legal", "Risk & compliance")]: .5, [pair("Risk & compliance", "Trust & safety")]: .5,
  [pair("Risk & compliance", "Cybersecurity")]: .4, [pair("Analytics", "Data science")]: .6, [pair("Analytics", "Data")]: .55,
  [pair("Analytics", "Business operations")]: .5, [pair("Analytics", "Finance")]: .4, [pair("Data science", "ML / AI")]: .6,
  [pair("Data science", "Research")]: .55, [pair("Research", "ML / AI")]: .55, [pair("IT", "Cybersecurity")]: .5, [pair("IT", "DevOps / SRE")]: .4,
  [pair("IT", "Support")]: .4, [pair("Cybersecurity", "Security")]: .7, [pair("Design", "Frontend")]: .3, [pair("Design", "Communications")]: .4,
  [pair("Hardware", "Embedded")]: .6,
};
const roleFit = (mine, theirs) => (mine === theirs ? 1 : ROLE_NEAR[pair(mine, theirs)] ?? .15);
// The title rules below read software titles only. 47% of those carry no family word and fall back to skills, so a word a
// recruiter would stop at has to be caught here.
const OFF_TRACK = /\b(?:network(?:ing)? (?:engineer|connectivity)|fiber|pcb|rtl|asic|fpga|silicon|physical design|design verification|formal verification|mixed signal|risc-v|controls? (?:systems? )?engineer|power generation|fluids|cooling|sensor|robotics|compiler|kernel|graphics|gpu|mainframe|salesforce|av engineer|commissioning|3d programmer|yield|device engineer|audio engineer|bringup|eda|ic design|signal integrity|power integrity|transmission|power plant|manufacturing|cabling|safety and environment|thin films?|equipment|facilities|die-to-die|legal engineer|lab operations|rendering|it engineer|financial systems|erp)\b/i;
// A customer-facing or specialist track, whatever family the title names.
const SIDE_TRACK = /\bforward[- ]deploy|\bdeploy(?:ed|ment) (?:engineer|architect)|\bfde\b|\bprofessional services\b|developer (?:relations|advocate)|\bimplementation\b|\bconsultant\b|\bpresales\b|\bpartner engineer\b|\bsuccess engineer\b|\bescalation engineer\b|\bdesign engineer\b|\bauditor\b|\b(?:ml|inference) performance\b|\bsdn\b|\bnetwork(?:ing)?\b(?! security)/i;
// A topic that moves a title off its family, unless the title names the person's own family ("Data Engineer, Marketing").
const SIDE_TOPIC = /\bgtm\b|\bmarketing\b|\bmartech\b|\benablement\b|\bautomation engineer\b|\bbusiness systems\b|\bstorage\b/i;
const SYSTEMS_TITLE = /(?<!distributed )\b(?:systems?|production) engineer\b/i;
// fetch_jobs.py family() falls back to skills for these three, so job.role alone doesn't say the title named them.
const FAMILY_WORDS = { "Full stack": /full[- ]?stack/i, Backend: /back[- ]?end|server[- ]side|\bapi\b|distributed systems|\bpayments?\b|ledger|integrations?\b/i,
  Frontend: /front[- ]?end|\bui\b|\bweb developer/i };

// A professional degree (JD, MD, PharmD...) ranks with a master's, but only a professional degree meets a bar that asks for one.
const DEGREE_RANK = { "Associate": 0, "Bachelor's": 1, "Master's": 2, "PhD": 3, Professional: 2, associate: 0, bachelor: 1, master: 2, phd: 3, professional: 2 };
const DEGREE_NAME = { associate: "associate degree", bachelor: "bachelor's", master: "master's", phd: "PhD", professional: "professional degree" };
// "only 3% of finance postings": shares are read within the job's field once the data names fields.
const NOUN = { Customer: "customer-facing", People: "HR and recruiting", "IT & security": "IT and security" };
const postings = field => (field ? `${NOUN[field] || field.toLowerCase().replace("&", "and")} postings` : "postings");

const levelOf = p => p.level || (p.years == null ? null : p.years < 2 ? "Junior" : p.years < 5 ? "Mid" : "Senior");
const list = a => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const article = word => (/^(?:[AEIOU]|[FHLMNRSX](?:[A-Z&]|\b))/.test(word) ? "an" : "a");  // an FP&A, an HR, an SDR, an ML / AI
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TITLE_RX = {};
function inTitle(skill, title) {
  const rx = TITLE_RX[skill] ||= skill === "Go" ? /\b(?:Go|Golang)\b(?!-)/
    : skill === "R" ? /(?<![\w+#.])R(?![\w+#&'’-]|\.\w|\/\d|(?<=\(R)\))/  // not R&D, R/3 or (R)
    : new RegExp(`(?<![\\w+#.])${esc(skill)}(?![\\w+#])`, "i");
  return rx.test(title);
}

// A title with no level word is stored as Mid, so that value says nothing. The years bar is the only other evidence.
// In a recruiter's or a manager's title, the early-career words name who is hired: "Senior Recruiter, Emerging Talent".
function readLevel(job) {
  const hires = job.role === "Recruiting" || BOSS.has(job.level);
  if (job.level === "Intern" || !hires && INTERN.test(job.title)) return { name: "Intern", soft: false, grad: true };
  if (!hires && GRAD.test(job.title)) return { name: "Junior", soft: false, grad: true };
  const flat = /member of technical staff/i.test(job.title);
  if (!flat && (job.level !== "Mid" || /\b(?:ii|mid|sde ?2)\b/i.test(job.title))) return { name: job.level, soft: false };
  const y = job.years_required;
  return y == null ? null : { name: y < 2 ? "Junior" : y < 5 ? "Mid" : "Senior", soft: true };
}

// A title with no family word says nothing about the family, so the skills cast the vote among the families of its field.
// Too few or too even a vote stays unknown, or keeps the family fetch_jobs.py guessed from skills, as read from skills.
function readRole(job, pool, ctx, sw) {
  if (job.role === "Other") return null;
  if (sw && OFF_TRACK.test(job.title)) return { name: "Specialist", read: false };
  if (sw && /\bsecurity\b/i.test(job.title)) return { name: "Security", read: false };  // FAMILIES tries backend and frontend words first
  if (sw && SYSTEMS_TITLE.test(job.title) && (job.role === "General" || job.role === "Backend")) return { name: "DevOps / SRE", read: false };
  if (job.role !== "General" && (!FAMILY_WORDS[job.role] || FAMILY_WORDS[job.role].test(job.title))) return { name: job.role, read: false };
  const votes = {}, field = ctx.fieldOf(job.role);
  for (const k of pool) for (const [fam, x] of Object.entries(ctx.lift[k] || {})) if (x > 1 && ctx.fieldOf(fam) === field) votes[fam] = (votes[fam] || 0) + Math.log2(x);
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
  const field = ctx.fieldOf(job.role), eng = field === "Engineering", sw = eng && job.role !== "Hardware";  // Hardware names its specialty itself
  const role = readRole(job, pool, ctx, sw);
  const core = role && ctx.core[role.name] || ctx.fieldCore[field] || ctx.core[""];
  const groups = new Map(), soft = [], kinds = {};
  const named = new Set(pool.filter(k => inTitle(k, job.title)));
  for (const k of named) if (KIND_OF[k]) (kinds[KIND_OF[k]] ||= []).push(k);
  const anyOf = new Set(Object.values(kinds).filter(a => a.length > 1 && orJoined(job.title, a)).flat());
  for (const k of pool) {
    const titled = named.has(k), notStack = isSoft(k, eng);
    if (notStack && !titled) { soft.push(k); continue; }
    const key = anyOf.has(k) ? `title ${KIND_OF[k]}` : titled || !KIND_OF[k] ? k : KIND_OF[k];
    const g = groups.get(key) || { key, kind: KIND_OF[k] || null, names: [], titled: false, rank: 0, stack: !notStack };
    g.names.push(k);
    g.titled ||= titled;
    g.rank = Math.max(g.rank, core[k] || 0);
    groups.set(key, g);
  }
  const reqs = [...groups.values()].sort((a, b) => b.titled - a.titled || b.rank - a.rank);
  return { split, role, level: readLevel(job), top: reqs.slice(0, TOP_N), more: reqs.slice(TOP_N), soft, nice: job.nice, plain: split ? others : [],
    share: ctx.shareOf(job.role), sideTrack: sw && SIDE_TRACK.test(job.title), sideTopic: sw && SIDE_TOPIC.test(job.title),
    stackless: job.nice.some(k => !isSoft(k, eng)) ? NO_LIST : NO_STACK };  // with nice-to-haves named, "names none" isn't true
}

// rules.fields maps each role to its field. Old data has none: every role is Engineering then, and shares are of every posting.
function buildStats(jobs, rules) {
  const fields = rules?.fields, fieldOf = r => (fields ? fields[r] || "Other" : "Engineering");
  const shareOf = r => (fields && fieldOf(r) !== "Other" ? fieldOf(r) : "");
  const count = {}, byRole = {}, asked = {};
  for (const j of jobs) {
    byRole[j.role] = (byRole[j.role] || 0) + 1;
    if (j.years_required != null) (asked[j.level] ||= []).push(j.years_required);
    for (const k of j.must.length ? j.must : j.skills) ((count[j.role] ||= {})[k] = (count[j.role][k] || 0) + 1);
  }
  // Lift is read within a field, so sales postings don't change what Java says about Backend.
  const total = {}, inField = {}, lift = {}, core = { "": {} }, fieldCore = {};
  const named = Object.entries(count).filter(([f]) => f !== "General" && f !== "Other");
  const N = named.reduce((s, [f]) => s + byRole[f], 0);
  for (const [f, c] of named) {
    const F = inField[fieldOf(f)] ||= { n: 0, total: {} };
    F.n += byRole[f];
    for (const [k, n] of Object.entries(c)) {
      total[k] = (total[k] || 0) + n;
      F.total[k] = (F.total[k] || 0) + n;
    }
  }
  for (const [f, c] of named) {
    const F = inField[fieldOf(f)];
    core[f] = {};
    for (const [k, n] of Object.entries(c)) {
      const share = n / byRole[f], x = share / (F.total[k] / F.n);
      (lift[k] ||= {})[f] = x;
      core[f][k] = share * Math.log2(1 + x);
    }
  }
  for (const [k, n] of Object.entries(total)) core[""][k] = n / N;
  for (const [name, F] of Object.entries(inField)) fieldCore[name] = Object.fromEntries(Object.entries(F.total).map(([k, n]) => [k, n / F.n]));
  const ask = Object.fromEntries(Object.entries(asked).map(([l, a]) => [l, a.sort((x, y) => x - y)[a.length >> 1]]));
  const df = {}, n = {};
  for (const j of jobs) for (const key of new Set(["", shareOf(j.role)])) {
    n[key] = (n[key] || 0) + 1;
    for (const k of j.must) ((df[key] ||= {})[k] = (df[key][k] || 0) + 1);
  }
  const stats = { ask, df, n, shareOf, plans: new Map(), credits: new WeakMap() };
  for (const j of jobs) stats.plans.set(j, planJob(j, { lift, core, fieldCore, fieldOf, shareOf }));
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
  for (const k of p.skills) c.skill[k] = CREDENTIALS.has(k) ? 1 : credit(p.evidence?.[k]);
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

// The step on the ladder, times the track: managing people is a change of track, easier with people managed on the resume.
function levelFit(mine, job, years, stats, people) {
  const d = RANK[job] - RANK[mine];
  const step = !d ? 1 : d === 1 ? (years != null && years >= (stats.ask[job] ?? 99) ? .8 : .5)
    : d === -1 ? (RANK[mine] >= 4 ? .8 : .65) : d === 2 ? .1 : d === -2 ? .3 : 0;
  return step * (BOSS.has(job) === BOSS.has(mine) ? 1 : BOSS.has(job) ? (people ? .85 : .6) : .85);
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
  if (want.level === "professional" ? /^professional$/i.test(have) : DEGREE_RANK[have] >= DEGREE_RANK[want.level]) return 1;
  return want.req === "required" ? 0 : .5;
}

function score(p, job, stats) {
  const plan = stats.plans.get(job), c = creditsOf(p, stats);
  const fits = [], gaps = [], next = [], caps = [], parts = [];
  const add = (name, value, note) => parts.push({ name, got: value == null ? 0 : Math.round(value * MAX[name] * 10) / 10, max: value == null ? 0 : MAX[name], note });
  const cap = (at, why) => caps.push([at, why]);
  const pct = k => Math.round(100 * (stats.df[plan.share]?.[k] || 0) / stats.n[plan.share]), among = postings(plan.share);

  // 1. Title: same family? A resume read as General or Other says nothing about its family, and a job read as General says nothing
  // about its own, but a field still differs: a plain "Software Engineer" is no role match for an analyst, nor a sales job for an engineer.
  const track = p.role === "General" || p.role === "Other" ? null : p.role, field = stats.shareOf(p.role);
  const cross = field && plan.share && field !== plan.share && (!track || !plan.role);
  const yours = track || (cross ? field : null), theirs = plan.role ? plan.role.name : cross ? plan.share : null, read = plan.role?.read;
  const own = plan.role && !read && theirs === track;
  const side = plan.sideTrack || !own && plan.sideTopic;
  const family = yours && theirs ? (read ? .85 : 1) * roleFit(yours, theirs) : null;
  const role = side ? Math.min(family ?? 1, .45) : family;
  add("Role", role, role != null ? (side ? "Different track" : `${yours} to ${theirs}${read ? " (read from skills)" : ""}`)
    : !plan.role ? "Title names no family" : "No role found on your resume");
  const offTrack = side ? "This is a different track: customer-facing, or a specialty your resume doesn't show."
    : theirs && `${read ? "Its skills read like" : "This is"} ${theirs === "Specialist" ? "a specialist" : `${article(theirs)} ${theirs}`} role${read ? "," : ""} and your track is ${yours}.`;
  if (role != null && role >= .85) fits.push(`Your ${yours} background fits this role.`);
  else if (role != null && role >= .5) next.push(`Describe your ${yours} work in ${theirs} terms in your opening lines.`);
  else if (role != null) gaps.push(offTrack);
  if (role != null && role < .3) cap(50, offTrack);
  else if (role != null && role < .5) cap(65, offTrack);

  // 2. Seniority, both directions, and the track. A level guessed from the years bar counts half.
  const mine = levelOf(p), lv = plan.level || (RANK[mine] <= 1 ? UNSTATED : null);
  const people = p.evidence?.["People Management"]?.strength >= 2;
  let level = lv && mine ? levelFit(mine, lv.name, p.years, stats, people) : null;
  if (level != null && lv.soft) level = 1 - (1 - level) / 2;
  add("Seniority", level, level != null ? `${mine} to ${lv.name}${lv.soft ? " (read from years)" : ""}` : !lv ? "Level not stated" : "No level found on your resume");
  if (level != null) {
    const d = RANK[lv.name] - RANK[mine], turn = BOSS.has(lv.name) !== BOSS.has(mine);
    if (lv.unstated) cap(69, "It states no level, and most postings like this ask for 2 or more years.");
    else if (!d && !turn) fits.push(`The level matches your ${mine} experience.`);
    else if (d === 1) next.push(`This is a step up: show ${lv.name} scope, such as what you led and decided.`);
    else if (d === -1) next.push("This sits below your level: say why it suits you, so you don't read as a flight risk.");
    else if (d) gaps.push(`${lv.name} is ${plural(Math.abs(d), "level")} ${d > 0 ? "above" : "below"} your ${mine} experience.`);
    if (turn && BOSS.has(lv.name) && !people) {
      gaps.push(NO_TEAM);
      cap(74, NO_TEAM);
    } else if (BOSS.has(lv.name)) next.push("Open with the team you led, its size and what it delivered.");
    if (turn && BOSS.has(mine)) next.push("Lead with work you did yourself.");
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
    next.push(`You are ${plural(short, "year")} short: ${ratio >= .8 ? "apply anyway and open with your biggest result, with its numbers" : "go in through a referral if you can"}.`);
    if (ratio < .5) cap(50, why);
    if (lv && mine && RANK[lv.name] > RANK[mine]) cap(74, `It's a step up and ${why.toLowerCase()}`);
  }

  // 4. Top must-haves, then the whole list by information.
  const cov = coverage(plan, c), n = plan.top.length;
  add("Top must-haves", n ? cov.value : null, n ? `${cov.confirmed} of ${n}: ${plan.top.map(reqLabel).join(", ")}` : "No skills named");
  if (cov.met.length) {
    fits.push(`Strong on ${list(cov.met.slice(0, 3))}.`);
    const named = plan.top.find(r => r.titled && r.names.includes(meet(r, c).name));
    const lead = cov.met[0], rare = Math.max(1, pct(lead));
    next.unshift(named ? `The title names ${meet(named, c).name}: put it in your headline.`
      : rare <= 5 ? `Lead with ${lead}: only ${rare}% of ${among} ask for it.` : `Lead with ${list(cov.met.slice(0, 2))} in your opening lines.`);
  }
  const weak = [...new Set(cov.weak)], listed = weak.filter(k => !(p.evidence?.[k]?.strength > 1)), stale = weak.filter(k => p.evidence?.[k]?.strength > 1);
  const listedLine = `${list(listed.slice(0, 2))} ${listed.length > 1 ? "are" : "is"} only listed on your resume, not shown in a job.`;
  const staleLine = `Your last use of ${list(stale.slice(0, 2))} looks old: add anything recent.`;
  const missedLine = `Not on your resume: ${list(cov.missed.slice(0, 3).map(m => reqLabel(m.req)))}.`;
  const onlyLine = `It names only ${list(plan.top.map(r => (r.names.length > 1 ? `one ${r.kind}` : r.names[0])))}, so check the posting yourself.`;
  if (listed.length) next.push(`${list(listed.slice(0, 2))} ${listed.length > 1 ? "are" : "is"} only listed: if you used ${listed.length > 1 ? "them" : "it"} at work, show that in a job bullet.`);
  if (stale.length) gaps.push(staleLine);
  if (cov.missed.length) {
    gaps.push(missedLine);
    const m = cov.missed[0], share = pct(m.req.names[0]);
    next.push(m.near ? `Name ${m.near} as your closest match to ${reqLabel(m.req)}.`
      : `If you have used ${reqLabel(m.req)}, add it to your resume.${share >= 5 ? ` If not, ${share}% of ${among} ask for it, so it's worth learning.` : ""}`);
  }
  const lost = plan.top.find(r => r.titled && r.stack && meet(r, c).credit < .5), lostWhy = lost && `The title names ${reqLabel(lost)}, which is not on your resume.`;
  if (lost) cap(60, lostWhy);
  const stackless = plan.stackless;
  // These caps read the weighted value; the reason says what is true by count.
  const thin = !n ? stackless : cov.missed.length * 2 > n ? "Most of its top must-haves are not on your resume." : cov.missed.length ? missedLine
    : listed.length ? listedLine : stale.length ? staleLine : onlyLine;
  if (cov.value < .5) cap(54, thin);
  else if (cov.value < .7 || cov.missed.length >= 2) cap(74, thin);
  if (!n && !(role >= .5)) cap(54, stackless);
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

  const degree = degreeFit(job.degree, p.degree), wanted = job.degree && DEGREE_NAME[job.degree.level];
  add("Degree", degree, !job.degree ? "No degree stated" : !p.degree ? "No degree found on your resume" : `${wanted} ${job.degree.req}`);
  if (degree === 0) gaps.push(`It lists ${article(wanted)} ${wanted} as required.`);

  // Hot needs evidence, not just silence.
  const known = (role != null) + (level != null) + (years != null), stated = (plan.role != null) + (plan.level != null) + (bar != null);
  if (!cov.confirmed) cap(60, n ? "None of its top must-haves are confirmed by your resume." : stackless);
  else if (cov.confirmed < 2) cap(65, n > 1 ? "Only one of its top must-haves is confirmed by your resume." : onlyLine);
  else if (cov.confirmed < 3 && cov.missed.length) cap(74, "Fewer than three of its top must-haves are confirmed by your resume.");
  else if (known < 2) cap(74, stated < 2 ? "It says too little about the role or level, so check the posting yourself."
    : "Your resume shows too little about your role or level, so check the posting yourself.");
  if (role == null && cov.missed.length) cap(74, !plan.role ? "Its title names no family, so check the posting yourself." : "Your resume shows no role family, so check the posting yourself.");

  const max = parts.reduce((s, x) => s + x.max, 0);
  const exact = max ? 100 * parts.reduce((s, x) => s + x.got, 0) / max : 0, raw = Math.round(exact);
  const low = caps.reduce((a, x) => (x[0] < a[0] ? x : a), [101, ""]);
  const held = raw > low[0] ? { at: low[0], why: low[1] } : null;
  // The binding reason comes first, and no gap after it says the same again: "names none of the skills" already says to check
  // the posting, and a missing skill the title names is the whole "Not on your resume" list when it's the only one.
  const said = held ? held.why.toLowerCase() : "";
  const repeats = g => said.includes(g.toLowerCase().slice(0, -1)) || (held?.why === NO_STACK && g === NO_LIST)
    || (lost && held?.why === lostWhy && cov.missed.length === 1 && g === missedLine);
  const shown = [...new Set([...(held ? [held.why] : []), ...gaps.filter(g => !repeats(g))])];
  const final = Math.min(raw, low[0]);
  return { score: final, tier: TIERS.find(t => final >= t[1])[0], parts, held, fits: fits.slice(0, 4), gaps: shown.slice(0, 3), next: next.slice(0, 3),
    tie: exact };
}

const wmatch = { score, buildStats, TIERS, levelOf };
if (typeof window !== "undefined") window.wmatch = wmatch;
if (typeof module !== "undefined") module.exports = wmatch;
})();
