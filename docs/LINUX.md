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
| The screens | Still worded for Windows; the Games page is not hidden yet |
| Packages (`.deb`, `.rpm`, AppImage) and releases | Not built yet; build from source |
| Turning it on without changing the BIOS (external EFI route) | Not ported yet |
| Per-game settings | Not planned: they need NVAPI |

## Where the facts come from

| Fact | Source |
| --- | --- |
| NVIDIA GPUs, their parent bridge and BAR ranges | `/sys/bus/pci/devices/*/{vendor,device,subsystem_vendor,subsystem_device,class,resource}`; the bridge is the parent directory of the device |
| GPU name | `/proc/driver/nvidia/gpus/<address>/information` (NVIDIA's driver), else the system's `pci.ids`, else the PCI IDs |
| Board and BIOS identity | `/sys/class/dmi/id/` (`board_*`, falling back to `sys_vendor` and `product_*`; `bios_*`) |
| UEFI or legacy boot | `/sys/firmware/efi` |
| `NvStrapsReBar` and `NvStrapsReBarStatus` | efivarfs, `/sys/firmware/efi/efivars/<name>-e3ee4a27-e2a2-4435-bba3-184ccad935a8` |
| Boot time | `btime` in `/proc/stat` |
| BAR1 size as the driver sees it | `nvidia-smi -q -x`, taken only from `/usr/bin`, `/usr/local/bin` or `/run/current-system/sw/bin`, and only if the file belongs to root and nobody else can write it; `PATH` is not searched |

Only PCI domain `0000` is read: the configuration format names a GPU by bus, device and function.
A GPU that sits directly on the root bus, with no bridge above it, is an inventory error, as it is
on Windows.

## Privilege: the app stays a normal user

An efivarfs file starts with a four-byte attribute word and then holds the variable's data.
Anybody can read it; only root can write it. So on Linux the desktop application never runs as
root. The existing "administrator" step starts a small helper instead:

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
input closes. It accepts two requests, write the configuration and delete it. No request can name
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
