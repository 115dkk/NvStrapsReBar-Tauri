import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** The versions a stable release must agree on, read from the checked-out tree. */
export function manifestVersions(readFile = (path) => readFileSync(path, "utf8")) {
  const cargo = readFile("src-tauri/Cargo.toml").match(/^version = "([^"]+)"$/m)?.[1];
  return {
    package: JSON.parse(readFile("package.json")).version,
    tauri: JSON.parse(readFile("src-tauri/tauri.conf.json")).version,
    cargo,
  };
}

export function releaseArguments(env, versions) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repo } = env;
  if (event !== "push" || !ref?.startsWith("refs/tags/v")) {
    throw new Error("Stable releases are only published for pushed v<version> tags.");
  }
  const tag = ref.slice("refs/tags/".length);
  const version = tag.slice(1);
  if (!SEMVER.test(version)) {
    throw new Error(`Release tag ${tag} is not v<major>.<minor>.<patch>.`);
  }
  for (const [name, value] of Object.entries(versions)) {
    if (value !== version) {
      throw new Error(`Tag ${tag} does not match the ${name} version ${value ?? "(missing)"}.`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
    throw new Error("Missing or invalid GitHub release identity.");
  }
  // `gh release create` refuses an existing tag's release, so a rerun never replaces one.
  return ["release", "create", tag,
    "release-files/NvStrapsReBar-windows-x64.zip",
    "release-files/NvStrapsReBar-windows-x64-setup.exe", "release-files/SHA256SUMS.txt",
    "--repo", repo, "--target", sha, "--verify-tag", "--latest",
    "--title", `NvStrapsReBar ${version}`,
    "--notes-file", `docs/releases/${tag}.md`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = releaseArguments(process.env, manifestVersions());
  for (const file of [...args.slice(3, 6), args[args.indexOf("--notes-file") + 1]]) {
    if (!statSync(file).isFile() || statSync(file).size === 0) {
      throw new Error(`Release file is empty or missing: ${file}`);
    }
  }
  execFileSync("gh", args, { stdio: "inherit" });
}
