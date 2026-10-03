# NvStrapsReBar

**Resizable BAR for NVIDIA Turing GPUs (GTX 1600 / RTX 2000) on motherboards that never got a
ReBAR BIOS update.**

[한국어 안내 → README.ko.md](README.ko.md)

Turing GPUs support Resizable BAR in hardware, but NVIDIA never shipped it for them, and older
motherboards have no ReBAR option in BIOS setup. NvStrapsReBar closes that gap with a small UEFI
driver that runs at boot, before Windows, and widens the GPU's BAR — the memory window the CPU
uses to reach VRAM — from the default 256 MiB up to the full VRAM size. This repository is a
stable-Rust implementation of the original C/C++
[NvStrapsReBar](https://github.com/terminatorul/NvStrapsReBar), together with a Rust/Tauri
Windows app that prepares your BIOS image and edits the driver's settings.

## How the app guides you

The app opens on the state of your PC and shows one task per screen. An installation runs in four
stages, and you can close the app at any point; it reopens on the same step.

1. **Prepare** — choose the official BIOS file for your exact motherboard and confirm the install
   and recovery methods (the app fills them in for boards it knows; other boards answer three
   questions from the manual, and older Above 4G boards also review the BIOS patches the analyzer
   recommends). The app adds the NvStrapsReBar DXE driver, checks the result, and saves a package
   to your USB drive: the new BIOS file, the untouched original, checksums, and step-by-step
   instructions in English and Korean. On a board whose flashback recovery file name the app knows
   (`MSI.ROM` on the MSI PRO Z690-A DDR4), it also saves a copy of the original under that name next
   to the package.
2. **Install** — restart into BIOS setup from the app, install the new file with your vendor's own
   tool (M-FLASH, a flashback button, whatever your board uses) and change the listed settings.
   Back in Windows, the app sees NvStrapsReBar running and you record what you did.
3. **Turn on** — save the recommended sizes (the button is the confirmation; the app reads the
   value back) and restart.
4. **Finish** — the app reads the BAR size the NVIDIA driver reports. Turning Resizable BAR on per
   game is offered afterwards from the finish screen and from home.

After installation, home shows every NVIDIA GPU with its current BAR size. **BAR Settings** turns
expansion on or off, sets per-GPU sizes or exclusions, and sets a motherboard-side BAR limit for
boards that need one; saving there asks for one confirmation and takes effect at the next restart.
If you already installed the original NvStrapsReBar with other tools, the app recognizes the
expanded aperture and edits the same UEFI variable.

## What you need

- An NVIDIA Turing GPU: GTX 1600 or RTX 2000 series.
- A motherboard booting in UEFI mode, with **Above 4G Decoding** enabled and **CSM** disabled in
  BIOS setup.
- The official BIOS image for your exact board and revision, plus a flash route and a recovery
  route that actually work (flashback button, dual BIOS, or an SPI programmer).
- Windows with an administrator account — reading and writing the UEFI variable needs it. The app
  offers to restart itself as administrator when required.

GTX 1000 (Pascal) and older cards are not supported: their Windows driver crashes when the BAR
changes, so the app does not offer them.

## Current status

The Rust driver and the firmware tooling are covered by host tests and a QEMU/OVMF boot test, but
no end-to-end flash on a physical machine has been verified by this project yet. A bad BIOS flash
can leave a board unbootable; continue only after confirming your recovery route works. For the
MSI PRO Z690-A DDR4 (MS-7D25) the app prefills the documented M-FLASH install and Flash BIOS
Button recovery routes; on other boards you choose the routes yourself.

## Checking the result

Run `nvidia-smi -q -d memory`, or just look at the app's home screen: an expanded GPU shows its
new BAR size in green. The NVIDIA driver applies Resizable BAR per application. **Turn on for each
game** lists the driver's game profiles: search for a game and flip its switch, or turn on
**All games** for every game without its own setting. The first change saves a copy of all NVIDIA
driver settings, which the same screen can restore. Changes apply the next time a game starts and
need the app to run as administrator. The setting IDs come from
[NVIDIA Profile Inspector](https://github.com/Orbmu2k/nvidiaProfileInspector); the app talks to
the driver through NVIDIA's public NVAPI.

## Before changing hardware

Save your settings to a file first (BAR Settings has a button for it), turn the expansion off,
save, shut down, and only then swap GPUs or move cards between slots. After the change, load the
file to restore your settings. The driver finds the GPU by addresses the firmware assigns at boot, and those
addresses move when the hardware changes. Two escape hatches work without Windows: when BIOS
setup settings change, the driver sits out that boot (this guard is on by default), and after a
CMOS reset — clock battery pulled or jumper cleared — it saves itself in the off state.

## Development

Requirements: Node.js 24+, stable Rust with `rustfmt` and `clippy`, and the `x86_64-unknown-uefi`
target. Users of a packaged build need none of these.

```powershell
npm ci
npm run check        # TypeScript, unit tests, lint
npm run check:rust   # fmt, clippy, host and UEFI-target tests
npm run tauri dev
```

Release builds and the remaining gates:

```powershell
npm run tauri:ci     # NvStrapsReBar.exe + NvStrapsReBar.ffs (embedded into the app)
npm run test:e2e     # Playwright journeys
npm run check:firmware
npm run check:riir   # rejects tracked C/C++ and the removed EDK2 build trees
npm run check:miri   # needs: rustup toolchain install nightly --component miri --profile minimal
```

`npm run check:miri` interprets the host-safe contracts and the volatile BAR1 MMIO code. Windows
FFI and UEFI protocol boundaries stay covered by compilation, Clippy, native tests, and — on
Linux with QEMU and OVMF installed — `npm run test:qemu`, which boots an injected OVMF copy with
an isolated variable store.

Deeper documentation:

- [Rust UEFI implementation status](docs/RUST_UEFI_PORT.md)
- [Tauri backend contract](docs/TAURI_BACKEND.md)
- [RIIR and one-click deployment boundaries](docs/RIIR_AND_ONE_CLICK.md)
- [Domain language](CONTEXT.md)

## Credits

This work builds on the original C/C++
[NvStrapsReBar](https://github.com/terminatorul/NvStrapsReBar) by @terminatorul, the
[ReBarUEFI](https://github.com/xCuri0/ReBarUEFI) project it grew from, and findings from
[envytools](https://github.com/envytools/envytools), @mupuf, and @Xelafic. The pinned legacy
patch catalogs retain their upstream provenance and hashes.

## Licenses

Repository-owned source code is distributed under the [MIT license](LICENSE). The bundled
Pretendard Variable and Jetendard fonts remain under the SIL Open Font License 1.1; they are not
relicensed under MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for their pinned
provenance and hashes, or use the application's **Licenses** button to read the copyright notices
and full OFL texts offline.
