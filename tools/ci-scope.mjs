import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DOCUMENTATION_KEYWORD =
  /(?:^|[\s[(])(?<keyword>docs?|documentation|gallery|captures?|screenshots?)(?=$|[\s()\]:,!?.-])/i;

const ROOT_DOCUMENTS = new Set([
  "AGENT.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "CONTEXT.md",
  "README.md",
  "README.ko.md",
  "SECURITY.md",
]);

const DOC_ASSET_EXTENSION = /\.(?:avif|gif|jpe?g|md|png|svg|txt|webp)$/i;

export function findDocumentationKeyword(text) {
  return text.match(DOCUMENTATION_KEYWORD)?.groups?.keyword?.toLowerCase() ?? null;
}

export function isDocumentationOnlyPath(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");

  if (ROOT_DOCUMENTS.has(normalized)) {
    return true;
  }

  if (normalized.startsWith("docs/") && DOC_ASSET_EXTENSION.test(normalized)) {
    return true;
  }

  if (
    normalized === ".github/PULL_REQUEST_TEMPLATE.md" ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+\.(?:md|ya?ml)$/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

export function classifyCiScope({ eventName, text, files }) {
  if (eventName === "workflow_dispatch") {
    return {
      runHeavy: true,
      keyword: findDocumentationKeyword(text),
      reason: "manual dispatch always runs the complete CI floor",
    };
  }

  const keyword = findDocumentationKeyword(text);
  if (!keyword) {
    return {
      runHeavy: true,
      keyword: null,
      reason: "no documentation or gallery keyword was found",
    };
  }

  if (files.length === 0) {
    return {
      runHeavy: true,
      keyword,
      reason: "the changed-file set is empty, so CI fails closed",
    };
  }

  const unsafeFiles = files.filter((file) => !isDocumentationOnlyPath(file));
  if (unsafeFiles.length > 0) {
    return {
      runHeavy: true,
      keyword,
      reason: `non-documentation paths require CI: ${unsafeFiles.slice(0, 5).join(", ")}`,
    };
  }

  return {
    runHeavy: false,
    keyword,
    reason: `documentation-only change acknowledged by "${keyword}"`,
  };
}

function gitLines(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedFiles(environment) {
  const eventName = environment.CI_SCOPE_EVENT_NAME ?? "";
  const base = environment.CI_SCOPE_BASE_SHA ?? "";
  const head = environment.CI_SCOPE_HEAD_SHA ?? "HEAD";

  if (eventName === "pull_request") {
    if (!base) {
      throw new Error("CI_SCOPE_BASE_SHA is required for pull_request events");
    }
    return gitLines(["diff", "--no-renames", "--name-only", `${base}...${head}`]);
  }

  if (eventName === "push") {
    if (base && !/^0+$/u.test(base)) {
      return gitLines(["diff", "--no-renames", "--name-only", base, head]);
    }

    try {
      return gitLines(["diff", "--no-renames", "--name-only", `${head}^`, head]);
    } catch {
      return gitLines(["ls-tree", "-r", "--name-only", head]);
    }
  }

  return [];
}

function writeGithubOutput(name, value, outputPath) {
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
  }
}

export function run(environment = process.env) {
  const eventName = environment.CI_SCOPE_EVENT_NAME ?? "";
  const files = eventName === "workflow_dispatch" ? [] : changedFiles(environment);
  const result = classifyCiScope({
    eventName,
    text: environment.CI_SCOPE_TEXT ?? "",
    files,
  });
  const runHeavy = String(result.runHeavy);

  writeGithubOutput("run-heavy", runHeavy, environment.GITHUB_OUTPUT);
  writeGithubOutput("keyword", result.keyword ?? "", environment.GITHUB_OUTPUT);
  writeGithubOutput("reason", result.reason, environment.GITHUB_OUTPUT);

  const summary = [
    "## CI scope",
    "",
    `- Heavy CI: **${runHeavy}**`,
    `- Reason: ${result.reason}`,
    `- Changed paths: ${files.length}`,
    "",
  ].join("\n");
  if (environment.GITHUB_STEP_SUMMARY) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, summary, "utf8");
  }

  console.log(summary);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
