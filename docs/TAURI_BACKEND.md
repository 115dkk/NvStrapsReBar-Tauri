# Tauri backend contract

The embedded React client talks to a deliberately bounded Tauri 2 command surface through
`@tauri-apps/api/core` `invoke`. JSON fields are camel-case. Every rejected command returns an
`ApiError` with `code`, `message`, `recoverable`, and an optional `windowsError`.

The client is not trusted to establish a machine match, firmware identity, patch count,
privilege, durable write, or completed physical action. Rust revalidates those facts at the
native boundary.

## Configuration commands

| Command | Arguments | Result and owner |
| --- | --- | --- |
| `get_system_snapshot` | none | Cached platform, firmware access, driver status, saved config, GPU inventory, machine identity, and notices |
| `refresh_system` | none | Fresh Windows/PCI/EFI enumeration and snapshot |
| `validate_config` | `{ draft }` | Errors, warnings, affected GPUs, encoded size, change state, and reboot requirement without writing |
| `save_config` | `{ draft }` | A save receipt only after the EFI variable is written and read back byte-for-byte |
| `request_elevation` | none | Starts an elevated copy with Windows `runas`, then exits the current copy |
| `get_machine_identity` | none | Exact board, BIOS, GPU, bridge, and BAR0 identity from Windows and live PCI inventory |

`ConfigDraft` follows this wire shape:

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

GPU BAR selectors `0..10` represent 64 MiB through 64 GiB; `254` excludes a GPU. Global mode `1`
uses the canonical Turing registry. Mode `2` additionally falls back to 2 GiB for an otherwise
unlisted Turing device. PCI target values follow the firmware contract: `0` uses the system
default, `1..31` are explicit maximum sizes, `32` permits any supported size, `64` changes only
selected GPUs, and `65` changes GPU straps only.

The backend rejects stale topology, duplicate selectors, unsupported sizes, more than eight
rules, unusable or 64-bit BAR0 ranges, and unaligned BAR0 ranges. Saving requires UEFI mode and
`SeSystemEnvironmentPrivilege`. Readback proves the variable bytes, not that firmware has applied
them; a reboot and driver-status check remain separate steps.

## Deployment commands

| Command | Arguments | Result and owner |
| --- | --- | --- |
| `inspect_firmware_image` | `{ path }` | Canonical absolute path inspection returning file name, byte length, and SHA-256 |
| `analyze_legacy_firmware` | `{ path }` | Read-only rule analysis of the exact image, its fingerprint, pinned upstream commit, catalog hashes, match counts, risks, and blocked reasons |
| `list_legacy_patch_catalogs` | none | Metadata for every compiled-in, content-addressed legacy catalog and rule |
| `create_machine_profile` | `{ request }` | Immutable profile, preserved/re-hashed original, and initial append-only plan |
| `list_machine_profiles` | none | All validated profiles in the application data store |
| `get_deployment_plan` | `{ profileId }` | Newest validated revision from the append-only plan history |
| `compare_machine_profile` | `{ request: { profileId, firmwarePath? } }` | Fresh identity and optional source-image comparison against the pinned profile |
| `prepare_firmware_artifact` | `{ profileId }` | Verified Rust FFS, optional legacy-patch receipt, injected output, and advanced plan revision; never a flash |
| `export_deployment_package` | `{ request: { profileId, destinationRoot } }` | No-overwrite package receipt covering artifact, original, manifests, instructions, and checksums |

`CreateProfileRequest` contains `displayName`, `boardPath`, `firmwarePath`, the mandatory
`expectedFirmware` fingerprint returned by inspection, `recovery`, `firmwareInstall`, and optional
`legacyPatches`. `boardPath` is `nativeResizableBar` or `legacyAbove4g`. The backend derives the
machine identity itself, reloads and re-hashes the source, and rejects a submitted fingerprint
that no longer matches; the client cannot submit an identity or bypass the inspection race guard.

### Legacy firmware analysis

Firmware analysis is bounded to 512 MiB, rejects standard capsules and non-firmware input, and
rechecks byte length and SHA-256 after reading to detect a changed source. Each rule result is:

```ts
type LegacyFirmwareRuleAnalysis = {
  ruleId: string;
  description: string | null;
  sectionType: number;
  requiredRisks: LegacyPatchRisk[];
  status: "applicable" | "absent" | "blocked";
  expectedMatches: number | null;
  blockedReason: string | null;
  recommended: boolean;
};
```

The catalog values are `general`, `haswellAbove4g`, `ivyBridgeUsb3`, `haswellUsb3`, and
`broadwellUsb3`. Risks are `dsdtModification`, `nvramWhitelist`, `usbControllerBlacklist`, and
`experimentalX79`.

`recommended` is true only for an applicable exact match with no declared risk. It is a safe
default-selection hint, not approval to flash. `expectedMatches` is authoritative only for an
applicable result. `blocked` means Rust could not safely prove the target; the client must expose
the reason and cannot select the rule.

A legacy profile pins the analysis `upstreamCommit`, every used catalog `sourceSha256`, each rule
ID and `expectedMatches`, all required risks, and one non-empty `acknowledgements` entry for every
selected risk. Profile creation reloads and re-hashes the source, applies the complete selection
in memory, and discards the output before persisting anything. This catches stale match counts,
overlapping changes, and combinations that fail only when applied together.

## Resumable workflow commands

These commands are the only production path that advances the post-preparation plan. Every call
reloads the exact profile and newest append-only revision, re-enumerates the machine, and requires
the expected active step.

| Command | Arguments | Result and owner |
| --- | --- | --- |
| `preview_manual_deployment_step` | `{ profileId }` | Exact active manual gate, warnings, and a token bound to profile, step, and plan revision; no completion |
| `confirm_manual_deployment_step` | `{ request: { profileId, stepId, confirmationToken, confirmed } }` | New plan revision only for vendor flash, firmware settings, or reviewed NVIDIA application policy |
| `verify_deployment_driver` | `{ profileId }` | Reads exactly eight status bytes and accepts only a known non-error Rust DXE status; the volatile variable also proves the current boot and may advance both boot and driver steps |
| `save_deployment_config` | `{ request: { profileId, draft } }` | Re-enumeration, validation, EFI write, byte-for-byte readback, save receipt, and advanced plan |
| `verify_configuration_reboot` | `{ profileId }` | Advances only when the current Windows boot time is later than the recorded configuration readback time |

Manual confirmation is deliberately narrow. Opening a vendor utility, firmware UI, or Profile
Inspector is not evidence. The token becomes stale as soon as the profile, active step, or plan
revision changes. `RebootAfterFirmware` is not operator-attested: the status variable is
boot-service/runtime-only rather than non-volatile, so a valid current value is stronger evidence
that the Rust driver ran during the current boot.

## Restart and external-adapter commands

| Command | Arguments | Result and owner |
| --- | --- | --- |
| `preview_firmware_setup_reboot` | `{ profileId }` | Current eligible plan step, exact command preview, profile-bound token, and warnings; no restart |
| `reboot_to_firmware_setup` | `{ request: { profileId, confirmationToken, unsavedWorkConfirmed } }` | Acceptance only after revalidation; invokes `shutdown.exe /r /fw /t 0` without `/f` |
| `preview_configuration_reboot` | `{ profileId }` | Revision-bound preview of `shutdown.exe /r /t 0`; no restart or plan transition |
| `reboot_after_configuration` | `{ request: { profileId, confirmationToken, unsavedWorkConfirmed } }` | Restart acceptance with `planAdvanced: false`; deliberately omits `/f` |
| `collect_nvidia_smi_evidence` | `{ profileId }` | Advanced plan plus hashed tool and XML evidence only after every profile GPU has complete BAR1 values, consistent total/used/free, an exact Windows PCI-size match, and a size above 256 MiB |
| `install_nvidia_profile_inspector` | none | Content-addressed installation receipt for the single pinned official release |
| `get_nvidia_profile_inspector_installation` | none | Reverified installation receipt or `null` |
| `backup_nvidia_profiles` | `{ profileId }` | Immutable `.nip` backup and parsed-count manifest receipt |
| `launch_nvidia_profile_inspector` | `{ request: { profileId } }` | Launch receipt only after exact-machine validation, elevation, installation verification, and backup |

Restart acceptance does not prove that Windows restarted, firmware setup opened, firmware was
flashed, or settings changed. The normal restart step advances only after a later boot is observed.
`nvidia-smi` evidence proves the applied BAR1 aperture through two independent local observations;
it does not prove that every application uses ReBAR. Profile Inspector remains a verified external
UI, and launching it never completes the final application-policy gate.

## Persistence, concurrency, and safety invariants

- Long firmware, package, download, process, and evidence operations run off the Tauri event loop.
- A native file or directory picker reduces input burden, but Rust still canonicalizes and
  validates every submitted path.
- Source firmware is copied into an owned profile root and re-hashed. Prepared artifacts and
  exported packages use no-overwrite, readback-verified writes.
- `MachineProfile` is immutable. `DeploymentPlan` revisions are append-only and bound to the
  profile and original-firmware digest.
- Consequential commands re-enumerate the exact machine and require the active plan step rather
  than trusting stale React state.
- A plan revision is written before it replaces the workflow's in-memory state. A failed revision
  write therefore cannot expose a transition that was not durably stored.
- Legacy analysis and preparation never mutate the selected input bytes.
- The reboot adapter deliberately omits `/f`; the user must still save work and provide the
  profile- and revision-bound confirmation token. A request never records reboot completion.
- The bridge exposes no generic shell execution, arbitrary download, firmware-variable name, or
  raw flash command.

## Error contract

Stable error codes are:

- `unsupported_platform`
- `windows_api_error`
- `firmware_unavailable`
- `invalid_configuration`
- `device_inventory_failed`
- `machine_identity_failed`
- `deployment_failed`
- `state_unavailable`
- `elevation_failed`

`recoverable: true` means the caller may present a correction or retry path. It does not mean the
backend partially completed a failed operation, and it never converts a manual or physical gate
into a programmatic success.
