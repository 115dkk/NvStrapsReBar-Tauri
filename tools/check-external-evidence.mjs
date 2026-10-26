import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const [mode, file, expected] = process.argv.slice(2);
const text = readFileSync(file, "utf8");
if (mode === "diagnostic") {
  const value = JSON.parse(text);
  assert.equal(value.schema, 1);
  assert.equal(value.environment, expected);
  assert(value.devices.length > 0, "diagnostic did not enumerate any PCI devices");
  assert(value.roots.length > 0, "diagnostic did not read root configuration");
  if (expected === "qemuModel") assert.deepEqual(value.errors, []);
} else if (mode === "success") {
  for (const marker of ["aperture readback=8589934592", "EXTERNAL-HANDOFF: real LoadImage/StartImage reached successor", "restored=Ok(())", "EXTERNAL-MODEL: shared executor and chainload PASS"]) assert(text.includes(marker), `missing: ${marker}`);
  assert(!text.includes("panic; halted"));
} else if (mode === "rejection") {
  assert(text.includes(expected), `missing rejection: ${expected}`);
  assert(!text.includes("aperture readback="), "rejected plan reached mutation success");
  assert(!text.includes("EXTERNAL-HANDOFF:"), "rejected plan reached successor");
} else throw new Error("expected diagnostic, success or rejection mode");
console.log(`External EFI evidence passed: ${mode}`);
