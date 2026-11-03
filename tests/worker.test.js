"use strict";
// Scan now: the Cloudflare Worker against a mocked GitHub, and the button against a stub page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SITE = "https://sudddy.github.io";
const TOKEN = "github_pat_only_for_this_test";
const MIN = 6e4, HOUR = 36e5;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const runs = (...workflow_runs) => () => json({ workflow_runs });
const run = (status, msAgo) => ({ status, created_at: new Date(Date.now() - msAgo).toISOString() });
const noContent = () => new Response(null, { status: 204 });

// ---- Worker ----
// nextAt lives in the module, so each test imports its own copy. A data: URL is always an ES module,
// which a .js file is only on Node 20.19 and later.
const WORKER = encodeURIComponent(fs.readFileSync(path.join(ROOT, "worker/scan.js"), "utf8"));
let copies = 0;
const loadWorker = async () => (await import(`data:text/javascript,${WORKER}#${++copies}`)).default;

function mockGitHub(t, list, dispatch = noContent) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url, init });
    return url.endsWith("/dispatches") ? dispatch() : list();
  });
  return calls;
}

const send = (worker, { origin = SITE, method = "POST" } = {}) =>
  worker.fetch({ method, headers: new Headers(origin ? { Origin: origin } : {}) }, { GITHUB_TOKEN: TOKEN });

test("worker refuses other origins, and no origin at all", async t => {
  const calls = mockGitHub(t, runs());
  const worker = await loadWorker();
  for (const origin of ["https://evil.example", null]) {
    const res = await send(worker, { origin });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { state: "error" });
    assert.notEqual(res.headers.get("Access-Control-Allow-Origin"), origin);
  }
  assert.equal(calls.length, 0);
});

test("worker refuses anything but POST", async t => {
  const calls = mockGitHub(t, runs());
  const res = await send(await loadWorker(), { method: "GET" });
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { state: "error" });
  assert.equal(calls.length, 0);
});

test("worker answers preflight for the site only", async t => {
  const calls = mockGitHub(t, runs());
  const worker = await loadWorker();
  const ok = await send(worker, { method: "OPTIONS" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), SITE);
  assert.equal(ok.headers.get("Access-Control-Allow-Methods"), "POST");
  const bad = await send(worker, { method: "OPTIONS", origin: "https://evil.example" });
  assert.equal(bad.status, 403);
  assert.notEqual(bad.headers.get("Access-Control-Allow-Origin"), "https://evil.example");
  assert.equal(calls.length, 0);
});

test("worker reports a run in progress with its start time", async t => {
  for (const status of ["queued", "in_progress"]) {
    const started = run(status, 2 * MIN);
    const calls = mockGitHub(t, runs(started));
    const res = await send(await loadWorker());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "running", since: started.created_at });
    assert.equal(calls.length, 1);
    globalThis.fetch.mock.restore();
  }
});

test("worker cools down when the last run is under an hour old", async t => {
  const calls = mockGitHub(t, runs(run("completed", 18 * MIN)));
  const res = await send(await loadWorker());
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.state, "cooldown");
  assert.ok(Math.abs(body.retry_after - 42 * 60) <= 1, String(body.retry_after));
  assert.equal(calls.length, 1);
});

test("worker sets the token and User-Agent GitHub requires, and dispatches main", async t => {
  const calls = mockGitHub(t, runs(run("completed", 2 * HOUR)));
  const res = await send(await loadWorker());
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { state: "started" });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/api\.github\.com\/repos\/sudddy\/wradar\/actions\/workflows\/fetch-jobs\.yml\/runs\?per_page=1$/);
  assert.match(calls[1].url, /^https:\/\/api\.github\.com\/repos\/sudddy\/wradar\/actions\/workflows\/fetch-jobs\.yml\/dispatches$/);
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), { ref: "main" });
  for (const { init } of calls) {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(init.headers["User-Agent"]);
  }
});

test("worker dispatches when there are no runs at all", async t => {
  const calls = mockGitHub(t, runs());
  const res = await send(await loadWorker());
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { state: "started" });
  assert.equal(calls.length, 2);
});

test("worker reports a GitHub error on the run list and does not dispatch", async t => {
  const calls = mockGitHub(t, () => json({ message: "Bad credentials" }, 401));
  const res = await send(await loadWorker());
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { state: "error" });
  assert.equal(calls.length, 1);
});

test("worker reports a GitHub error on dispatch and stays open to another click", async t => {
  const calls = mockGitHub(t, runs(), () => json({ message: "Server Error" }, 500));
  const worker = await loadWorker();
  const res = await send(worker);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { state: "error" });
  await send(worker);
  assert.deepEqual(calls.map(c => c.url.split("/").pop()), ["runs?per_page=1", "dispatches", "dispatches"]);  // the run list is a minute fresh
});

test("worker reports GitHub being unreachable as JSON", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const res = await send(await loadWorker());
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { state: "error" });
});

test("a second click right after Scan now reads as the run it started, with no GitHub call", async t => {
  const calls = mockGitHub(t, runs());
  const worker = await loadWorker();
  assert.equal((await send(worker)).status, 202);
  const made = calls.length;
  const res = await send(worker);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state, "running");
  assert.ok(Math.abs(Date.parse(body.since) - Date.now()) < 1000, body.since);
  assert.equal(calls.length, made);
});

// GitHub's answer changes as the test goes on; the clock moves only on tick.
function mockLatest(t, first) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let latest = first;
  const calls = mockGitHub(t, () => json({ workflow_runs: latest ? [latest] : [] }));
  return { calls, set: next => { latest = next; } };
}

test("a run the Worker started reads as running until it ends, then the cooldown starts", async t => {
  const github = mockLatest(t, run("completed", 2 * HOUR));
  const worker = await loadWorker();
  assert.equal((await send(worker)).status, 202);
  const started = run("in_progress", 0);
  github.set(started);
  t.mock.timers.tick(MIN);
  const res = await send(worker);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { state: "running", since: started.created_at });
  github.set({ ...run("completed", 0), created_at: new Date(Date.now() - MIN).toISOString() });
  t.mock.timers.tick(9 * MIN);
  const done = await send(worker);
  assert.equal(done.status, 429);
  assert.equal((await done.json()).retry_after, 50 * 60);
  assert.equal(github.calls.length, 4);
});

test("a scheduled run that starts inside the cooldown reads as running", async t => {
  const github = mockLatest(t, run("completed", 18 * MIN));
  const worker = await loadWorker();
  assert.equal((await send(worker)).status, 429);
  const scheduled = run("in_progress", 0);
  github.set(scheduled);
  t.mock.timers.tick(MIN);
  const res = await send(worker);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { state: "running", since: scheduled.created_at });
});

test("during a run or a cooldown, GitHub is asked at most once a minute however many clicks arrive", async t => {
  for (const latest of [run("in_progress", 2 * MIN), run("completed", 18 * MIN)]) {
    const github = mockLatest(t, latest);
    const worker = await loadWorker();
    for (let n = 0; n < 50; n++) await send(worker);
    assert.equal(github.calls.length, 1);
    t.mock.timers.tick(MIN);
    for (let n = 0; n < 50; n++) await send(worker);
    assert.equal(github.calls.length, 2);
    globalThis.fetch.mock.restore();
    t.mock.timers.reset();
  }
});

test("the token appears in no response, even when GitHub echoes it", async t => {
  const echo = status => () => new Response(`Bad token ${TOKEN}`, { status });
  const cases = [
    [echo(401)],
    [runs(), echo(500)],
    [runs()],
    [runs(run("in_progress", MIN))],
    [runs(run("completed", MIN))],
  ];
  for (const [list, dispatch] of cases) {
    mockGitHub(t, list, dispatch);
    const worker = await loadWorker();
    for (const options of [{}, {}, { method: "GET" }, { method: "OPTIONS" }, { origin: "https://evil.example" }]) {
      const res = await send(worker, options);
      assert.ok(!(await res.text()).includes(TOKEN));
      assert.ok(![...res.headers.values()].some(v => v.includes(TOKEN)));
    }
    globalThis.fetch.mock.restore();
  }
});

// ---- Button ----
const NOW = Date.parse("2026-11-02T20:00:00Z");
const GENERATED = "2026-11-02T18:00:00.000000+00:00";
const NEWER = "2026-11-02T20:03:00.000000+00:00";
const URL_ = "https://wradar-scan.example.workers.dev/";
const SOURCE = fs.readFileSync(path.join(ROOT, "docs/scan.js"), "utf8");

const started = () => json({ state: "started" });
const unchanged = () => json({ generated_at: GENERATED });

function openPage(t, { scan_url = URL_, post = started, scan = unchanged, jobs = () => new Response(""), generated_at = GENERATED } = {}) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const button = { hidden: true, disabled: false, textContent: "", onclick: null };
  const updated = { textContent: "Scanned today", style: {} };
  const calls = [];
  let reloads = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, label: button.textContent });
    if (url === URL_) return post();
    return url === "scan.json" ? scan() : jobs();
  };
  vm.runInNewContext(SOURCE + "\ninitScan();", {
    $: s => ({ "#scan": button, "#updated": updated })[s],
    D: { generated_at, rules: { scan_url } },
    plural: (n, w) => `${n} ${n === 1 ? w : w + "s"}`,
    ago: () => "3 days ago",
    fetch, setInterval, clearInterval, Date,
    location: { reload: () => { reloads++; } },
  });
  const settle = () => new Promise(setImmediate);
  const wait = async ms => {
    for (let left = ms; left > 0; left -= 30000) {
      t.mock.timers.tick(Math.min(30000, left));
      await settle();
    }
  };
  const click = async () => { await button.onclick(); await settle(); };
  const count = url => calls.filter(c => c.url === url).length;
  return { button, updated, calls, click, wait, count, reloads: () => reloads };
}

test("docs/scan.js runs nothing at load, so app.js globals need not exist yet", () => {
  assert.doesNotThrow(() => vm.runInNewContext(SOURCE, {}));
});

test("button stays hidden without a scan_url, and nothing is called", t => {
  for (const scan_url of ["", null]) {
    const page = openPage(t, { scan_url });
    assert.equal(page.button.hidden, true);
    assert.equal(page.calls.length, 0);
    t.mock.timers.reset();
  }
});

test("idle: Scan now, enabled, and the Worker is only called on click", t => {
  const page = openPage(t);
  assert.equal(page.button.hidden, false);
  assert.equal(page.button.textContent, "Scan now");
  assert.equal(page.button.disabled, false);
  assert.equal(page.calls.length, 0);
});

test("scanning: POSTs once and counts up, disabled", async t => {
  const page = openPage(t);
  await page.click();
  assert.equal(page.count(URL_), 1);
  assert.equal(page.calls[0].init.method, "POST");
  assert.equal(page.button.textContent, "Scanning… 0:00");
  assert.equal(page.button.disabled, true);
  await page.wait(134000);
  assert.equal(page.button.textContent, "Scanning… 2:14");
  assert.equal(page.button.disabled, true);
});

test("the button is disabled while the POST is in flight", async t => {
  let answer;
  const page = openPage(t, { post: () => new Promise(ok => { answer = ok; }) });
  const clicked = page.button.onclick();
  assert.equal(page.button.disabled, true);
  answer(json({ state: "started" }));
  await clicked;
});

test("running: the clock starts from since", async t => {
  const since = new Date(NOW - 134000).toISOString();
  const page = openPage(t, { post: () => json({ state: "running", since }) });
  await page.click();
  assert.equal(page.button.textContent, "Scanning… 2:14");
  await page.wait(1000);
  assert.equal(page.button.textContent, "Scanning… 2:15");
});

test("polls scan.json every 30 seconds without the cache", async t => {
  const page = openPage(t);
  await page.click();
  assert.equal(page.count("scan.json"), 0);
  await page.wait(29000);
  assert.equal(page.count("scan.json"), 0);
  await page.wait(1000);
  assert.equal(page.count("scan.json"), 1);
  await page.wait(90000);
  assert.equal(page.count("scan.json"), 4);
  for (const c of page.calls.filter(c => c.url === "scan.json")) assert.equal(c.init.cache, "no-store");
  assert.equal(page.count("jobs.js"), 0);
});

test("still scanning past 15 minutes, keeps polling, stops by 30, and offers nothing further", async t => {
  const page = openPage(t);
  await page.click();
  await page.wait(15 * MIN - 1000);
  assert.equal(page.button.textContent, "Scanning… 14:59");
  await page.wait(1000);
  assert.equal(page.button.textContent, "Still scanning");
  assert.equal(page.button.disabled, true);
  const before = page.count("scan.json");
  await page.wait(10 * MIN);
  assert.equal(page.count("scan.json"), before + 20);
  await page.wait(20 * MIN);
  const last = page.count("scan.json");
  assert.ok(last <= 60, String(last));
  await page.wait(30 * MIN);
  assert.equal(page.count("scan.json"), last);
  assert.equal(page.button.textContent, "Still scanning");
  assert.equal(page.button.disabled, true);
});

test("a run that began long ago stops polling sooner: the limit counts from since", async t => {
  const since = new Date(NOW - 29 * MIN).toISOString();
  const page = openPage(t, { post: () => json({ state: "running", since }) });
  await page.click();
  assert.equal(page.button.textContent, "Still scanning");
  await page.wait(10 * MIN);
  assert.ok(page.count("scan.json") <= 2, String(page.count("scan.json")));
});

test("a run that began long ago still offers the reload if its jobs are out", async t => {
  const since = new Date(NOW - 40 * MIN).toISOString();
  const page = openPage(t, { post: () => json({ state: "running", since }), scan: () => json({ generated_at: NEWER }) });
  await page.click();
  await page.wait(30000);
  assert.equal(page.button.textContent, "New jobs ready. Reload");
});

test("a failed poll is ignored and polling carries on", async t => {
  let polls = 0;
  const scan = () => {
    if (++polls === 1) throw new TypeError("offline");
    return polls === 2 ? new Response("<html>not found</html>", { status: 404 }) : json({ generated_at: NEWER });
  };
  const page = openPage(t, { scan });
  await page.click();
  await page.wait(60000);
  assert.match(page.button.textContent, /^Scanning…/);
  await page.wait(30000);
  assert.equal(page.button.textContent, "New jobs ready. Reload");
});

test("ready: refreshes jobs.js first, then offers a reload, then stops", async t => {
  const page = openPage(t, { scan: () => json({ generated_at: NEWER }) });
  await page.click();
  await page.wait(30000);
  const refresh = page.calls.find(c => c.url === "jobs.js");
  assert.equal(refresh.init.cache, "reload");
  assert.match(refresh.label, /^Scanning…/);
  assert.equal(page.button.textContent, "New jobs ready. Reload");
  assert.equal(page.button.disabled, false);
  const polls = page.count("scan.json");
  await page.wait(5 * MIN);
  assert.equal(page.count("scan.json"), polls);
  assert.equal(page.button.textContent, "New jobs ready. Reload");
  page.button.onclick();
  assert.equal(page.reloads(), 1);
  assert.equal(page.count(URL_), 1);
});

test("a failed jobs.js refresh does not offer the reload yet", async t => {
  let tries = 0;
  const jobs = () => { if (++tries === 1) throw new TypeError("offline"); return new Response(""); };
  const page = openPage(t, { jobs, scan: () => json({ generated_at: NEWER }) });
  await page.click();
  await page.wait(30000);
  assert.match(page.button.textContent, /^Scanning…/);
  await page.wait(30000);
  assert.equal(page.button.textContent, "New jobs ready. Reload");
});

const cooldown = () => json({ state: "cooldown", retry_after: 42 * 60 }, 429);

test("cooling down: checks scan.json once, shows the wait, disabled, then returns to idle", async t => {
  const page = openPage(t, { post: cooldown });
  await page.click();
  assert.equal(page.button.textContent, "Next scan in 42 min");
  assert.equal(page.button.disabled, true);
  await page.wait(MIN);
  assert.equal(page.button.textContent, "Next scan in 41 min");
  assert.equal(page.count("scan.json"), 1);
  await page.wait(41 * MIN);
  assert.equal(page.button.textContent, "Scan now");
  assert.equal(page.button.disabled, false);
  assert.equal(page.count("scan.json"), 1);
});

test("cooling down with newer jobs already published offers the reload", async t => {
  const page = openPage(t, { post: cooldown, scan: () => json({ generated_at: NEWER }) });
  await page.click();
  assert.equal(page.calls.find(c => c.url === "jobs.js").init.cache, "reload");
  assert.equal(page.button.textContent, "New jobs ready. Reload");
  assert.equal(page.button.disabled, false);
  page.button.onclick();
  assert.equal(page.reloads(), 1);
});

test("cooling down still shows the wait when scan.json can't be read", async t => {
  const page = openPage(t, { post: cooldown, scan: () => { throw new TypeError("offline"); } });
  await page.click();
  assert.equal(page.button.textContent, "Next scan in 42 min");
});

test("worker error: Scan didn't start, with the age of the data and no Retry", async t => {
  const page = openPage(t, { post: () => json({ state: "error" }, 502) });
  await page.click();
  assert.equal(page.button.textContent, "Scan didn't start");
  assert.equal(page.button.disabled, true);
  assert.equal(page.updated.textContent, "You're still seeing jobs from 2 hours ago");
  assert.equal(page.updated.style.display, "inline");
  await page.wait(40 * MIN);
  assert.equal(page.count("scan.json"), 0);
  assert.equal(page.button.textContent, "Scan didn't start");
});

test("a network failure or a non-JSON answer also reads as Scan didn't start", async t => {
  const failures = [
    () => { throw new TypeError("Failed to fetch"); },
    () => new Response("<html>error 1027</html>", { status: 500 }),
    () => json({ state: "surprise" }),
  ];
  for (const post of failures) {
    const page = openPage(t, { post });
    await page.click();
    assert.equal(page.button.textContent, "Scan didn't start");
    assert.equal(page.button.disabled, true);
    t.mock.timers.reset();
  }
});

test("the note reads naturally at every data age", async t => {
  const ages = [
    [30 * MIN, "You're still seeing jobs from less than an hour ago"],
    [HOUR, "You're still seeing jobs from 1 hour ago"],
    [23 * HOUR, "You're still seeing jobs from 23 hours ago"],
    [24 * HOUR, "You're still seeing jobs from 3 days ago"],
  ];
  for (const [old, note] of ages) {
    const page = openPage(t, { generated_at: new Date(NOW - old).toISOString(), post: () => json({ state: "error" }) });
    await page.click();
    assert.equal(page.updated.textContent, note);
    t.mock.timers.reset();
  }
});
