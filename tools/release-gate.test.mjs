import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { VALIDATION_WORKFLOWS, mergedPullRequest, validationState } from "./release-gate.mjs";

const sha = "a".repeat(40);
const pull = (number, patch = {}) => ({
  number, merged_at: "2026-10-10T00:00:00Z", merge_commit_sha: sha,
  base: { ref: "master" }, head: { sha: `${number}`.repeat(40).slice(0, 40) }, ...patch,
});

test("the release follows the pull request that was merged into master as the pushed commit", () => {
  assert.equal(mergedPullRequest([pull(52)], sha)?.number, 52);
  assert.equal(mergedPullRequest([pull(7, { merged_at: null }), pull(52)], sha)?.number, 52, "an open pull request containing the commit does not count");
  assert.equal(mergedPullRequest([pull(52, { merge_commit_sha: "b".repeat(40) })], sha), null, "a pull request merged as another commit does not count");
  assert.equal(mergedPullRequest([pull(52, { base: { ref: "release" } })], sha), null);
  assert.equal(mergedPullRequest([], sha), null, "a direct push has no pull request");
});

test("every validation workflow must pass on the pull request head", () => {
  const ok = (workflowName, event = "pull_request") => ({ workflowName, event, status: "completed", conclusion: "success" });
  assert.deepEqual(validationState(VALIDATION_WORKFLOWS.map((name) => ok(name))), { state: "success" });
  assert.deepEqual(validationState([ok("Miri"), ok("Rust UEFI validation")]), { state: "pending" }, "a workflow that has not appeared is pending");
  assert.deepEqual(validationState([ok("Miri"), ok("Rust UEFI validation"), ok("Tauri application", "workflow_dispatch")]), { state: "pending" },
    "a manual run of the branch is not the pull request's evidence");
  assert.deepEqual(validationState([ok("Miri"), ok("Rust UEFI validation"), { ...ok("Tauri application"), status: "in_progress", conclusion: null }]), { state: "pending" });
  assert.deepEqual(validationState([ok("Miri"), ok("Tauri application"), { ...ok("Rust UEFI validation"), conclusion: "failure" }]), { state: "failed", workflow: "Rust UEFI validation" });
  assert.deepEqual(validationState([ok("Miri"), ok("Tauri application"), { ...ok("Rust UEFI validation"), conclusion: "cancelled" }]), { state: "failed", workflow: "Rust UEFI validation" });
  // A rerun that succeeded after an earlier failure still counts as failed until the failed run is gone.
  assert.equal(validationState([...VALIDATION_WORKFLOWS.map((name) => ok(name)), { ...ok("Miri"), conclusion: "failure" }]).state, "failed");
});

test("the validation workflows run on pull requests and by hand, never again on a master push", () => {
  const files = { "Tauri application": "Tauri.yml", "Rust UEFI validation": "RustUefi.yml", Miri: "Miri.yml" };
  assert.deepEqual(Object.keys(files), VALIDATION_WORKFLOWS);
  for (const [name, file] of Object.entries(files)) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
    assert.match(workflow, new RegExp(`^name: ${name}\n`), `${file} keeps the name the gate looks for`);
    const triggers = workflow.split("\non:\n")[1]?.split(/\n\S/)[0] ?? "";
    assert.match(triggers, /^ {2}pull_request:\n {4}branches: \["master"\]$/m, `${file} validates pull requests`);
    assert.match(triggers, /^ {2}workflow_dispatch:$/m, `${file} can validate master by hand`);
    assert.ok(!/^ {2}push:/m.test(triggers), `${file} does not run again on a master push`);
  }
});
