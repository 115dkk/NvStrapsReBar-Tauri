import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { manifestVersion } from "./release-plan.mjs";

/**
 * Publishes the stable release for a master push, from the Windows job that built it.
 *
 * It waits for the sibling workflows of the same commit to pass, commits the version bump that
 * `tools/apply-version.mjs` wrote (if anything changed), pushes that commit to master, and creates
 * the GitHub release as Latest with the built files attached. Nothing goes through the Actions
 * artifact store. A push made with the workflow token starts no new workflow run, so the bump
 * commit does not release itself.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;
/** The other workflows this push starts; the release needs every one of them green. */
export const SIBLING_WORKFLOWS = ["Rust UEFI validation", "Miri"];
export const RELEASE_FILES = [
  "release-files/NvStrapsReBar-windows-x64.zip",
  "release-files/NvStrapsReBar-windows-x64-setup.exe",
  "release-files/SHA256SUMS.txt",
];
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

export function releaseIdentity(env) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repo, RELEASE_VERSION: version } = env;
  if (event !== "push" || ref !== "refs/heads/master") {
    throw new Error("Stable releases are only published for pushes to master.");
  }
  if (!SEMVER.test(version ?? "")) {
    throw new Error(`RELEASE_VERSION "${version}" is not <major>.<minor>.<patch>.`);
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
    throw new Error("Missing or invalid GitHub release identity.");
  }
  return { version, tag: `v${version}`, sha, repo };
}

export function releaseArguments({ version, tag, repo }, { target, notesFile }) {
  const args = ["release", "create", tag, ...RELEASE_FILES,
    "--repo", repo, "--target", target, "--latest",
    "--title", `NvStrapsReBar ${version}`];
  if (notesFile) {
    args.push("--notes-file", notesFile);
  } else {
    args.push("--generate-notes", "--notes",
      "Extract the ZIP and keep NvStrapsReBar.exe and NvStrapsReBar.ffs together, or run NvStrapsReBar-windows-x64-setup.exe to install the same two files with Start menu and optional desktop shortcuts. Requires Windows x64 and WebView2.\n\nSHA256SUMS.txt lists the checksums of both downloads.");
  }
  // `gh release create` refuses an existing tag's release, so a rerun never replaces one.
  return args;
}

/**
 * Reduces `gh run list` rows for one commit to the state of the sibling workflows:
 * "success" when every sibling has a successful completed run, "failed" when any run concluded
 * otherwise, "pending" while a sibling has not finished or has not appeared yet.
 */
export function siblingState(runs, siblings = SIBLING_WORKFLOWS) {
  let pending = false;
  for (const workflow of siblings) {
    const rows = runs.filter((run) => run.workflowName === workflow);
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

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...options });
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

async function waitForSiblings(sha, repo, { timeoutMs = 30 * 60_000, intervalMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runs = JSON.parse(gh(["run", "list", "--repo", repo, "--commit", sha, "--limit", "50",
      "--json", "workflowName,status,conclusion,databaseId"]));
    const result = siblingState(runs);
    if (result.state === "success") {
      return;
    }
    if (result.state === "failed") {
      throw new Error(`${result.workflow} did not pass for ${sha}; not releasing.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${SIBLING_WORKFLOWS.join(" and ")} on ${sha}.`);
    }
    console.log(`Waiting for ${SIBLING_WORKFLOWS.join(" and ")} to finish for ${sha}...`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The files tools/apply-version.mjs may have rewritten, and nothing else the build touched. */
const VERSION_FILES = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json",
  "installer/NvStrapsReBar.iss", "Cargo.toml", "Cargo.lock", "crates", "src-tauri/Cargo.toml"];

/**
 * Stages the version files and reports whether the index now differs from HEAD. Staging first
 * matters on the Windows runner: the Tauri build rewrites src-tauri/Cargo.toml with LF endings in
 * a CRLF checkout, which `git status` reports as a change although the normalized content is the
 * same, and a commit of it would fail with nothing to commit.
 */
function stageVersionFiles() {
  const status = git(["status", "--porcelain", "--", ...VERSION_FILES]);
  if (status) {
    console.log(`Working tree before staging:\n${status}`);
  }
  git(["add", "--", ...VERSION_FILES]);
  const diff = spawnSync("git", ["diff", "--cached", "--quiet", "--", ...VERSION_FILES], { encoding: "utf8" });
  if (diff.status !== 0 && diff.status !== 1) {
    throw new Error(`git diff --cached failed: ${diff.stderr}`);
  }
  return diff.status === 1;
}

function commitVersionBump(tag) {
  if (!stageVersionFiles()) {
    console.log("The manifests already carry the release version; nothing to commit.");
    return;
  }
  git(["config", "user.name", BOT_NAME]);
  git(["config", "user.email", BOT_EMAIL]);
  git(["commit", "-m", `Release ${tag}`, "-m",
    "Version bump written by the release workflow; the attached build was made from this tree."]);
  // Fails on a non-fast-forward push, which means master moved on; the next push releases.
  git(["push", "origin", "HEAD:master"], { stdio: "inherit" });
}

export async function main(env = process.env) {
  const identity = releaseIdentity(env);
  const found = manifestVersion();
  if (found !== identity.version) {
    throw new Error(`The manifests carry ${found}, not the release version ${identity.version}.`);
  }
  for (const file of RELEASE_FILES) {
    if (!statSync(file).isFile() || statSync(file).size === 0) {
      throw new Error(`Release file is empty or missing: ${file}`);
    }
  }
  await waitForSiblings(identity.sha, identity.repo);
  commitVersionBump(identity.tag);
  const target = git(["rev-parse", "HEAD"]);
  const notesFile = `docs/releases/${identity.tag}.md`;
  const args = releaseArguments(identity, { target, notesFile: existsSync(notesFile) ? notesFile : null });
  gh(args, { stdio: "inherit" });
  console.log(`Published ${identity.tag} from ${target}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
