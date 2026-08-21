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
| `get_system_snapshot` | none | Cached platform, firmware access, current-boot DXE observation, BAR Settings tokens, saved config, GPU inventory, machine identity, and notices |
| `refresh_system` | none | Fresh Windows/PCI/EFI enumeration and snapshot |
| `validate_config` | `{ draft }` | Errors, warnings, affected GPUs, encoded size, change state, and reboot requirement without writing |
| `save_config` | `{ draft }` | A save receipt only after the EFI variable is written and read back byte-for-byte |
| `save_bar_settings` | `{ request: { draft, expectedTopologyToken, expectedConfigToken } }` | Settings-only save after control-evidence, topology, and saved-configuration revalidation, followed by exact readback |
| `request_elevation` | none | Starts one elevated copy with Windows `runas`, then exits the current copy; concurrent duplicate requests are idempotent |

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

Elevation is single-flight at both renderer and native boundaries. The Rust application state
allows only one `runas` launch per process; a duplicate command returns without launching another
copy. If the launch fails or UAC is cancelled, the gate resets so a later explicit retry remains
possible.

### BAR Settings state

`SystemSnapshot.barSettings` keeps three facts separate:

~~~ts
type BarSettingsStatus = {
  currentBootDxeState:
    | "observedThisBoot"
    | "notObservedThisBoot"
    | "indeterminate";
  currentBootDxeReasonCode:
    | "currentBootStatusObserved"
    | "statusVariableMissing"
    | "statusVariableMalformed"
    | "statusVariableUnavailable"
    | "statusValueUnrecognized";
  controlEvidence:
    | "currentBootDxe"
    | "expandedTuringAperture"
    | "notObserved"
    | "indeterminate";
  settingsAvailable: boolean;
  savedConfigurationState: "enabled" | "disabled" | "invalid" | "unreadable";
  topologyToken: string;
  configToken: string | null;
};
~~~

The status variable is volatile. A recognized status, including a driver-reported error, proves
that the DXE driver executed during this boot. It does not prove permanent installation. An
expanded Windows aperture on a canonical Turing GPU is a second control-evidence path because
Turing has no native expanded-ReBAR path. It keeps older upstream installations usable when the
status variable is absent or unreadable. The non-volatile configuration alone never unlocks
Settings.

`settingsAvailable` describes whether BAR Settings applies to the machine, not whether the
current process can read or write EFI variables. Without elevation it can therefore be `true`
while `savedConfigurationState` is `unreadable` and `configToken` is `null`. The renderer must
request elevation instead of constructing an editable default draft in that state.

The topology token covers every NVIDIA GPU identity, PCI location, parent bridge, and BAR0 range
in canonical order. The configuration token covers the exact current EFI-variable bytes. A
`save_bar_settings` request re-reads both and returns `stale_topology` or
`stale_configuration` before writing when either token changed. The command also rechecks
current-boot DXE or expanded-Turing evidence, validates and rebuilds the wire model from the fresh
inventory, writes the variable, and requires exact readback.

Upstream E/D behavior changes only the global automatic-GPU policy. It is not a universal ReBAR
boolean: target PCI sizing and per-GPU rules are independent `ConfigDraft` fields. A completely
default draft encodes as deletion of the saved operational configuration.

## Deployment commands

| Command | Arguments | Result and owner |
| --- | --- | --- |
| `inspect_firmware_image` | `{ path }` | Canonical absolute path inspection returning file name, byte length, and SHA-256 |
| `analyze_legacy_firmware` | `{ path }` | Read-only rule analysis of the exact image, its fingerprint, pinned upstream commit, catalog hashes, match counts, risks, and blocked reasons |
| `create_machine_profile` | `{ request }` | Immutable profile, preserved/re-hashed original, and initial append-only plan |
| `list_machine_profiles` | none | All validated profiles in the application data store |
| `get_deployment_plan` | `{ profileId }` | Newest validated revision from the append-only plan history |
| `compare_machine_profile` | `{ request: { profileId, firmwarePath? } }` | Fresh identity comparison against the newest pinned boot observation (or initial profile), plus optional preserved source-image comparison |
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
`broadwellUsb3`. Risks are `dsdtModification`, `nvramWhitelist`, and `usbControllerBlacklist`.

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
| `get_recommended_deployment_config` | `{ profileId }` | Re-enumerated, exact-machine guarded `ConfigDraft` plus Turing, registry-managed, and exact-fallback counts; only valid at the configuration-write step |
| `save_deployment_config` | `{ request: { profileId, draft } }` | Re-enumeration, validation, EFI write, byte-for-byte readback, save receipt, and advanced plan |
| `verify_configuration_reboot` | `{ profileId }` | Advances only when the current Windows boot time is later than the recorded configuration readback time |

Manual confirmation is deliberately narrow. Opening a vendor utility, firmware UI, or Profile
Inspector is not evidence. The token becomes stale as soon as the profile, active step, or plan
revision changes. `RebootAfterFirmware` is not operator-attested: the status variable is
boot-service/runtime-only rather than non-volatile, so a valid current value is stronger evidence
that the Rust driver ran during the current boot.

The recommended draft uses canonical registry mode `1`, system-default PCI sizing, setup-change
protection, and no global mask override. Each unlisted Turing GPU receives a deterministic
exact-location fallback rule using its backend-derived selector; non-Turing inventory cannot
produce a recommendation. Rust builds the complete wire model before returning the recommendation
and rederives it at save time; the submitted draft must be identical before Rust rebuilds the wire
model, so the client cannot turn a preview constant into a different privileged write.

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
- Before the first proven post-flash boot, comparison permits only BIOS version/release date and
  BAR0 to change. The resulting `BootObservation` becomes the exact identity. The later
  configuration reboot permits only BAR0 relocation and re-pins it the same way.
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
- `bar_settings_control_not_observed`
- `stale_topology`
- `stale_configuration`
- `readback_mismatch`
- `invalid_configuration`
- `device_inventory_failed`
- `machine_identity_failed`
- `deployment_failed`
- `state_unavailable`
- `elevation_failed`

`recoverable: true` means the caller may present a correction or retry path. It does not mean the
backend partially completed a failed operation, and it never converts a manual or physical gate
into a programmatic success.
