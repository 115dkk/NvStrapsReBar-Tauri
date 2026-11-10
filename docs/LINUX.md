# Linux support

Linux support is being built in stages (issue #63). The goal is everything the Windows app does
except the per-game Resizable BAR switches, which go through NVIDIA's Windows driver API and have
no Linux counterpart.

It has **not run on a physical Linux machine yet**. What is listed as working below is proven by
tests against fixture trees and by QEMU with OVMF and a real kernel, as stated for each item.

## Where it stands

| Part | State |
| --- | --- |
| The UEFI driver and the BIOS patching code | Never depended on the operating system |
| Reading the PC: GPUs, board and BIOS, the NvStrapsReBar variables, boot time, `nvidia-smi` | Works in the backend |
| Saving the configuration | Works in the backend, through the root helper below |
| Restarting, also into BIOS setup | Works in the backend, through systemd |
| The screens | Worded for Linux; Games, the external EFI route and the vendor Windows utility are not offered there |
| Packages | `.deb` and `.rpm`, published by hand as a pre-release of their own (`linux-preview-<version>`), never as the Latest release. No AppImage |
| Turning it on without changing the BIOS (external EFI route) | Not ported yet |
| Per-game settings | Not planned: they need NVAPI |

The client learns the host from `snapshot.platform.operatingSystem`. A message in
`src/i18n-catalog.ts` may carry a `linux` text for both languages, used on Linux in place of the
shared one; the browser preview shows the Linux screens with `?os=linux`.

## Where the facts come from

| Fact | Source |
| --- | --- |
| NVIDIA GPUs, their parent bridge and BAR ranges | `/sys/bus/pci/devices/*/{vendor,device,subsystem_vendor,subsystem_device,class,resource}`; the bridge is the parent directory of the device |
| GPU name | `/proc/driver/nvidia/gpus/<address>/information` (NVIDIA's driver), else the system's `pci.ids`, else the PCI IDs |
| Board and BIOS identity | `/sys/class/dmi/id/` (`board_*`, falling back to `sys_vendor` and `product_*`; `bios_*`) |
| UEFI or legacy boot | `/sys/firmware/efi` |
| `NvStrapsReBar` and `NvStrapsReBarStatus` | efivarfs, `/sys/firmware/efi/efivars/<name>-e3ee4a27-e2a2-4435-bba3-184ccad935a8` |
| Boot time | `btime` in `/proc/stat` |
| BAR1 size as the driver sees it | `nvidia-smi -q -x`, taken only from `/usr/bin`, `/usr/local/bin` or `/run/current-system/sw/bin`, and only if the file belongs to root, nobody else can write it, and nobody else can replace it in any directory on the way to it; `PATH` is not searched |

Only PCI domain `0000` is read: the configuration format names a GPU by bus, device and function.
A GPU that `nvidia-smi` reports in another domain is left out of the comparison as well.
A GPU that sits directly on the root bus, with no bridge above it, is an inventory error, as it is
on Windows.

## Privilege: the app stays a normal user

An efivarfs file starts with a four-byte attribute word and then holds the variable's data.
Anybody can read it; only root can write it. So on Linux the desktop application never runs as
root. The existing "administrator" step starts a small helper instead. The screens still treat
reading and saving as one permission, so the app shows the saved configuration only once the
helper is running, as it does with administrator rights on Windows.

```
NvStrapsReBar (your user, GTK and WebKit)
   │  pkexec → the polkit dialog asks for the password once
   ▼
nvstraps-rebar-helper (root, no GUI libraries)
   │  JSON lines on stdin/stdout
   ▼
/sys/firmware/efi/efivars/NvStrapsReBar-e3ee4a27-…
```

The helper (`crates/nvstraps-linux-helper`) lives as long as the application and ends when its
input closes; the application, which cannot signal a root process, never waits for it. It accepts two requests, write the configuration and delete it. No request can name
a variable. It checks every write itself, whatever the application already checked: the bytes must
decode as a configuration and must be exactly what the encoder emits for it.

Two efivarfs rules shape the write, both seen on Linux 6.8 under OVMF:

- A variable outside efivarfs' own allow list is created **immutable**. A second write, or a
  delete, fails with `EPERM` until the flag is cleared (`FS_IOC_SETFLAGS`), so the helper clears
  it first.
- Each `write` call is one `SetVariable`. The helper passes the attribute word and the data in a
  single call and reads the file back.

Without polkit's `pkexec` the step reports that it is missing. Starting the application itself as
root also works (the helper is then started directly), but a graphical application running as
root is not the supported way.

## Packages

`npm run build:linux-packages` writes `nvstraps-rebar_<version>_amd64.deb` and
`nvstraps-rebar-<version>-1.x86_64.rpm` under `target/release/bundle/`
(`src-tauri/tauri.linux.conf.json`). Both install the same files:

| Path | What |
| --- | --- |
| `/usr/bin/nvstraps-rebar` | the application |
| `/usr/lib/nvstraps-rebar/nvstraps-rebar-helper` | the root helper, the static build that the QEMU proof boots |
| `/usr/lib/nvstraps-rebar/` | the UEFI driver and the other bundled files |
| `/usr/share/polkit-1/actions/io.github.nvstrapsrebar.helper.policy` | lets `pkexec` start that one helper path after an administrator's password |
| `/usr/share/applications/nvstraps-rebar.desktop` | the menu entry |

The `.deb` depends on `pkexec` (or `policykit-1` on older releases) and the `.rpm` on `polkit`.
An installed application takes the helper from that system path, and only if it passes the same
ownership check as any other system program; a build from source takes the one beside it.

`npm run check:linux-packages` checks the two packages: their names and contents, their
dependencies, that the packaged helper is static and answers, and that the policy names the path
the helper is installed to. The Tauri workflow's Linux job runs it with `--install`, which also
installs the `.deb` on the runner, starts the installed helper as root with no input, and keeps
the installed application running under a virtual display.

There is no AppImage: root cannot read files inside an AppImage's mount, so `pkexec` could not
start a helper from there.

The stable release stays the Windows build. The Linux packages go out through the `Linux preview`
workflow, which a maintainer starts by hand from `master`. It builds on Ubuntu 22.04, the oldest
supported release, runs the same check with `--install`, and publishes the two packages with
their checksums as a GitHub pre-release tagged `linux-preview-<version>`. A preview is published
once per version.

## Restart

Restarts go to systemd as the signed-in user: `systemctl reboot`, and
`systemctl reboot --firmware-setup` for BIOS setup, which is offered only when the firmware
advertises it (`OsIndicationsSupported`, bit 0). The helper is never used for this, and no
`--force` or inhibitor override is passed: logind applies its own rules about other signed-in
users and shutdown inhibitors to the person at the keyboard, and may ask for a password. On a
system without systemd the app says so; restart by hand.

## Proof, and what it does not show

- **Fixture trees.** Every reader takes its filesystem roots as a parameter; `cargo test` builds
  small `/sys` and `/proc` trees for them. The Tauri workflow's Linux job runs these, Clippy and
  the release build on Ubuntu.
- **OVMF and a real kernel.** `npm run test:qemu:linux-helper` boots a stock Ubuntu kernel on OVMF
  with the driver injected, three times, with the production static helper as the only writer of
  the variable. Boot 1: the driver reports Unconfigured, the helper writes a configuration, a
  normal user reads it and can neither change nor delete it. Boot 2: the driver reports that it
  acted on that configuration; the helper replaces the now-immutable variable with a longer and a
  shorter one, refuses invalid bytes, and deletes it. Boot 3: the driver reports Unconfigured
  again.
- **Not shown.** QEMU has no NVIDIA GPU. polkit, WebKitGTK, `nvidia-smi` on Linux and a physical
  board have not been exercised.

## Trying it on a real PC

Nothing below writes to the firmware or restarts the PC. On Ubuntu 24.04, with Rust and Node.js 24
installed:

```bash
sudo apt-get install --yes libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev \
  libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev build-essential
npm ci
npm run prepare:desktop

# What the app reads on this PC: GPUs, board identity, firmware access, how it judges board and
# GPU support, and the driver's current state. The BAR1 inspection among them needs NVIDIA's driver.
cargo test -p nvstraps-rebar current_machine -- --ignored --nocapture
# Needs NVIDIA's driver: checks that nvidia-smi's XML has what the app expects.
cargo test -p nvstraps-rebar installed_nvidia_smi -- --ignored --nocapture
```

The output of these two commands is the most useful thing to attach to a report.
