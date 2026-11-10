import { execFileSync } from "node:child_process";

// On Linux the application starts nvstraps-rebar-helper from its own directory to write the EFI
// variable as root (docs/LINUX.md). `tauri dev` and `tauri build` compile only the application
// package, so this puts the helper next to both the debug and the release executable. Other
// hosts have no use for it.

if (process.platform === "linux") {
  for (const profile of [[], ["--release"]]) {
    execFileSync("cargo", ["build", "-p", "nvstraps-linux-helper", ...profile], { stdio: "inherit" });
  }
}
