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

## The two steps

The app presents the whole journey as two steps, in the order you meet them:

1. **Install firmware** — pick the official BIOS image for your exact motherboard. The app
   fingerprints it, adds the NvStrapsReBar DXE driver (plus, for older boards, any BIOS patches
   you select from the pinned catalogs), and exports a package: the new image, the untouched
   original, checksums, and step-by-step instructions. You then flash the new image with your
   vendor's own tool — M-FLASH, a flashback button, whatever your board uses. The app does not
   flash; that stays in your hands.
2. **BAR Settings** — once the new BIOS has booted, the app talks to the driver through a UEFI
   variable. Turn Resizable BAR expansion on or off, set per-GPU sizes or exclusions, and set a
   motherboard-side BAR limit for boards that need one. Saving asks for one confirmation and
   takes effect at the next restart.

The home screen shows every NVIDIA GPU with its current BAR size and what to do next. If you
already installed the original NvStrapsReBar with other tools, the app recognizes the expanded
aperture and edits the same UEFI variable.

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
new BAR size in green. The NVIDIA driver applies Resizable BAR per application, so for game-level
control the app installs the official
[NVIDIA Profile Inspector](https://github.com/Orbmu2k/nvidiaProfileInspector) release, backs up
your current profiles, and opens it for you.

## Before changing hardware

Turn the expansion off in BAR Settings, save, shut down, and only then swap GPUs or move cards
between slots. The driver finds the GPU by addresses the firmware assigns at boot, and those
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
