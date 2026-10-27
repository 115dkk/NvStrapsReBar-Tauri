import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
// The EFI programs are the ones build:external-efi bundled (and, in the Release workflow, signed); rebuilding them here would replace signed copies with unsigned ones.
const images = ["NvStrapsDiagnostic.efi", "NvStrapsLoader.efi"];
if (images.some((name) => !existsSync(`target/external-efi/${name}`))) throw new Error("run npm run build:external-efi (or build:firmware) first");
execFileSync("cargo", ["build", "-p", "nvstraps-external-tool", "--release"], { stdio: "inherit" });
mkdirSync("target/release/external", { recursive: true });
for (const name of images) copyFileSync(`target/external-efi/${name}`, `target/release/external/${name}`);
copyFileSync("secure-boot/NvStrapsReBar-db.cer", "target/release/external/NvStrapsReBar-db.cer");
const tool = `nvstraps-external-tool${process.platform === "win32" ? ".exe" : ""}`;
copyFileSync(`target/release/${tool}`, `target/release/external/${tool}`);
copyFileSync("docs/EXTERNAL_EFI.md", "target/release/external/README.md");
