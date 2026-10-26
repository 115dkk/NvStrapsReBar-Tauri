import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
execFileSync("cargo", ["build", "-p", "nvstraps-external-efi", "--release", "--target", "x86_64-unknown-uefi"], { stdio: "inherit" });
execFileSync("cargo", ["build", "-p", "nvstraps-external-tool", "--release"], { stdio: "inherit" });
mkdirSync("target/release/external", { recursive: true });
for (const name of ["NvStrapsDiagnostic.efi", "NvStrapsLoader.efi"]) copyFileSync(`target/x86_64-unknown-uefi/release/${name}`, `target/release/external/${name}`);
const tool = `nvstraps-external-tool${process.platform === "win32" ? ".exe" : ""}`;
copyFileSync(`target/release/${tool}`, `target/release/external/${tool}`);
copyFileSync("docs/EXTERNAL_EFI.md", "target/release/external/README.md");
