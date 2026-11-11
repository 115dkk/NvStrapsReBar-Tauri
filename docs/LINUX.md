# Linux support

Linux support is being built in stages (issue #63). The goal is everything the Windows app does
except the per-game Resizable BAR switches, which go through NVIDIA's Windows driver API and have
no Linux counterpart.

One user has reported a complete run of the 1.1.5 preview on a physical PC (issue #63: Ubuntu
26.10, MSI Z390-A PRO, RTX 2080 Ti), from making the BIOS file to Resizable BAR at 16 GiB. The
maintainers have not run it on a physical Linux machine themselves. What is listed as working
below is proven by tests against fixture trees, by QEMU with OVMF and a real kernel, and by the
packages installed in WSL, as stated for each item.

## Where it stands

| Part | State |
| --- | --- |
| The UEFI driver and the BIOS patching code | Never depended on the operating system |
| Reading the PC: GPUs, board and BIOS, the NvStrapsReBar variables, boot time, `nvidia-smi` | Works in the backend |
| Saving the configuration | Works in the backend, through the root helper below |
| Restarting, also into BIOS setup | Works in the backend, through systemd |
| The screens | Worded for Linux; Games, the external EFI route and the vendor Windows utility are not offered there |
| Packages | `.deb` and `.rpm`, published by hand as a pre-release of their own (`linux-preview-<version>`), never as the Latest release. No AppImage, Snap or Flatpak |
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

On Fedora, install the `.rpm` with `sudo dnf install ./nvstraps-rebar-<version>-1.x86_64.rpm`.
The package is not signed. `dnf` accepts a local file without a signature; `rpm -i` on RPM 6
(Fedora 45) refuses it. Removing the package also removes `/usr/lib/nvstraps-rebar`: the `.rpm`
carries a post-remove script for that, because it does not own the `external` directory inside.

There is no AppImage: root cannot read files inside an AppImage's mount, so `pkexec` could not
start a helper from there.

There is no Snap or Flatpak either. Saving the configuration needs a root-owned helper at a fixed
path and a polkit policy in `/usr/share/polkit-1/actions`, and both formats exist to keep an
application from installing such files on the system. Either would need the helper rebuilt as a
system service with its own review by the store, and a Flatpak would still need that service
installed from a `.deb` or `.rpm`.

## The desktop

- **File chooser.** GTK shows the desktop's own file chooser (the file manager's on GNOME and
  KDE) only when it goes through xdg-desktop-portal, which it does outside a sandbox only if
  `GTK_USE_PORTAL=1` is set. With the variable set and no portal behind it, choosing a file shows
  nothing. So the app asks the portal for its file chooser first (version 3 or later, which GTK
  needs for folders) and, if it answers, starts itself again with the variable set. Without a
  portal the GTK dialog stays.
- **Title bar.** On Wayland the window draws its own title bar, in the desktop theme's colour.
  The app gives it the colour of the app bar below. Where the window manager draws the title bar
  (X11), nothing changes.
- **Window size.** The window opens with the size, position and maximized state it was closed
  with (`tauri-plugin-window-state`, on Windows too). Wayland does not let a program place its
  own window, so there only the size and the maximized state come back.

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
- **The packages in WSL.** The published 1.1.5 packages were installed on Debian 13 (`apt`) and
  Fedora 45 (`dnf`, on a fresh image, so every dependency came from Fedora's repositories). On
  both: the installed files match the package, the helper is owned by root and answers as root,
  polkit lists the action with the helper's path, and the app starts under WebKitGTK and shows
  its first screen. The helper in the `.rpm` is byte for byte the one in the `.deb`, which the
  QEMU run above was repeated with. WSL is not a UEFI boot and has no local desktop session, so
  the app stops at "UEFI startup is required" and `pkexec` refuses.
- **The desktop changes, on Fedora 45 in WSL**, with a build of the source after 1.1.5: the file
  chooser was seen going to the portal (`OpenFile` on `org.freedesktop.portal.FileChooser`) and
  staying with GTK when no portal answers, the title bar took the app bar's colour under a
  Wayland compositor, and a window closed at 1000x700 opened at 1000x700. The published 1.1.5
  never asked the portal on the same system.
- **A physical PC, reported by a user.** See the top of this page. The report does not include
  the sysfs GPU inventory or the state of efivarfs on that board.
- **Not shown.** QEMU has no NVIDIA GPU. The maintainers have not run a physical board. Nothing
  has run with SELinux enforcing (WSL has none), on a Fedora Atomic desktop, or from an installed
  `.rpm` on a real Fedora PC.

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
