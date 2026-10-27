import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repository } from "./harness";
import { readMachine, writeMachine, type Machine } from "./machine";

/**
 * The world around the external route for the simulated machine: an EFI system partition and a
 * USB drive as folders, the EFI global boot variables, Secure Boot and BitLocker. A "boot" here is
 * the harness doing what the firmware and the EFI programs would have done (docs/REAL_APP_E2E.md).
 */

export const ESP_PARTITION_GUID = "02d5d49a-d31c-11eb-9de1-d850e6dcccd2";
export const USB_ROOT = "U:\\";
export const efiRelease = join(repository, "target/x86_64-unknown-uefi/release");
const fixture = join(repository, "tests/real-app/fixtures/external-diagnostic.json");

type BitLocker = "off" | "on" | "unknown";
export type ExternalBoot = {
  secureBoot: boolean;
  bitLocker: BitLocker;
  bitLockerSuspensions: number;
  esp: { partitionGuid: string; directory: string } | null;
  usbDrives: { root: string; directory: string; label: string; fileSystem: string; totalBytes: number }[];
  variables: Record<string, string>;
};
export type ExternalMachine = Machine & { externalBoot: ExternalBoot };

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ucs2z = (text: string) => Buffer.from(`${text}\0`, "utf16le");

/** A GPT GUID in the mixed-endian byte order of a MEDIA/HARDDRIVE device path node. */
function guidBytes(guid: string) {
  const bytes = Buffer.from(guid.replaceAll("-", ""), "hex");
  return Buffer.concat([
    Buffer.from(bytes.subarray(0, 4)).reverse(),
    Buffer.from(bytes.subarray(4, 6)).reverse(),
    Buffer.from(bytes.subarray(6, 8)).reverse(),
    bytes.subarray(8),
  ]);
}

/** The EFI_LOAD_OPTION Windows writes for its boot manager: HD(GPT) / FILEPATH / END. */
export function windowsBootManagerOption() {
  const drive = Buffer.alloc(42);
  drive.writeUInt8(4, 0);
  drive.writeUInt8(1, 1);
  drive.writeUInt16LE(42, 2);
  drive.writeUInt32LE(1, 4);
  drive.writeBigUInt64LE(2048n, 8);
  drive.writeBigUInt64LE(204_800n, 16);
  guidBytes(ESP_PARTITION_GUID).copy(drive, 24);
  drive.writeUInt8(2, 40);
  drive.writeUInt8(2, 41);
  const path = ucs2z("\\EFI\\Microsoft\\Boot\\bootmgfw.efi");
  const file = Buffer.alloc(4);
  file.writeUInt8(4, 0);
  file.writeUInt8(4, 1);
  file.writeUInt16LE(4 + path.length, 2);
  const devicePath = Buffer.concat([drive, file, path, Buffer.from([0x7f, 0xff, 0x04, 0x00])]);
  const head = Buffer.alloc(6);
  head.writeUInt32LE(1, 0);
  head.writeUInt16LE(devicePath.length, 4);
  return Buffer.concat([head, ucs2z("Windows Boot Manager"), devicePath]);
}

export const bootOrder = (numbers: number[]) => {
  const bytes = Buffer.alloc(numbers.length * 2);
  numbers.forEach((number, index) => bytes.writeUInt16LE(number, index * 2));
  return bytes.toString("base64");
};

export const decodeBootOrder = (value: string | undefined) => {
  const bytes = Buffer.from(value ?? "", "base64");
  return Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readUInt16LE(index * 2));
};

export const bootName = (number: number) => `Boot${number.toString(16).toUpperCase().padStart(4, "0")}`;

/** The description of a load option: UCS-2 from byte 6 up to its terminating NUL. */
export function describe(value: string) {
  const bytes = Buffer.from(value, "base64");
  let end = 6;
  while (end + 1 < bytes.length && bytes.readUInt16LE(end) !== 0) end += 2;
  return bytes.subarray(6, end).toString("utf16le");
}

/** Adds the external-route world to a freshly initialized machine file. */
export async function addExternalBoot(machineFile: string, temporaryDirectory: string, options: { bitLocker: BitLocker }) {
  const esp = join(temporaryDirectory, "esp");
  const usb = join(temporaryDirectory, "usb-u");
  await mkdir(join(esp, "EFI/Microsoft/Boot"), { recursive: true });
  await mkdir(usb, { recursive: true });
  // Any AMD64 EFI application passes the successor check; the loader never runs it here.
  await copyFile(join(efiRelease, "NvStrapsDiagnostic.efi"), join(esp, "EFI/Microsoft/Boot/bootmgfw.efi"));
  await writeFile(join(usb, "README.txt"), "a file the app must leave alone\n");
  const machine = (await readMachine(machineFile)) as ExternalMachine;
  machine.externalBoot = {
    secureBoot: false,
    bitLocker: options.bitLocker,
    bitLockerSuspensions: 0,
    esp: { partitionGuid: ESP_PARTITION_GUID, directory: esp },
    usbDrives: [{ root: USB_ROOT, directory: usb, label: "NVSTRAPS", fileSystem: "FAT32", totalBytes: 8_000_000_000 }],
    variables: {
      BootOrder: bootOrder([0]),
      Boot0000: windowsBootManagerOption().toString("base64"),
      BootCurrent: bootOrder([0]),
    },
  };
  await writeMachine(machineFile, machine);
  return { esp, usb };
}

export async function readExternal(machineFile: string) {
  return (await readMachine(machineFile)) as ExternalMachine;
}

type Program = "diagnostic" | "loader";

/** What the firmware starts: BootNext first, then the first BootOrder entry; a USB stage only when the boot menu picks the drive. */
function programAt(machine: ExternalMachine, medium: "usb" | "esp", owner: { stage: Program } | null): Program | null {
  if (medium === "usb") return owner?.stage ?? null;
  const variables = machine.externalBoot.variables;
  const next = variables.BootNext ? decodeBootOrder(variables.BootNext)[0] : decodeBootOrder(variables.BootOrder)[0];
  const option = next === undefined ? undefined : variables[bootName(next)];
  const description = option ? describe(option) : "";
  return description === "NvStrapsReBar diagnostic" ? "diagnostic" : description === "NvStrapsReBar" ? "loader" : null;
}

/**
 * Call only after closing the application. Boots the machine once through the route: the
 * diagnostic writes the fixture report, the loader writes its receipt and widens BAR1 to the
 * planned size, exactly where and how the EFI programs do.
 */
export async function bootThroughRoute(machineFile: string, medium: "usb" | "esp", expected: Program) {
  const machine = await readExternal(machineFile);
  const request = machine.rebootRequests.at(-1) as { kind: string; requestedAtUnixMs: number } | undefined;
  expect(request?.kind).toBe("externalBoot");
  machine.boot.bootTimeUnixMs = request!.requestedAtUnixMs + 1;
  const directory = medium === "usb" ? machine.externalBoot.usbDrives[0]!.directory : machine.externalBoot.esp!.directory;
  const folder = join(directory, "EFI/NvStraps");
  const owner = JSON.parse(await readFile(join(folder, "owner.json"), "utf8")) as { stage: Program };
  expect(programAt(machine, medium, owner)).toBe(expected);
  // The firmware deletes BootNext before it starts the entry.
  delete machine.externalBoot.variables.BootNext;
  if (expected === "diagnostic") {
    await copyFile(fixture, join(folder, "diagnostic.json"));
  } else {
    const plan = JSON.parse(await readFile(join(folder, "plan.json"), "utf8")) as {
      sourceSha256: number[];
      target: { segment: number; bus: number; device: number; function: number };
      size: number;
      destination: { start: number };
    };
    const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");
    const receipt = [
      "schema=1",
      "environment=Physical",
      `source=${Buffer.from(plan.sourceSha256).toString("hex")}`,
      `target=${hex(plan.target.segment, 4)}:${hex(plan.target.bus, 2)}:${hex(plan.target.device, 2)}.${plan.target.function.toString(16)}`,
      `sizeBytes=${plan.size}`,
      `bar1Base=0x${plan.destination.start.toString(16)}`,
      `measuredBytes=${plan.size}`,
      "phase=before-handoff",
      "",
    ].join("\n");
    await writeFile(join(folder, `receipt-${sha256(Buffer.from(receipt)).slice(0, 8)}.txt`), receipt);
    await rm(join(folder, "last-error.txt"), { force: true });
    machine.gpus[0]!.bar1Bytes = plan.size;
  }
  await writeMachine(machineFile, machine);
}
