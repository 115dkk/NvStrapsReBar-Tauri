import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Checks the documentation without building anything, so a documentation-only change that skips
 * the heavy CI jobs is still checked: every relative link and image in a tracked Markdown file
 * points at a tracked file or directory, and every issue form has the keys GitHub requires, known
 * field types and no duplicate field ids.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FENCED_CODE = /(```|~~~)[\s\S]*?\1/g;
const INLINE_CODE = /`[^`\n]*`/g;
const INLINE_LINK = /!?\[(?:[^\]\\\n]|\\.)*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_LINK = /^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm;
const HTML_LINK = /<(?:a|img|source)\s[^>]*?\b(?:href|src)\s*=\s*"([^"]+)"/gi;
const FORM_FIELD_TYPES = new Set(["markdown", "input", "textarea", "dropdown", "checkboxes"]);
const ISSUE_FORM = /^\.github\/ISSUE_TEMPLATE\/(?!config\.ya?ml$)[^/]+\.ya?ml$/i;

/** Link and image targets in a Markdown text, ignoring anything inside code. */
export function linkTargets(markdown) {
  const text = markdown.replace(FENCED_CODE, "").replace(INLINE_CODE, "");
  return [INLINE_LINK, REFERENCE_LINK, HTML_LINK].flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1] ?? match[2]));
}

/**
 * The repository path a link from `fromFile` points at, or null for links that leave the
 * repository's files: URLs with a scheme, protocol-relative URLs and same-page anchors.
 */
export function resolveLink(fromFile, target) {
  if (SCHEME.test(target) || target.startsWith("//") || target.startsWith("#")) {
    return null;
  }
  const linkPath = target.split("#")[0].split("?")[0];
  if (!linkPath) {
    return null;
  }
  let decoded = linkPath;
  try {
    decoded = decodeURIComponent(linkPath);
  } catch {
    // A stray percent sign is part of the name; check it as written.
  }
  const joined = decoded.startsWith("/")
    ? decoded.slice(1)
    : path.posix.join(path.posix.dirname(fromFile), decoded);
  return path.posix.normalize(joined || ".").replace(/\/+$/, "") || ".";
}

/** Links in tracked Markdown files whose target is neither a tracked file nor a tracked directory. */
export function brokenLinks(files, readFile) {
  const tracked = new Set(files);
  const directories = new Set(["."]);
  for (const file of files) {
    for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) {
      directories.add(dir);
    }
  }
  const broken = [];
  for (const file of files.filter((name) => name.toLowerCase().endsWith(".md"))) {
    for (const target of linkTargets(readFile(file))) {
      const resolved = resolveLink(file, target);
      if (resolved !== null && !tracked.has(resolved) && !directories.has(resolved)) {
        broken.push({ file, target });
      }
    }
  }
  return broken;
}

/** Problems GitHub would reject in an issue form, found without a YAML parser. */
export function issueFormProblems(file, text) {
  const problems = [];
  for (const key of ["name", "description", "body"]) {
    if (!new RegExp(`^${key}:`, "m").test(text)) {
      problems.push(`${file}: the top-level "${key}" key is missing`);
    }
  }
  for (const match of text.matchAll(/^\s*-\s+type:\s*["']?([^\s"']+)["']?\s*$/gm)) {
    if (!FORM_FIELD_TYPES.has(match[1])) {
      problems.push(`${file}: unknown field type "${match[1]}"`);
    }
  }
  const seen = new Set();
  for (const match of text.matchAll(/^\s+id:\s*["']?([^\s"']+)["']?\s*$/gm)) {
    if (seen.has(match[1])) {
      problems.push(`${file}: the field id "${match[1]}" is used twice`);
    }
    seen.add(match[1]);
  }
  return problems;
}

export function run() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const read = (file) => readFileSync(file, "utf8");
  const problems = [
    ...brokenLinks(files, read).map(({ file, target }) => `${file}: the link "${target}" points at no tracked file`),
    ...files.filter((file) => ISSUE_FORM.test(file)).flatMap((file) => issueFormProblems(file, read(file))),
  ];
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    throw new Error(`${problems.length} documentation problem(s) found.`);
  }
  const markdown = files.filter((file) => file.toLowerCase().endsWith(".md")).length;
  const forms = files.filter((file) => ISSUE_FORM.test(file)).length;
  console.log(`Documentation check passed: ${markdown} Markdown files and ${forms} issue forms.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
