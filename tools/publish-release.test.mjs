import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import { manifestVersion } from "./release-plan.mjs";
import { RELEASE_FILES, SIBLING_WORKFLOWS, releaseArguments, releaseIdentity, siblingState } from "./publish-release.mjs";

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

test("the release waits for every sibling workflow and stops on a failure", () => {
  const ok = (workflowName) => ({ workflowName, status: "completed", conclusion: "success" });
  assert.deepEqual(siblingState(SIBLING_WORKFLOWS.map(ok)), { state: "success" });
  assert.deepEqual(siblingState([ok("Miri")]), { state: "pending" });
  assert.deepEqual(siblingState([ok("Miri"), { workflowName: "Rust UEFI validation", status: "in_progress", conclusion: null }]), { state: "pending" });
  assert.deepEqual(siblingState([ok("Miri"), { workflowName: "Rust UEFI validation", status: "completed", conclusion: "failure" }]), { state: "failed", workflow: "Rust UEFI validation" });
  assert.deepEqual(siblingState([ok("Miri"), { workflowName: "Rust UEFI validation", status: "completed", conclusion: "cancelled" }]), { state: "failed", workflow: "Rust UEFI validation" });
  // A rerun that succeeded after an earlier failure still counts as failed until the failed run is gone.
  assert.equal(siblingState([ok("Miri"), ok("Rust UEFI validation"), { workflowName: "Miri", status: "completed", conclusion: "failure" }]).state, "failed");
});

test("the checked-in release notes for the manifest version start with the release heading", () => {
  const version = manifestVersion();
  const notes = `docs/releases/v${version}.md`;
  if (existsSync(notes)) {
    assert.match(readFileSync(notes, "utf8"), new RegExp(`^# NvStrapsReBar ${version.replaceAll(".", "\\.")}`, "m"));
  }
});

test("the workflow releases from the Windows job after the frontend job, without the artifact store", () => {
  const workflow = readFileSync(new URL("../.github/workflows/Tauri.yml", import.meta.url), "utf8");
  assert.ok(!workflow.includes("tags:"), "tag pushes no longer trigger releases");
  assert.ok(!workflow.includes("download-artifact"));
  assert.ok(!workflow.includes("NvStrapsReBar-windows\n"), "release files never go through the artifact store");
  assert.match(workflow, /needs: \[scope, frontend\]/);
  assert.match(workflow, /node tools\/release-plan\.mjs/);
  assert.match(workflow, /node tools\/apply-version\.mjs \$\{\{ needs\.scope\.outputs\.release-version \}\}/);
  assert.match(workflow, /node tools\/publish-release\.mjs/);
  assert.match(workflow, /if: needs\.scope\.outputs\.release == 'true'/);
  assert.ok(!workflow.includes("publish-prerelease"));
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  for (const upload of workflow.split("uses: actions/upload-artifact").slice(1)) {
    assert.match(upload.split("- name")[0], /retention-days: 7/);
  }
});
