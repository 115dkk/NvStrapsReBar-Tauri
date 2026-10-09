import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MANIFESTS, applyVersion, rewriteManifests, workspaceMembers } from "./apply-version.mjs";

const fixtures = new Map([
  ["package.json", '{\n  "name": "x",\n  "version": "1.0.0",\n  "type": "module"\n}\n'],
  ["package-lock.json", '{\n  "name": "x",\n  "version": "1.0.0",\n  "packages": {\n    "": {\n      "name": "x",\n      "version": "1.0.0",\n      "dependencies": {\n        "react": "19.2.8"\n      }\n    },\n    "node_modules/react": {\n      "version": "1.0.0"\n    }\n  }\n}\n'],
  ["src-tauri/tauri.conf.json", '{\n  "productName": "NvStrapsReBar",\n  "version": "1.0.0",\n  "build": {}\n}\n'],
  ["installer/NvStrapsReBar.iss", ';   iscc /DAppVersion=1.0.0 installer\\NvStrapsReBar.iss\n; AppVersion defaults to 1.0.0 (CI passes the Tauri version); SourceDir defaults to target\\release.\n#ifndef AppVersion\n  #define AppVersion "1.0.0"\n#endif\n'],
  ["crates/a/Cargo.toml", '[package]\nname = "a"\nversion = "1.0.0"\nedition.workspace = true\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\n'],
]);

test("rewrites only the version fields and keeps dependency versions", () => {
  const out = rewriteManifests("1.2.3", fixtures);
  assert.equal(JSON.parse(out.get("package.json")).version, "1.2.3");
  const lock = JSON.parse(out.get("package-lock.json"));
  assert.equal(lock.version, "1.2.3");
  assert.equal(lock.packages[""].version, "1.2.3");
  assert.equal(lock.packages["node_modules/react"].version, "1.0.0");
  assert.equal(lock.packages[""].dependencies.react, "19.2.8");
  assert.equal(JSON.parse(out.get("src-tauri/tauri.conf.json")).version, "1.2.3");
  assert.match(out.get("crates/a/Cargo.toml"), /^version = "1\.2\.3"$/m);
  assert.match(out.get("crates/a/Cargo.toml"), /serde = \{ version = "1"/);
  assert.match(out.get("installer/NvStrapsReBar.iss"), /#define AppVersion "1\.2\.3"/);
  assert.match(out.get("installer/NvStrapsReBar.iss"), /DAppVersion=1\.2\.3/);
  assert.match(out.get("installer/NvStrapsReBar.iss"), /defaults to 1\.2\.3/);
});

test("a Windows checkout with CRLF endings is rewritten the same way and keeps its endings", () => {
  const crlf = new Map([...fixtures].map(([path, text]) => [path, text.replaceAll("\n", "\r\n")]));
  const out = rewriteManifests("1.2.3", crlf);
  assert.equal(JSON.parse(out.get("package.json")).version, "1.2.3");
  const lock = JSON.parse(out.get("package-lock.json"));
  assert.equal(lock.version, "1.2.3");
  assert.equal(lock.packages[""].version, "1.2.3");
  assert.match(out.get("crates/a/Cargo.toml"), /^version = "1\.2\.3"\r$/m);
  assert.match(out.get("installer/NvStrapsReBar.iss"), /#define AppVersion "1\.2\.3"\r/);
  for (const text of out.values()) {
    assert.ok(!/[^\r]\n/.test(text), "every line still ends with CRLF");
  }
  // Rewriting to the version the files already carry changes nothing, CRLF or not.
  for (const [path, text] of rewriteManifests("1.0.0", crlf)) {
    assert.equal(text, crlf.get(path), path);
  }
});

test("rejects versions that are not semantic and files without a version", () => {
  assert.throws(() => rewriteManifests("1.2", fixtures), /not <major>/);
  assert.throws(() => rewriteManifests("1.2.3", new Map([["crates/b/Cargo.toml", "[package]\nname = \"b\"\n"]])), /no version field/);
  assert.throws(() => rewriteManifests("1.2.3", new Map([["weird.txt", "x"]])), /not a manifest/);
});

test("reads the workspace members from the root manifest", () => {
  assert.deepEqual(
    workspaceMembers('[workspace]\nmembers = [\n    "crates/a",\n    "src-tauri",\n]\nresolver = "3"\n'),
    ["crates/a/Cargo.toml", "src-tauri/Cargo.toml"],
  );
  assert.ok(workspaceMembers(readFileSync("Cargo.toml", "utf8")).includes("src-tauri/Cargo.toml"));
});

test("applyVersion writes the changed files and re-syncs Cargo.lock once", () => {
  const written = [];
  const execs = [];
  const files = new Map([...fixtures, ["Cargo.toml", '[workspace]\nmembers = [\n    "crates/a",\n]\n']]);
  const changed = applyVersion("1.2.3", {
    readFile: (path) => files.get(path),
    writeFile: (path, text) => written.push([path, text]),
    exec: (command, args) => execs.push([command, ...args]),
  });
  assert.deepEqual(changed, [...MANIFESTS, "crates/a/Cargo.toml", "Cargo.lock"]);
  assert.deepEqual(execs, [["cargo", "update", "--workspace"]]);
  assert.equal(written.length, 5);

  const unchanged = applyVersion("1.0.0", {
    readFile: (path) => files.get(path),
    writeFile: () => assert.fail("nothing should be written"),
    exec: () => assert.fail("cargo should not run"),
  });
  assert.deepEqual(unchanged, []);
});

test("the checked-in manifests rewrite cleanly to their own version", () => {
  const read = (path) => readFileSync(path, "utf8");
  const members = workspaceMembers(read("Cargo.toml"));
  const files = new Map([...MANIFESTS, ...members].map((path) => [path, read(path)]));
  const current = JSON.parse(files.get("package.json")).version;
  for (const [path, text] of rewriteManifests(current, files)) {
    assert.equal(text, files.get(path), path);
  }
});
