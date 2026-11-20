# Tested hardware

Every trial on a physical PC that has been reported to this project, whether it worked or not.
The table has one line per report. What the report says beyond that, such as the BAR1 size and
where it was read, is under [What each report covers](#what-each-report-covers) and in the
linked report. A board that is not listed has not been reported: nothing is known about it
either way.

| Motherboard | BIOS version | GPU | VRAM | Operating system | Result | Report |
| --- | --- | --- | --- | --- | --- | --- |
| MSI MAG B660 TOMAHAWK WIFI DDR5 | 7D41vAO | RTX 2060 | 12 GB | Windows | **Works** | [#39](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/39) |
| MSI Z390-A PRO | 7B98v1F | RTX 2080 Ti | 11 GB | Linux | **Works** | [#63](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/63#issuecomment-6783051817) |
| Colorful CVN B650M GAMING FROZEN V14 | 1022 | RTX 2080 | 8 GB | Windows, macOS | **Works** | [#80](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/80) |
| MSI MAG Z790 TOMAHAWK WIFI | 7D91vHJ | RTX 2070 SUPER | 8 GB | Windows | **Flasher refused the file** | [#54](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/54#issuecomment-6397682348) |

The Result column is the report's outcome in a few words. "Works" means BAR1 was larger than
256 MiB after configuring. A trial that did not get there names where it stopped, because a
flasher that refuses the file leaves the board as it was, and a board that no longer starts
does not.

## What each report covers

- **MSI MAG B660 TOMAHAWK WIFI DDR5** (MS-7D41, October 2026). BAR1 reached 16 GiB, in the app
  and in GPU-Z, on Windows with NVIDIA driver 610.62. The driver was put into the BIOS file
  with the `nvstraps-ffs inject` command, not with the app's guided steps, and MSI's M-FLASH
  accepted the changed file. The app was used for the BAR settings. The report does not say
  which Windows version ran, and has no result for sleep and resume or for the per-game
  switches.
- **MSI Z390-A PRO** (MS-7B98, November 2026). BAR1 reached 16 GiB, in the app and in
  `lspci -vv`, on Ubuntu 26.10 with kernel 7.3.0. The whole guided flow of the 1.1.5 Linux
  preview, installed from the `.deb`: the BIOS file was made in the app and installed, the
  settings were saved through the system's password dialog, and the app restarted the PC into
  BIOS setup. According to the reporter the board has no flashback button or comparable way to
  recover, so the trial ran without one. The reporter added the BIOS version in
  [#85](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/85). The report does not name the
  flash tool, and has no result for sleep and resume.
- **Colorful CVN B650M GAMING FROZEN V14** (November 2026), Ryzen 5 7500F. BAR1 reached 8 GiB,
  in GPU-Z on Windows 11 Pro and in macOS 26.7.3 started through OpenCore. The whole guided
  flow of the Windows app 1.1.9: the BIOS file was made in the app, installed with the board's
  USB BIOS Flashback button, and the BAR was set to 8 GiB in the app. The board started on the
  first try and kept the 8 GiB over repeated cold boots. In macOS the expanded BAR works with
  one change: OpenCore has to hand macOS's boot loader a 256 MiB BAR
  (`Booter -> Quirks -> ResizeAppleGpuBars = 8` and `UEFI -> Quirks -> ResizeGpuBars = -1`),
  after which the NullMoth driver expands it to 8 GiB. With the full 8 GiB handed over, the
  first macOS start stopped. The report has no NVIDIA driver version and no result for sleep
  and resume or for the per-game switches.
- **MSI MAG Z790 TOMAHAWK WIFI** (MS-7D91, October 2026), on Windows 11. The BIOS file was made
  in the app. When the flash was started, M-FLASH answered "Unable to start a Secure Flash
  session", so nothing was installed; the stock file of the same version had gone in normally
  before. On this board the maker's signature covers the part of the file the driver goes
  into, and the app now warns before it makes such a file. The
  [route that leaves the BIOS alone](EXTERNAL_EFI.md) was offered for this board; no result
  came back. The report names the GPU as a 2070 Super without a memory size; 8 GB is the only
  size that model was made with.

## Not reported yet

- Sleep and resume with the expanded BAR, on any board.
- The route that leaves the BIOS alone, on any physical board. It has run on QEMU only.
- The extra BIOS patches for older boards. No report says it used them.
- A board with an Intel CPU other than MSI's, or an AMD board other than the Colorful one.

The maintainers have no board trial of their own in the table. On the maintainer's PC (RTX 2080
SUPER, NVIDIA driver 616.64) the per-game switches were checked against the NVIDIA driver, which
is a test of the driver interface and not of a board. The Linux build has not been run by the
maintainers on a physical PC.

## Add your PC

Open a [hardware report](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/new?template=1-hardware-report.yml).
A trial that failed helps as much as one that worked. The form asks for the board, the BIOS
version, the GPU, the system and the BAR1 size at the end, and for hashes in place of BIOS
files. Every report is added to the table above with a link.

## A related list

ReBarUEFI keeps a [list of working motherboards](https://github.com/xCuri0/ReBarUEFI/wiki) for
its own module, mostly with AMD and Intel GPUs and with newer NVIDIA cards. A board on that list
has firmware that placed a large BAR with ReBarUEFI's module. This project's driver hooks the
firmware at the same place, but a Turing GPU on such a board is still a combination nobody has
reported here.
