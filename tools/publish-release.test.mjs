import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import { manifestVersion } from "./release-plan.mjs";
import { RELEASE_FILES, commandText, releaseArguments, releaseIdentity } from "./publish-release.mjs";

const env = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master",
  GITHUB_SHA: "b".repeat(40), GITHUB_REPOSITORY: "115dkk/NvStrapsReBar-Tauri", RELEASE_VERSION: "1.0.1" };

test("publishes the bump commit as the latest release with the built files", () => {
  const identity = releaseIdentity(env);
  assert.deepEqual(identity, { version: "1.0.1", tag: "v1.0.1", sha: env.GITHUB_SHA, repo: env.GITHUB_REPOSITORY });
  const args = releaseArguments(identity, { target: "c".repeat(40), notesFile: null });
  assert.equal(args[2], "v1.0.1");
  assert.deepEqual(args.slice(3, 6), RELEASE_FILES);
  assert.equal(args[args.indexOf("--target") + 1], "c".repeat(40));
  assert.equal(args[args.indexOf("--title") + 1], "NvStrapsReBar 1.0.1");
  assert.ok(args.includes("--latest"));
  assert.ok(args.includes("--generate-notes"));
  assert.ok(!args.includes("--prerelease"));
  assert.ok(!args.includes("--clobber"));
  const withNotes = releaseArguments(identity, { target: "c".repeat(40), notesFile: "docs/releases/v1.0.1.md" });
  assert.equal(withNotes[withNotes.indexOf("--notes-file") + 1], "docs/releases/v1.0.1.md");
  assert.ok(!withNotes.includes("--generate-notes"));
});

test("rejects branches, pull requests, bad versions and malformed identity", () => {
  for (const patch of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_REF: "refs/tags/v1.0.1" }, { RELEASE_VERSION: "1.0" },
    { RELEASE_VERSION: "v1.0.1" }, { RELEASE_VERSION: "" }, { GITHUB_SHA: "master" }, { GITHUB_REPOSITORY: "--bad" }]) {
    assert.throws(() => releaseIdentity({ ...env, ...patch }), JSON.stringify(patch));
  }
});

test("the checked-in release notes for the manifest version start with the release heading", () => {
  const version = manifestVersion();
  const notes = `docs/releases/v${version}.md`;
  if (existsSync(notes)) {
    assert.match(readFileSync(notes, "utf8"), new RegExp(`^# NvStrapsReBar ${version.replaceAll(".", "\\.")}`, "m"));
  }
});

/** Workflow text with LF endings, so a CRLF checkout reads the same as CI. */
const workflowText = (file) =>
  readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

/** The lines of one top-level job, up to the next job. */
const jobText = (workflow, job) => workflow.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0] ?? "";

test("a master push only releases: the plan gates on the pull request, then Windows builds and publishes", () => {
  const workflow = workflowText("Release.yml");
  assert.match(workflow, /^on:\n {2}push:\n {4}branches: \["master"\]\n\n/m, "only master pushes start a release");
  assert.ok(!workflow.includes("pull_request:") && !workflow.includes("tags:"));
  assert.match(workflow, /group: master-release\n {2}cancel-in-progress: false/);
  const plan = jobText(workflow, "plan");
  assert.match(plan, /node tools\/release-plan\.mjs/);
  assert.match(plan, /if: steps\.release\.outputs\.release == 'true'\n(?:.*\n)*? {8}run: node tools\/release-gate\.mjs/);
  assert.match(plan, /actions: read/);
  assert.match(plan, /pull-requests: read/);
  const release = jobText(workflow, "release");
  assert.match(release, /needs: plan\n {4}if: needs\.plan\.outputs\.release == 'true'/);
  assert.match(release, /node tools\/apply-version\.mjs \$\{\{ needs\.plan\.outputs\.release-version \}\}/);
  assert.match(release, /npm run build:firmware[\s\S]*npm run tauri:ci[\s\S]*scripts\/build-installer\.ps1[\s\S]*node tools\/publish-release\.mjs/);
  for (const check of ["cargo test", "cargo clippy", "cargo fmt", "npm run check", "test:e2e", "check:riir"]) {
    assert.ok(!workflow.includes(check), `the release does not run ${check} again`);
  }
  assert.ok(!workflow.includes("upload-artifact") && !workflow.includes("download-artifact"),
    "release files never go through the artifact store");
  assert.ok(!workflow.includes("publish-prerelease"));
});

test("the Tauri workflow validates pull requests, with a docs job that runs whatever the scope", () => {
  const workflow = workflowText("Tauri.yml");
  assert.ok(!workflow.includes("release-plan") && !workflow.includes("publish-release"), "validation never releases");
  const docs = jobText(workflow, "docs");
  assert.ok(docs, "a docs job exists");
  assert.ok(!docs.includes("needs:") && !docs.includes("if:"), "the docs job runs on every event, heavy or not");
  assert.match(docs, /npm run check:docs/);
  assert.match(docs, /npm run check:ci-scope/);
  assert.ok(!docs.includes("npm ci"), "the docs job needs no dependency install");
  assert.match(jobText(workflow, "native-windows"), /scripts\/build-installer\.ps1/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  for (const upload of workflow.split("uses: actions/upload-artifact").slice(1)) {
    assert.match(upload.split("- name")[0], /retention-days: 7/);
  }
});

test("a command that prints straight to the log, like the version push, yields empty text", () => {
  const inherited = execFileSync(process.execPath, ["-e", ""], { encoding: "utf8", stdio: "inherit" });
  assert.equal(inherited, null);
  assert.equal(commandText(inherited), "");
  assert.equal(commandText("0123abcd\r\n"), "0123abcd");
});
