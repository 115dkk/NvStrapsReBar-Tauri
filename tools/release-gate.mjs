import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Lets a master push release only what its pull request already validated.
 *
 * The validation workflows run on pull requests and never again on the master push. A release
 * therefore needs three facts about the push: a pull request was merged as this commit, the
 * pushed tree is that pull request's head tree, and the head's pull_request runs of every
 * validation workflow passed. The tree comparison means the files that ship are the files those
 * runs tested; a pull request merged while master had moved on releases nothing, and neither does
 * a direct push to master.
 */

/** Workflow names, as each file's `name:` gives them. */
export const VALIDATION_WORKFLOWS = ["Tauri application", "Rust UEFI validation", "Miri"];

/** The pull request merged into master as `sha`, from `GET /repos/{repo}/commits/{sha}/pulls`. */
export function mergedPullRequest(pulls, sha) {
  return (
    pulls.find((pull) => pull.merged_at && pull.merge_commit_sha === sha && pull.base?.ref === "master") ??
    null
  );
}

/**
 * Reduces `gh run list` rows for a pull request head to the state of the validation workflows:
 * "success" when every workflow has a successful pull_request run, "failed" when any of its
 * pull_request runs concluded otherwise, "pending" while a workflow has not finished or has not
 * appeared yet. Runs from other events do not count.
 */
export function validationState(runs, workflows = VALIDATION_WORKFLOWS) {
  let pending = false;
  for (const workflow of workflows) {
    const rows = runs.filter((run) => run.workflowName === workflow && run.event === "pull_request");
    if (rows.length === 0) {
      pending = true;
      continue;
    }
    if (rows.some((run) => run.status === "completed" && run.conclusion !== "success" && run.conclusion !== "skipped")) {
      return { state: "failed", workflow };
    }
    if (!rows.some((run) => run.status === "completed")) {
      pending = true;
    }
  }
  return { state: pending ? "pending" : "success" };
}

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findMergedPullRequest(repo, sha, { attempts = 6, intervalMs = 10_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const pull = mergedPullRequest(gh(["api", `repos/${repo}/commits/${sha}/pulls`]), sha);
    if (pull || attempt === attempts) {
      return pull;
    }
    await sleep(intervalMs);
  }
}

const treeOf = (repo, sha) => gh(["api", `repos/${repo}/commits/${sha}`]).commit.tree.sha;

async function waitForValidation(repo, head, { timeoutMs = 30 * 60_000, intervalMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = gh(["run", "list", "--repo", repo, "--commit", head, "--limit", "50",
      "--json", "workflowName,event,status,conclusion"]);
    const result = validationState(runs);
    if (result.state === "success") {
      return;
    }
    if (result.state === "failed") {
      throw new Error(`${result.workflow} did not pass for the pull request head ${head}; not releasing.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${VALIDATION_WORKFLOWS.join(", ")} on ${head}.`);
    }
    console.log(`Waiting for ${VALIDATION_WORKFLOWS.join(", ")} to finish for ${head}...`);
    await sleep(intervalMs);
  }
}

export async function main(env = process.env) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_REPOSITORY: repo } = env;
  if (event !== "push" || ref !== "refs/heads/master") {
    throw new Error("The release gate only judges pushes to master.");
  }
  const pull = await findMergedPullRequest(repo, sha);
  if (!pull) {
    throw new Error(`No pull request was merged as ${sha}, so no checks vouch for it; not releasing. Change master through a pull request.`);
  }
  const head = pull.head.sha;
  if (treeOf(repo, sha) !== treeOf(repo, head)) {
    throw new Error(`Master at ${sha} is not the tree pull request #${pull.number} tested at ${head}; not releasing. Merge master into a pull request before merging it.`);
  }
  await waitForValidation(repo, head);
  console.log(`Pull request #${pull.number} passed ${VALIDATION_WORKFLOWS.join(", ")} for this tree.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
