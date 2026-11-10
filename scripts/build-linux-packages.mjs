import { execFileSync } from "node:child_process";

// Builds the .deb and .rpm packages (src-tauri/tauri.linux.conf.json). The packaged root helper is
// the static musl build, the same binary scripts/qemu-linux-helper.sh proves on a real kernel, so
// it does not depend on the C library of the distribution it is installed on.

if (process.platform !== "linux") {
  console.error("Linux packages are built on Linux.");
  process.exit(2);
}

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

run("rustup", ["target", "add", "x86_64-unknown-linux-musl"]);
run("cargo", ["build", "-p", "nvstraps-linux-helper", "--release", "--target", "x86_64-unknown-linux-musl"]);
run("npx", ["tauri", "build", "--bundles", "deb,rpm"]);
