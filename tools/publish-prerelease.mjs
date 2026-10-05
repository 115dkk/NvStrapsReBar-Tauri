import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseArguments(env) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repo, GITHUB_RUN_NUMBER: run, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (event !== "push" || ref !== "refs/heads/master") {
    throw new Error("Pre-releases are only published for pushes to master.");
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") ||
      !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") ||
      !/^[1-9]\d*$/.test(run ?? "") || !/^[1-9]\d*$/.test(attempt ?? "")) {
    throw new Error("Missing or invalid GitHub release identity.");
  }
  // Each attempt has its own tag; retries never replace an existing release or asset.
  const tag = `pre-${run}.${attempt}-${sha.slice(0, 8)}`;
  return ["release", "create", tag,
    "release-files/NvStrapsReBar-windows-x64.zip",
    "release-files/NvStrapsReBar-windows-x64-setup.exe", "release-files/SHA256SUMS.txt",
    "--repo", repo, "--target", sha, "--prerelease", "--latest=false",
    "--title", `Windows pre-release ${tag}`,
    "--notes", `Development build from master commit ${sha}.\n\nExtract the ZIP and keep NvStrapsReBar.exe and NvStrapsReBar.ffs together. Requires Windows x64 and WebView2. NvStrapsReBar-windows-x64-setup.exe installs the same two files with Start menu and optional desktop shortcuts.`,
    "--generate-notes"];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = releaseArguments(process.env);
  for (const asset of args.slice(3, 6)) {
    if (!statSync(asset).isFile() || statSync(asset).size === 0) {
      throw new Error(`Release asset is empty or missing: ${asset}`);
    }
  }
  execFileSync("gh", args, { stdio: "inherit" });
}
