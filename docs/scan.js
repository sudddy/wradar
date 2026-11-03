"use strict";
// Scan now: asks the Worker to start a scan, then waits for scan.json to show newer data.
function scanShow(label, disabled = true) {
  const button = $("#scan");
  button.textContent = label;
  button.disabled = disabled;
}

function scanClock(ms) {
  return `${Math.floor(ms / 6e4)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}

function scanDataAge() {
  const hours = Math.floor((Date.now() - new Date(D.generated_at)) / 36e5);
  return hours < 1 ? "less than an hour ago" : hours < 24 ? plural(hours, "hour") + " ago" : ago(D.generated_at);
}

function scanFailed() {
  scanShow("Scan didn't start");
  const note = $("#updated");
  note.textContent = `You're still seeing jobs from ${scanDataAge()}`;
  note.style.display = "inline";  // .scanned is hidden on phones, where this still has to show
}

function scanReady() {
  scanShow("New jobs ready. Reload", false);
  $("#scan").onclick = () => location.reload();
}

function scanCooldown(seconds) {
  const until = Date.now() + seconds * 1000;
  const paint = () => {
    const left = until - Date.now();
    if (left > 0) return scanShow(`Next scan in ${Math.ceil(left / 6e4)} min`);
    clearInterval(clock);
    scanShow("Scan now", false);
  };
  const clock = setInterval(paint, 1000);
  paint();
}

// True once scan.json is newer than the loaded data and jobs.js is fetched again, so Reload gets the new file.
async function scanHasNewData() {
  const scan = await (await fetch("scan.json", { cache: "no-store" })).json();
  if (new Date(scan.generated_at) <= new Date(D.generated_at)) return false;
  await fetch("jobs.js", { cache: "reload" });
  return true;
}

function scanWatch(since) {
  const elapsed = () => Math.max(0, Date.now() - since);
  const paint = () => scanShow(elapsed() < 15 * 6e4 ? `Scanning… ${scanClock(elapsed())}` : "Still scanning");
  const stop = () => { clearInterval(clock); clearInterval(poll); };
  const check = async () => {  // looks once more before giving up, since the jobs may be out already
    try {
      if (await scanHasNewData()) { stop(); return scanReady(); }
    } catch {}  // a missed poll is not news: try again on the next one
    if (elapsed() >= 30 * 6e4) stop();
  };
  const clock = setInterval(paint, 1000), poll = setInterval(check, 30000);
  paint();
}

async function scanStart() {
  $("#scan").disabled = true;
  try {
    const { state, since, retry_after } = await (await fetch(D.rules.scan_url, { method: "POST" })).json();
    if (state === "started" || state === "running") return scanWatch(since ? Date.parse(since) : Date.now());
    if (state === "cooldown") return (await scanHasNewData().catch(() => false)) ? scanReady() : scanCooldown(retry_after);  // a tab open for hours may be behind already
  } catch {}
  scanFailed();
}

function initScan() {
  const button = $("#scan");
  button.hidden = !D.rules.scan_url;
  if (button.hidden) return;
  button.onclick = scanStart;
  scanShow("Scan now", false);
}
