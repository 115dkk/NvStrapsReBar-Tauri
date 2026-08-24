import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = "crates/nvstraps-uefi/src/";
const budgets = new Map([
  [`${root}exclusive.rs`, { blocks: 1, functions: 0, implementations: 0, traits: 0, attributes: 0 }],
  [`${root}host_bridge.rs`, { blocks: 3, functions: 2, implementations: 0, traits: 0, attributes: 1 }],
  [`${root}main.rs`, { blocks: 5, functions: 0, implementations: 0, traits: 0, attributes: 0 }],
  [`${root}mmio.rs`, { blocks: 2, functions: 1, implementations: 0, traits: 0, attributes: 0 }],
  [`${root}pci.rs`, { blocks: 2, functions: 0, implementations: 0, traits: 0, attributes: 0 }],
  [`${root}pool.rs`, { blocks: 9, functions: 0, implementations: 0, traits: 0, attributes: 0 }],
  [`${root}s3.rs`, { blocks: 4, functions: 1, implementations: 0, traits: 0, attributes: 1 }],
]);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", root],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((path) => path.endsWith(".rs"))
  .map((path) => path.replaceAll("\\", "/"));

const patterns = {
  blocks: /\bunsafe\s*\{/g,
  functions: /\bunsafe\s+(?:(?:extern\s+"[^"]+"\s+)?fn)\b/g,
  implementations: /\bunsafe\s+impl\b/g,
  traits: /\bunsafe\s+trait\b/g,
  attributes: /#\s*\[\s*unsafe(?:\s*\(|_protocol\b)/g,
};

const violations = [];
let actualTotal = 0;
let budgetTotal = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const actual = Object.fromEntries(
    Object.entries(patterns).map(([name, pattern]) => [
      name,
      [...source.matchAll(pattern)].length,
    ]),
  );
  const fileTotal = Object.values(actual).reduce((sum, value) => sum + value, 0);
  const budget = budgets.get(file);
  if (!budget) {
    if (fileTotal !== 0) {
      violations.push(`${file}: unsafe syntax is outside the reviewed allowlist`);
    }
    continue;
  }
  for (const [kind, count] of Object.entries(actual)) {
    if (count !== budget[kind]) {
      violations.push(
        `${file}: ${kind} changed from reviewed budget ${budget[kind]} to ${count}; ratchet the budget explicitly`,
      );
    }
  }
  actualTotal += fileTotal;
}

for (const [file, budget] of budgets) {
  if (!files.includes(file)) {
    violations.push(`${file}: reviewed unsafe file is missing`);
  }
  budgetTotal += Object.values(budget).reduce((sum, value) => sum + value, 0);
}

if (violations.length !== 0) {
  process.stderr.write(`UEFI unsafe gate rejected the change:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `UEFI unsafe gate passed: ${actualTotal}/${budgetTotal} reviewed syntax sites across ${budgets.size} files; every other DXE source is unsafe-free.\n`,
);
