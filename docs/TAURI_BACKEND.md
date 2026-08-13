# Tauri backend contract

The Windows shell exposes a deliberately small command surface. The embedded client calls these
commands with `@tauri-apps/api/core`'s `invoke` function.

| Command | Arguments | Result |
| --- | --- | --- |
| `get_system_snapshot` | none | Current platform, firmware access, driver status, saved draft, GPU inventory, and notices |
| `refresh_system` | none | A newly enumerated system snapshot |
| `validate_config` | `{ draft }` | Validation errors/warnings, change status, encoded size, affected GPUs, and reboot requirement |
| `save_config` | `{ draft }` | A verified save receipt after the EFI variable is written and read back |
| `request_elevation` | none | Starts a new elevated copy through Windows `runas`, then exits the current copy |
| `get_machine_identity` | none | Pins board, BIOS, GPU, bridge, and BAR0 identity from Windows and the live PCI inventory |
| `inspect_firmware_image` | `{ path }` | Resolves an absolute firmware-image path and returns its name, length, and SHA-256 |
| `create_machine_profile` | `{ request }` | Creates an immutable profile, preserves and re-hashes the original image, and starts an append-only plan |
| `list_machine_profiles` | none | Lists all validated local deployment profiles |
| `get_deployment_plan` | `{ profileId }` | Loads the newest validated revision from an append-only plan history |
| `compare_machine_profile` | `{ request }` | Re-enumerates the machine and optionally re-hashes a source image before reporting pinned mismatches |
| `prepare_firmware_artifact` | `{ profileId }` | Revalidates the pinned machine, verifies the bundled Rust FFS, and creates a new immutable patched image without flashing it |

`ConfigDraft` uses camel-case JSON fields:

```ts
type ConfigDraft = {
  globalMode: 0 | 1 | 2;
  targetPciBarSize: number;
  skipS3Resume: boolean;
  overrideBarSizeMask: boolean;
  guardSetupChanges: boolean;
  rules: GpuRule[];
};

type GpuRule = {
  matchScope: "device" | "subsystem" | "location";
  deviceId: number;
  subsystemVendorId: number;
  subsystemDeviceId: number;
  bus: number;
  device: number;
  function: number;
  barSizeSelector: number | null;
  overrideBarSizeMask: boolean | null;
};
```

GPU BAR selectors `0..10` represent 64 MiB through 64 GiB. `254` excludes a GPU. Global mode `1`
uses only sizes in the upstream Turing registry; mode `2` additionally falls back to 2 GiB for an
otherwise unlisted Turing device. PCI target values follow the upstream contract: `0` is the system
default, `1..31` are explicit maximum sizes, `32` permits any size supported by a PCI device, `64`
limits changes to selected GPUs, and `65` changes GPU straps only.

The backend rejects stale hardware matches, duplicate selectors, unsupported sizes, more than eight
rules, unusable or 64-bit BAR0 ranges, and unaligned BAR0 ranges. Saving requires UEFI mode and the
`SeSystemEnvironmentPrivilege`. A successful save is always read back byte-for-byte and requires a
reboot before the firmware driver can apply it.
