# Tested hardware

Every trial on a physical PC that has been reported to this project, whether it worked or not.
Each row links to the report it comes from. A board that is not listed has not been reported:
nothing is known about it either way.

| Motherboard | GPU | System | Result | Report |
| --- | --- | --- | --- | --- |
| MSI MAG B660 TOMAHAWK WIFI DDR5 (MS-7D41), BIOS 7D41vAO | RTX 2060 12GB | Windows, NVIDIA driver 610.62 | **Works: BAR1 16 GiB**, in the app and in GPU-Z | [#39](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/39) |
| MSI Z390-A PRO (MS-7B98) | RTX 2080 Ti 11GB | Ubuntu 26.10, kernel 7.3.0 | **Works: BAR1 16 GiB**, in the app and in `lspci -vv` | [#63](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/63#issuecomment-6783051817) |
| MSI MAG Z790 TOMAHAWK WIFI (MS-7D91), BIOS 7D91vHJ | RTX 2070 SUPER | Windows 11 | **Refused by the board's flasher**: M-FLASH did not start on the changed BIOS file, so nothing was installed | [#54](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/54#issuecomment-6397682348) |

## What each report covers

- **MSI MAG B660 TOMAHAWK WIFI DDR5** (October 2026). The driver was put into the BIOS file
  with the `nvstraps-ffs inject` command, not with the app's guided steps, and MSI's M-FLASH
  accepted the changed file. The app was used for the BAR settings. The report does not say
  which Windows version ran, and has no result for sleep and resume or for the per-game
  switches.
- **MSI Z390-A PRO** (November 2026). The whole guided flow of the 1.1.5 Linux preview, installed
  from the `.deb`: the BIOS file was made in the app and installed, the settings were saved
  through the system's password dialog, and the app restarted the PC into BIOS setup. According
  to the reporter the board has no flashback button or comparable way to recover, so the trial
  ran without one. The report does not name the BIOS version or the flash tool, and has no
  result for sleep and resume.
- **MSI MAG Z790 TOMAHAWK WIFI** (October 2026). The BIOS file was made in the app. When the
  flash was started, M-FLASH answered "Unable to start a Secure Flash session"; the stock file
  of the same version had gone in normally before. On this board the maker's signature covers
  the part of the file the driver goes into, and the app now warns before it makes such a file.
  The [route that leaves the BIOS alone](EXTERNAL_EFI.md) was offered for this board; no result
  came back.

## Not reported yet

- Sleep and resume with the expanded BAR, on any board.
- The app's guided flow on Windows from the BIOS file to the result. The Windows report used
  the command line injector.
- The route that leaves the BIOS alone, on any physical board. It has run on QEMU only.
- The extra BIOS patches for older boards. No report says it used them.
- A board from any maker other than MSI.

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
