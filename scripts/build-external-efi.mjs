import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Builds the external EFI programs and copies them where the Tauri manifest bundles them from.
// With NVSTRAPS_UEFI_SIGNING_KEY set (the Release workflow), both copies are Authenticode-signed
// with the project certificate users enrol in db; without it they stay unsigned.

const images = ["NvStrapsDiagnostic.efi", "NvStrapsLoader.efi"];
const built = "target/x86_64-unknown-uefi/release";
const bundled = "target/external-efi";
const certificate = "secure-boot/NvStrapsReBar-db.cer";

execFileSync("cargo", ["build", "-p", "nvstraps-external-efi", "--release", "--target", "x86_64-unknown-uefi"], { stdio: "inherit" });
mkdirSync(bundled, { recursive: true });
for (const name of images) copyFileSync(`${built}/${name}`, `${bundled}/${name}`);

const key = process.env.NVSTRAPS_UEFI_SIGNING_KEY;
if (key) {
  const tool = (...args) => execFileSync("cargo", ["run", "--quiet", "-p", "nvstraps-external-tool", "--", ...args], { stdio: "inherit" });
  const folder = mkdtempSync(join(tmpdir(), "nvstraps-signing-"));
  try {
    const keyFile = join(folder, "key.pem");
    writeFileSync(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    for (const name of images) {
      const signed = join(folder, name);
      tool("sign", `${built}/${name}`, certificate, keyFile, signed);
      copyFileSync(signed, `${bundled}/${name}`);
      tool("check-signed", `${bundled}/${name}`, certificate);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  console.log(`Signed ${images.join(" and ")} with ${certificate}`);
} else {
  console.log("NVSTRAPS_UEFI_SIGNING_KEY is not set; the external EFI programs stay unsigned");
}
