import { expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

export interface BoardIdentity {
  boardManufacturer: string;
  boardProduct: string;
  boardVersion: string;
  biosVendor: string;
  biosVersion: string;
  biosReleaseDate: string;
}

export interface VendorImage {
  id: string;
  url: string;
  member: string;
  imageBytes: number;
  imageSha256: string;
  imagePath: string;
  identity: BoardIdentity;
  outcome: "prepared" | "preparedEveryDomain" | "refusedSignedCapsule";
}

type Location = { bus: number; device: number; function: number };
export type RebootKind = "firmwareSetup" | "configuration";
export const recommendedBarBytes = 8 * 1024 ** 3;

export function initialMachine(identity: BoardIdentity) {
  return {
    schema: 1,
    platform: { uefi: true, elevated: true },
    boot: { bootTimeUnixMs: Date.now() - 3_600_000 },
    identity,
    gpus: [{
      name: "NVIDIA GeForce RTX 2080 SUPER",
      vendorId: 0x10de,
      deviceId: 0x1e81,
      subsystemVendorId: 0x1462,
      subsystemDeviceId: 0x3755,
      location: { bus: 1, device: 0, function: 0 },
      bridge: { vendorId: 0x8086, deviceId: 0xaa39, location: { bus: 0, device: 1, function: 0 } },
      bar0Base: 0x80000000,
      bar0Top: 0x80ffffff,
      bar1Bytes: 256 * 1024 ** 2,
      dedicatedVideoMemoryBytes: recommendedBarBytes,
    }],
    firmwareVariables: {
      NvStrapsReBar: null as string | null,
      NvStrapsReBarStatus: null as string | null,
    },
    nvidiaSmi: { installed: true, driverVersion: "596.36" },
    rebootRequests: [] as { kind: RebootKind; requestedAtUnixMs: number }[],
  };
}

export type Machine = ReturnType<typeof initialMachine>;

export async function readMachine(file: string): Promise<Machine> {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeMachine(file: string, machine: Machine) {
  await writeFile(file, `${JSON.stringify(machine, null, 2)}\n`);
}

/** nvstraps-core's DecodedStatus::encode and PciLocation::pack, without JS number truncation. */
function statusValue(code: number, location?: Location) {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(code, 0);
  if (location) {
    bytes.writeUInt16LE((location.bus << 8) | (location.device << 3) | location.function, 6);
  }
  return bytes.toString("base64");
}

/** Call only after closing the application, so its read/modify/write cannot race this edit. */
export async function advanceBoot(file: string, kind: RebootKind) {
  const machine = await readMachine(file);
  const request = machine.rebootRequests.at(-1);
  expect(request?.kind).toBe(kind);
  // The machine boots right after the request it answers: later than anything saved before it,
  // and in the past by the time the application starts again.
  machine.boot.bootTimeUnixMs = request!.requestedAtUnixMs + 1;
  if (kind === "firmwareSetup") {
    expect(machine.firmwareVariables.NvStrapsReBar).toBeNull();
    machine.firmwareVariables.NvStrapsReBarStatus = statusValue(40);
  } else {
    expect(machine.firmwareVariables.NvStrapsReBar).not.toBeNull();
    // The guarded preset disables PCI resizing, becoming EffectiveTarget::StrapsOnly.
    // engine.rs records GpuStrapsConfirm (100), not GpuReBarConfigured (120), when
    // the GPU advertises the size. Location 01:00.0 packs to 0x0100 in bits 48..63.
    machine.firmwareVariables.NvStrapsReBarStatus = statusValue(100, machine.gpus[0].location);
    // The journey asserts "8 GiB" on the backend recommendation immediately before
    // saving it; use that asserted size instead of duplicating the config wire decoder.
    machine.gpus[0].bar1Bytes = recommendedBarBytes;
  }
  await writeMachine(file, machine);
}
