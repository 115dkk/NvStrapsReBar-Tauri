import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { releaseArguments } from "./publish-prerelease.mjs";

const env = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/master",
  GITHUB_SHA: "a".repeat(40), GITHUB_REPOSITORY: "115dkk/NvStrapsReBar-Tauri",
  GITHUB_RUN_NUMBER: "42", GITHUB_RUN_ATTEMPT: "1" };

test("pins the exact commit, publishes a pre-release, and leaves latest unchanged", () => {
  const args = releaseArguments(env);
  assert.equal(args[2], "pre-42.1-aaaaaaaa");
  assert.equal(args[args.indexOf("--target") + 1], env.GITHUB_SHA);
  assert.ok(args.includes("--prerelease"));
  assert.ok(args.includes("--latest=false"));
  assert.ok(!args.includes("--clobber"));
  assert.equal(args[3], "release-files/NvStrapsReBar-windows-x64.zip");
  assert.equal(args[4], "release-files/NvStrapsReBar-windows-x64-setup.exe");
  assert.equal(args[5], "release-files/SHA256SUMS.txt");
});
test("a rerun gets a new tag without deleting or updating the first release", () => {
  assert.notEqual(releaseArguments(env)[2], releaseArguments({ ...env, GITHUB_RUN_ATTEMPT: "2" })[2]);
});
test("rejects PRs, manual runs, other branches and malformed identity", () => {
  for (const patch of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_SHA: "master" },
    { GITHUB_REPOSITORY: "--bad" }, { GITHUB_RUN_NUMBER: "" }, { GITHUB_RUN_ATTEMPT: "0" }]) {
    assert.throws(() => releaseArguments({ ...env, ...patch }));
  }
});
test("release waits for tested native artifacts; every push builds even for docs", () => {
  const workflow = readFileSync(new URL("../.github/workflows/Tauri.yml", import.meta.url), "utf8");
  assert.match(workflow, /needs: \[frontend, native-windows\]/);
  assert.equal((workflow.match(/if: needs.scope.outputs.run-heavy == 'true' \|\| github.event_name == 'push'/g) ?? []).length, 2);
  assert.match(workflow, /github.event_name == 'push' && github.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  assert.match(workflow, /node tools\/publish-prerelease.mjs/);
});
