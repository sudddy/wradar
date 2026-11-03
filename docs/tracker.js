"use strict";
// wradar tracker: Saved, Applied and Hidden, one per job, kept in this browser with a snapshot so a job that leaves the feed still shows.
const MINE_EMPTY = {
  all: "Nothing here yet. Use Save or Applied on a job to keep it here.",
  saved: "Nothing saved yet. Use Save on a job to keep it here.",
  applied: "Nothing marked as applied yet. Use Applied on a job to track it here.",
  hidden: "No hidden jobs.",
};
let tracker = {}, mineSeg = "all", toastTimer;

const mark = (t, j, s, at) => ({ ...t, [j.key]: { s, at, title: j.title, company: j.company, url: j.url, where: j.where, ...(s === "hidden" && t[j.key] && { was: t[j.key] }) } });
const unmark = (t, key) => { const rest = { ...t }; delete rest[key]; return rest; };
const putBack = (t, key, entry) => (entry ? { ...t, [key]: entry } : unmark(t, key));
const toggle = (t, j, s, at) => (t[j.key]?.s === s ? putBack(t, j.key, t[j.key].was) : mark(t, j, s, at));  // a hidden job comes back as it was
const mineRows = (t, seg, live) => Object.entries(t)
  .filter(([, e]) => (seg === "all" ? e.s !== "hidden" : e.s === seg))
  .sort((a, b) => b[1].at.localeCompare(a[1].at))
  .map(([key, e]) => live.get(key) || { ...e, key, delisted: true });

if (typeof module !== "undefined") module.exports = { mark, toggle, putBack, mineRows };

const statusOf = j => tracker[j.key]?.s || null;
const shortDate = iso => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const STATUS_TEXT = { applied: e => `Applied ${shortDate(e.at)}`, saved: () => "Saved", hidden: () => "Hidden" };
const statusText = j => (statusOf(j) ? STATUS_TEXT[statusOf(j)](tracker[j.key]) : "");

// Read again before every change, so a mark here never wipes one made in another tab.
const loadTracker = () => { tracker = store.get("wradar-tracker") || tracker; };

function commit(next) {
  tracker = next;
  store.set("wradar-tracker", tracker);
}

function renderCounts() {
  const unmarked = a => a.filter(j => statusOf(j) !== "hidden").length.toLocaleString();
  const count = seg => mineRows(tracker, seg, byKey).length.toLocaleString();
  $("#n-jobs").textContent = unmarked(D.jobs);
  $("#n-older").textContent = unmarked(D.older);
  [2, 3, 7].forEach(n => { $("#n-d" + n).textContent = unmarked(D.jobs.filter(j => within(j, n))); });
  $("#n-mine").textContent = $("#n-all").textContent = count("all");
  $("#n-saved").textContent = count("saved");
  $("#n-applied").textContent = count("applied");
  press("#mineseg", mineSeg);
  renderSteps();
}

function setMark(j, s) {
  closeToast();  // an Undo from before this mark would erase it
  loadTracker();
  commit(toggle(tracker, j, s, new Date().toISOString()));
  renderBoard();
  announce(statusText(j) || "Mark removed");
  $(`#detail [data-do="${s}"]`)?.focus({ preventScroll: true });
}

// The row leaves, the next one takes its place, and Undo brings back exactly what was there.
function hideJob(j) {
  loadTracker();
  if (statusOf(j) === "hidden") return setMark(j, "hidden");
  const before = tracker[j.key], at = rows.findIndex(r => r.key === j.key), next = rows[at + 1] || rows[at - 1], from = page;
  commit(mark(tracker, j, "hidden", new Date().toISOString()));
  moveTo(next?.key ?? null);
  announce("Job hidden");
  toast("Job hidden", () => {
    loadTracker();
    commit(putBack(tracker, j.key, before));
    if (page === from) { moveTo(j.key); focusBoard(); } else route();  // on another page, redraw it and leave its place alone
    announce("Job back in the list");
  });
}

function closeToast() {
  const el = $("#toast");
  if (el.hidden) return false;
  clearTimeout(toastTimer);
  const held = el.contains(document.activeElement);
  el.hidden = true;
  if (held) focusBoard();
  return true;
}

// Focus lands on Undo so the keyboard reaches it at once. The toast closes 8 seconds after a mouse or touch Hide,
// and waits while the pointer is on it or keyboard focus is on Undo.
function toast(text, undo) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(text)}</span><button type="button" class="linkbtn">Undo</button>`;
  el.hidden = false;
  const button = el.querySelector("button");
  const hold = () => clearTimeout(toastTimer), wait = () => { hold(); toastTimer = setTimeout(closeToast, 8000); };
  button.onclick = () => { closeToast(); undo(); };
  el.onpointerenter = button.onfocus = hold;
  el.onpointerleave = button.onblur = wait;
  button.focus({ preventScroll: true });
  if (!button.matches(":focus-visible")) wait();  // the browser shows a focus ring only to keyboard users
}
