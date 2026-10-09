import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { manifestVersions, releaseArguments } from "./publish-release.mjs";

const env = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.0.0",
  GITHUB_SHA: "b".repeat(40), GITHUB_REPOSITORY: "115dkk/NvStrapsReBar-Tauri" };
const versions = { package: "1.0.0", tauri: "1.0.0", cargo: "1.0.0" };

test("publishes the tagged commit as the latest release with the checked-in notes", () => {
  const args = releaseArguments(env, versions);
  assert.equal(args[2], "v1.0.0");
  assert.equal(args[args.indexOf("--target") + 1], env.GITHUB_SHA);
  assert.equal(args[args.indexOf("--title") + 1], "NvStrapsReBar 1.0.0");
  assert.equal(args[args.indexOf("--notes-file") + 1], "docs/releases/v1.0.0.md");
  assert.ok(args.includes("--latest"));
  assert.ok(args.includes("--verify-tag"));
  assert.ok(!args.includes("--prerelease"));
  assert.ok(!args.includes("--clobber"));
  assert.equal(args[3], "release-files/NvStrapsReBar-windows-x64.zip");
  assert.equal(args[4], "release-files/NvStrapsReBar-windows-x64-setup.exe");
  assert.equal(args[5], "release-files/SHA256SUMS.txt");
});
test("rejects branches, pull requests, odd tags and malformed identity", () => {
  for (const patch of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/master" }, { GITHUB_REF: "refs/tags/pre-1.1-bbbbbbbb" },
    { GITHUB_REF: "refs/tags/v1.0" }, { GITHUB_REF: "refs/tags/v1.0.0-rc1" },
    { GITHUB_SHA: "v1.0.0" }, { GITHUB_REPOSITORY: "--bad" }]) {
    assert.throws(() => releaseArguments({ ...env, ...patch }, versions), JSON.stringify(patch));
  }
});
test("the tag must match every manifest version", () => {
  for (const name of Object.keys(versions)) {
    assert.throws(() => releaseArguments(env, { ...versions, [name]: "0.9.0" }), new RegExp(name));
    assert.throws(() => releaseArguments(env, { ...versions, [name]: undefined }), new RegExp(name));
  }
});
test("the checked-in manifests agree with each other and have release notes", () => {
  const found = manifestVersions();
  assert.equal(found.tauri, found.package);
  assert.equal(found.cargo, found.package);
  assert.match(found.package, /^\d+\.\d+\.\d+$/);
  const notes = readFileSync(new URL(`../docs/releases/v${found.package}.md`, import.meta.url), "utf8");
  assert.match(notes, new RegExp(`^# NvStrapsReBar ${found.package.replaceAll(".", "\\.")}`, "m"));
});
test("the stable release job builds the tag and runs after the tested artifacts", () => {
  const workflow = readFileSync(new URL("../.github/workflows/Tauri.yml", import.meta.url), "utf8");
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(workflow, /if: github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /node tools\/publish-release.mjs/);
  assert.equal((workflow.match(/needs: \[frontend, native-windows\]/g) ?? []).length, 2);
});
