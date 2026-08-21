import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCiScope,
  findDocumentationKeyword,
  isDocumentationOnlyPath,
} from "./ci-scope.mjs";

test("recognizes documented CI scope keywords", () => {
  assert.equal(findDocumentationKeyword("docs: clarify recovery"), "docs");
  assert.equal(findDocumentationKeyword("docs(gallery): refresh captures"), "docs");
  assert.equal(findDocumentationKeyword("Refresh the English gallery"), "gallery");
  assert.equal(findDocumentationKeyword("[screenshots] update mobile captures"), "screenshots");
  assert.equal(findDocumentationKeyword("fix: Docker setup"), null);
});

test("accepts only repository documentation and gallery paths", () => {
  for (const file of [
    "README.md",
    "README.ko.md",
    "AGENTS.md",
    "docs/TAURI_BACKEND.md",
    "docs/frontend-gallery/example.png",
    ".github/ISSUE_TEMPLATE/bug.yml",
  ]) {
    assert.equal(isDocumentationOnlyPath(file), true, file);
  }

  for (const file of [
    "src/App.tsx",
    "public/gallery.png",
    "public/licenses/Pretendard/LICENSE",
    "THIRD_PARTY_NOTICES.md",
    ".github/workflows/Tauri.yml",
  ]) {
    assert.equal(isDocumentationOnlyPath(file), false, file);
  }
});

test("skips heavy CI for keyworded documentation-only changes", () => {
  assert.deepEqual(
    classifyCiScope({
      eventName: "pull_request",
      text: "Gallery: refresh English captures",
      files: ["docs/frontend-gallery/README.md", "docs/frontend-gallery/overview.png"],
    }),
    {
      runHeavy: false,
      keyword: "gallery",
      reason: 'documentation-only change acknowledged by "gallery"',
    },
  );
});

test("runs heavy CI when a safe change has no keyword", () => {
  const result = classifyCiScope({
    eventName: "pull_request",
    text: "Update prose",
    files: ["README.md"],
  });
  assert.equal(result.runHeavy, true);
});

test("runs heavy CI when code or bundled assets are mixed in", () => {
  for (const files of [
    ["docs/README.md", "src/App.tsx"],
    ["docs/frontend-gallery/view.png", "public/view.png"],
    ["README.md", ".github/workflows/Tauri.yml"],
  ]) {
    const result = classifyCiScope({
      eventName: "push",
      text: "docs: update supporting material",
      files,
    });
    assert.equal(result.runHeavy, true, files.join(", "));
  }
});

test("manual dispatch always runs heavy CI", () => {
  const result = classifyCiScope({
    eventName: "workflow_dispatch",
    text: "gallery",
    files: ["docs/frontend-gallery/view.png"],
  });
  assert.equal(result.runHeavy, true);
});
