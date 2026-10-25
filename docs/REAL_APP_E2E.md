# Real-app journeys with vendor firmware

The browser journeys in `tests/e2e` run the screens against `previewDeploymentAdapter`, so no Rust
command runs in them. Issue #54 showed what that misses: every release through v1.0.2 crashed the
moment a user chose a firmware file, because a synchronous command overflowed the WebView thread's
stack, and no test had ever pressed that button in the real application.

The real-app journeys close that gap. CI builds the real Tauri application, starts it, and drives
its WebView through the guided deployment with retail BIOS images downloaded from the vendors:
choosing the file, making the install BIOS file, saving it, recording the flash, the driver check,
saving the settings and the restart that proves the new BAR size. Every Tauri command on that path
runs its real Rust code. Only the leaf functions that read or change the physical machine answer
from a simulated machine instead.

## What is simulated

The `simulated-machine` Cargo feature of `src-tauri` replaces these functions, and nothing else:

| Real function | Simulated answer |
|---|---|
| `devices::enumerate_gpus` | the GPUs in the machine file |
| `machine::collect_machine_identity` | the board and BIOS identity in the machine file |
| `firmware::inspect_access` | `platform.uefi`, `platform.elevated` |
| `firmware::read_variable`, `firmware::write_variable` | `firmwareVariables`, written back to the file |
| `firmware::relaunch_elevated` | an error; the simulated machine is already elevated |
| `deployment_workflow::current_boot_time_unix_ms` | `boot.bootTimeUnixMs` |
| `reboot::ensure_firmware_reboot_available`, `ensure_configuration_reboot_available` | allowed when `platform.uefi` |
| `reboot::execute_reboot` | appends to `rebootRequests`; nothing shuts down |
| `resizable_bar::nvidia_smi::capture` | `nvidia-smi -q -x` XML built from the file, parsed by the real parser |
| `nvidia_profiles::with_driver` | an error; the games page is not part of these journeys |

Native file dialogs are the operating system's, so the harness answers `plugin:dialog|open` in the
page instead of the user. The source image is entered through the existing "Type the file location
instead" field, as a user without the dialog would.

### Keeping it out of releases

- The feature is never enabled by `npm run tauri:ci`, the Release workflow or the installer.
- `src-tauri` refuses to compile with the feature unless `debug_assertions` are on.
- The simulated build uses the identifier `io.github.nvstrapsrebar.simulated`
  (`src-tauri/tauri.simulated.conf.json`), so its profiles, artifacts, WebView storage and logs live
  in `%LOCALAPPDATA%\io.github.nvstrapsrebar.simulated` and never touch a real installation's data.
- Its window title ends in "(simulated machine)".
- Without `NVSTRAPS_SIMULATED_MACHINE` the simulated build stops at start-up with that message.

## The machine file

`NVSTRAPS_SIMULATED_MACHINE` holds the absolute path of a JSON file. The application reads it on
every call and writes it back after a variable write or a reboot request, so the harness changes
the world between launches by editing the file. Writes replace the file through a temporary file
in the same folder.

```json
{
  "schema": 1,
  "platform": { "uefi": true, "elevated": true },
  "boot": { "bootTimeUnixMs": 1793000000000 },
  "identity": {
    "boardManufacturer": "Micro-Star International Co., Ltd.",
    "boardProduct": "MAG Z790 TOMAHAWK WIFI (MS-7D91)",
    "boardVersion": "1.0",
    "biosVendor": "American Megatrends International, LLC.",
    "biosVersion": "1.H0",
    "biosReleaseDate": "09/14/2026"
  },
  "gpus": [
    {
      "name": "NVIDIA GeForce RTX 2080 SUPER",
      "vendorId": 4318,
      "deviceId": 7809,
      "subsystemVendorId": 5218,
      "subsystemDeviceId": 14165,
      "location": { "bus": 1, "device": 0, "function": 0 },
      "bridge": { "vendorId": 32902, "deviceId": 43577, "location": { "bus": 0, "device": 1, "function": 0 } },
      "bar0Base": 2147483648,
      "bar0Top": 2164260863,
      "bar1Bytes": 268435456,
      "dedicatedVideoMemoryBytes": 8589934592
    }
  ],
  "firmwareVariables": { "NvStrapsReBar": null, "NvStrapsReBarStatus": null },
  "nvidiaSmi": { "installed": true, "driverVersion": "596.36" },
  "rebootRequests": []
}
```

- `firmwareVariables` maps a variable name to its bytes in base64, or `null` when the variable does
  not exist. Only the two NvStrapsReBar variables are ever read or written.
- `NvStrapsReBarStatus` is the driver's 8-byte little-endian status value
  (`crates/nvstraps-core/src/status.rs`: the code in the low 32 bits, the packed PCI location in the
  high 16 bits).
- `bar1Bytes` is the BAR1 size Windows and `nvidia-smi` report for the current boot. The simulated
  device reports it as its `current_bar_size`, and as the CfgMgr memory resource the real code would
  read, so an expanded aperture is evidence exactly as on a real machine.
- `rebootRequests` gains `{ "kind": "firmwareSetup" | "configuration", "requestedAtUnixMs": … }` for
  each accepted reboot.

## The physical world in the harness

`tests/real-app` starts the simulated build with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` and attaches Playwright with
`chromium.connectOverCDP`. A "restart" is the harness closing the application after a recorded
reboot request, changing the machine file the way the hardware would have, and starting it again:

- After the firmware-setup reboot, the board now runs the install BIOS file: the boot time moves
  forward and `NvStrapsReBarStatus` holds the status the unconfigured driver writes.
- After the configuration reboot, the boot time moves forward again, the status reports the
  configured GPU, and `bar1Bytes` and `nvidia-smi` report the size the saved configuration asks for.

The harness never flashes anything. What it checks about the install BIOS file is checked on the
bytes the application saved: the exported image has the size of the source image, differs from it,
and equals what `nvstraps-ffs inject` (or `inject-all`) produces from the same source and the same
`NvStrapsReBar.ffs`.

## Vendor images

`tests/real-app/vendor-firmware.json` pins each image: the vendor URL, the SHA-256 and size of the
archive, the member to extract, the SHA-256 and size of the image, the identity of the simulated
board, and the expected outcome. `node tools/fetch-vendor-firmware.mjs` downloads the archives into
`.cache/vendor-firmware`, verifies them, and extracts the images. Nothing is redistributed: the
repository keeps URLs and hashes only, CI keeps the archives in the Actions cache, and no step
uploads an image, an archive or anything the application derived from one. A failed journey uploads
screenshots and the application's logs only.

| Image | Board | Expected outcome |
|---|---|---|
| `E7D91IMS.HJ0` | MSI MAG Z790 TOMAHAWK WIFI (issue #54) | prepared, one DXE target |
| `E7D41IMS.AO0` | MSI MAG B660 TOMAHAWK WIFI (issue #39, flashed on hardware) | prepared, one DXE target |
| `Z490AORUSELITE.F22` | GIGABYTE Z490 AORUS ELITE | prepared, one DXE target |
| `E7C02AMS.HD0` | MSI B450 TOMAHAWK | refused as ambiguous, then prepared with every DXE domain and USB Flashback recovery |
| `TUF-B450M-PRO-GAMING-ASUS-4401.CAP` | ASUS TUF B450M-PRO GAMING | refused: signed Aptio capsule |
| `PRIME-Z490-A-ASUS-2701.CAP` | ASUS PRIME Z490-A | refused: signed Aptio capsule |
| `TUF-GAMING-X570-PLUS-ASUS-4408.CAP` | ASUS TUF GAMING X570-PLUS | refused: signed Aptio capsule |

The first five come from the injection corpus in
[FIRMWARE_INJECTION_FEASIBILITY.md](FIRMWARE_INJECTION_FEASIBILITY.md); the two MSI 600/700-series
images are the boards of issues #39 and #54.

## Running it

```powershell
npm run build:firmware
npm run tauri:simulated
node tools/fetch-vendor-firmware.mjs
npm run test:real-app
```

`npm run tauri:simulated` builds `target/debug/NvStrapsReBar.exe` with the feature and the
simulated identifier, with the firmware crates compiled at `opt-level = 3` so the injection runs
at release speed. The journeys run one at a time and delete
`%LOCALAPPDATA%\io.github.nvstrapsrebar.simulated` before each image.
