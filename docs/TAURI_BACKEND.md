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
