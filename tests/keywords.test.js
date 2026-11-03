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

test("a Python-only regex is caught", () => {
  assert.throws(() => compile("re:(?P<go>Go)"), SyntaxError);
  assert.throws(() => new RegExp("(?P<go>Go)", "i"), SyntaxError);
});

for (const [from, kw] of [["keywords.json", JSON.parse(read("keywords.json"))], ["docs/jobs.js", D.keywords]]) {
  test(`every alias in ${from} compiles`, () => {
    const all = aliases(kw);
    assert.ok(all.length > 100, `only ${all.length} aliases`);
    for (const a of all) assert.doesNotThrow(() => compile(a), a);
  });
}

test("mobile skills are read as whole words, without the common false hits", () => {
  const kw = JSON.parse(read("keywords.json"));
  const found = s => Object.entries(kw).filter(([k, a]) => !k.startsWith("_") && a.some(x => compile(x).test(s))).map(([k]) => k).sort();
  assert.deepEqual(found("Ship native iOS apps in Swift, SwiftUI and UIKit, with some Objective-C/C++."), ["C++", "Objective-C", "Swift", "SwiftUI", "UIKit", "iOS"]);
  assert.deepEqual(found("Android apps in Kotlin and Jetpack Compose."), ["Android", "Jetpack Compose", "Kotlin"]);
  assert.deepEqual(found("Flash the BIOS, wire the sensor IOs and compose a summary."), []);
});

for (const name of ["levels", "families"]) {
  test(`every rules.${name} pattern compiles`, () => {
    const rules = D.rules[name];
    assert.ok(rules.length > 2, `only ${rules.length} rules`);
    for (const [label, rx] of rules) assert.doesNotThrow(() => new RegExp(rx, "i"), label);
  });
}
