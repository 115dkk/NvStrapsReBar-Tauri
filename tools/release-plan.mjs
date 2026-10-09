import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { isDocumentationOnlyPath } from "./ci-scope.mjs";

/**
 * Decides whether a master push becomes a stable release and which version it gets.
 *
 * A change counts as a program change when it touches what ships to users: the app, the UEFI
 * driver and its crates, bundled assets, dependencies, the installer, or the notices the installer
 * copies. Documentation, CI, tests, test tooling and repository housekeeping never release.
 *
 * The level comes from the change itself. A change to the UEFI driver or its shared contract is a
 * minor release, because users must re-flash to get it. Any other program change is a patch. A
 * commit subject may raise the level with a conventional prefix such as `feat:` / `minor:` (minor)
 * or `major:` / `breaking:` / `feat!:` (major), a bracketed `[minor]` / `[major]` / `[breaking]`,
 * or a `BREAKING CHANGE:` footer.
 */

const IGNORED_PREFIXES = [
  ".github/",
  ".superloopy/",
  ".vscode/",
  "crates/nvstraps-s3-probe/",
  "docs/",
  "scripts/",
  "tests/",
  "tools/",
];
const IGNORED_FILES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "playwright.config.ts",
  "rebar.png",
]);
const SHIPPED_DOCUMENTS = new Set(["THIRD_PARTY_NOTICES.md", "LICENSE"]);
const FIRMWARE_PREFIXES = ["crates/nvstraps-uefi/", "crates/nvstraps-core/"];
const UNIT_TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mjs|js)$/i;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const SUBJECT_MARKER =
  /^\s*(?:\[(?<bracket>major|breaking|minor|feat|feature)\]|(?<prefix>major|breaking|minor|feat|feature)(?:\([^)\n]*\))?(?<bang>!)?:)/im;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/im;

export const LEVELS = ["none", "patch", "minor", "major"];

export function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** True when the file changes what the release ships. */
export function isProgramPath(file) {
  const path = normalizePath(file);
  if (SHIPPED_DOCUMENTS.has(path)) {
    return true;
  }
  if (isDocumentationOnlyPath(path) || IGNORED_FILES.has(path) || path.endsWith(".md")) {
    return false;
  }
  if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  if (UNIT_TEST_FILE.test(path)) {
    return false;
  }
  return true;
}

export function isFirmwarePath(file) {
  const path = normalizePath(file);
  return FIRMWARE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** The level a commit message asks for, or null when it carries no marker. */
export function messageLevel(message) {
  if (BREAKING_FOOTER.test(message)) {
    return "major";
  }
  const match = message.match(SUBJECT_MARKER);
  if (!match) {
    return null;
  }
  const keyword = (match.groups.bracket ?? match.groups.prefix).toLowerCase();
  if (match.groups.bang || keyword === "major" || keyword === "breaking") {
    return "major";
  }
  return "minor";
}

function higher(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

export function detectLevel({ files, messages }) {
  const program = files.filter(isProgramPath);
  if (program.length === 0) {
    return { level: "none", program, reason: "no program path changed" };
  }
  let level = program.some(isFirmwarePath) ? "minor" : "patch";
  let reason =
    level === "minor"
      ? "the UEFI driver or its shared contract changed"
      : "program files changed outside the UEFI driver";
  for (const message of messages) {
    const asked = messageLevel(message);
    if (asked && LEVELS.indexOf(asked) > LEVELS.indexOf(level)) {
      level = higher(level, asked);
      reason = `a commit message asks for a ${asked} release`;
    }
  }
  return { level, program, reason };
}

export function parseVersion(text) {
  const match = String(text ?? "").match(SEMVER);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

export function bumpVersion(version, level) {
  const [major, minor, patch] = version;
  switch (level) {
    case "major":
      return [major + 1, 0, 0];
    case "minor":
      return [major, minor + 1, 0];
    case "patch":
      return [major, minor, patch + 1];
    default:
      return [major, minor, patch];
  }
}

const formatVersion = (version) => version.join(".");

/**
 * @param latestTag the newest `v<version>` tag reachable from the push, or null before the first
 *   release; the manifests then carry the version to publish as is.
 * @param manifestVersion the version the checked-in manifests agree on.
 */
export function planRelease({ eventName, ref, files, messages, latestTag, manifestVersion }) {
  const manifest = parseVersion(manifestVersion);
  if (!manifest) {
    return { release: false, level: "none", version: null, tag: null, reason: `manifest version "${manifestVersion}" is not <major>.<minor>.<patch>` };
  }
  if (eventName !== "push" || ref !== "refs/heads/master") {
    return { release: false, level: "none", version: null, tag: null, reason: "only pushes to master release" };
  }
  const { level, reason } = detectLevel({ files, messages });
  if (latestTag == null) {
    // Bootstrap: until the first release exists, every master push publishes the version the
    // manifests already carry, so a release that failed to publish is retried by the next push.
    return {
      release: true,
      level,
      version: formatVersion(manifest),
      tag: `v${formatVersion(manifest)}`,
      reason: `no release tag exists yet, so the manifests' version is published as is (${reason})`,
    };
  }
  if (level === "none") {
    return { release: false, level, version: null, tag: null, reason };
  }
  const base = parseVersion(String(latestTag).replace(/^v/, ""));
  if (!base) {
    return { release: false, level, version: null, tag: null, reason: `latest tag "${latestTag}" is not v<major>.<minor>.<patch>` };
  }
  let version = bumpVersion(base, level);
  let detail = `${reason}; ${level} bump from ${latestTag}`;
  if (compareVersions(manifest, base) > 0) {
    version = manifest;
    detail = `${reason}; the manifests already moved past ${latestTag}, so their version is published`;
  }
  return { release: true, level, version: formatVersion(version), tag: `v${formatVersion(version)}`, reason: detail };
}

export function manifestVersion(readFile = (path) => readFileSync(path, "utf8")) {
  const versions = {
    package: JSON.parse(readFile("package.json")).version,
    tauri: JSON.parse(readFile("src-tauri/tauri.conf.json")).version,
    cargo: readFile("src-tauri/Cargo.toml").match(/^version = "([^"]+)"\r?$/m)?.[1],
  };
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1) {
    throw new Error(`The manifests disagree on the version: ${JSON.stringify(versions)}`);
  }
  return versions.package;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function gitLines(args) {
  return git(args).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function latestReleaseTag() {
  try {
    // Before the first release there is no tag to describe; git says so on stderr, which is noise.
    return execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function changedSince(range, head) {
  if (range) {
    return gitLines(["diff", "--no-renames", "--name-only", range, head]);
  }
  try {
    return gitLines(["diff", "--no-renames", "--name-only", `${head}^`, head]);
  } catch {
    return gitLines(["ls-tree", "-r", "--name-only", head]);
  }
}

function messagesSince(range, head) {
  const target = range ? `${range}..${head}` : head;
  const args = ["log", "--format=%B%x00", target];
  if (!range) {
    args.push("-1");
  }
  return git(args).split("\0").map((message) => message.trim()).filter(Boolean);
}

function writeOutput(name, value, environment) {
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
  }
}

export function run(environment = process.env) {
  const head = environment.RELEASE_PLAN_HEAD_SHA || "HEAD";
  const before = environment.RELEASE_PLAN_BASE_SHA ?? "";
  const latestTag = latestReleaseTag();
  // Everything since the last release decides; before the first release the push itself does.
  const range = latestTag ?? (before && !/^0+$/u.test(before) ? before : null);
  const plan = planRelease({
    eventName: environment.RELEASE_PLAN_EVENT_NAME ?? "",
    ref: environment.RELEASE_PLAN_REF ?? "",
    files: changedSince(range, head),
    messages: messagesSince(range, head),
    latestTag,
    manifestVersion: manifestVersion(),
  });
  writeOutput("release", String(plan.release), environment);
  writeOutput("level", plan.level, environment);
  writeOutput("version", plan.version ?? "", environment);
  writeOutput("tag", plan.tag ?? "", environment);
  const summary = [
    "## Release plan",
    "",
    `- Release: **${plan.release}**`,
    `- Level: ${plan.level}`,
    `- Version: ${plan.version ?? "(none)"}`,
    `- Baseline: ${latestTag ?? "no release tag yet"}`,
    `- Reason: ${plan.reason}`,
    "",
  ].join("\n");
  if (environment.GITHUB_STEP_SUMMARY) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, summary, "utf8");
  }
  console.log(summary);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
