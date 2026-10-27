import { expect, type Page } from "@playwright/test";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { addExternalBoot, bootOrder, bootThroughRoute, decodeBootOrder, describe, efiRelease, projectCertificate, readExternal, sha256, x509SignatureList } from "./external";
import { readMachine, writeMachine } from "./machine";
import { button, heading, test, type RealApp } from "./harness";

// Issue #54's board: its BIOS refuses a changed file, which is what this route is for.
const identity = {
  boardManufacturer: "Micro-Star International Co., Ltd.",
  boardProduct: "MAG Z790 TOMAHAWK WIFI (MS-7D91)",
  boardVersion: "1.0",
  biosVendor: "American Megatrends International, LLC.",
  biosVersion: "1.H0",
  biosReleaseDate: "09/14/2026",
};
const pageTitle = "Turn on Resizable BAR without changing the BIOS";
const gib8 = 8 * 1024 ** 3;

const exists = (path: string) => stat(path).then(() => true, () => false);

async function openPage(app: RealApp, title = pageTitle) {
  await expect(heading(app.page, "You can turn on Resizable BAR")).toBeVisible();
  await button(app.page, "Without changing the BIOS").click();
  await expect(heading(app.page, title)).toBeVisible();
}

async function confirmRestart(page: Page, text: string) {
  await button(page, "Restart").click();
  await expect(page.getByRole("dialog")).toContainText(text);
  await page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
}

async function chooseRecommendedSize(page: Page) {
  await expect(heading(page, "Increase this GPU's BAR size")).toBeVisible();
  await expect(page.getByText("NVIDIA GeForce RTX 2080 SUPER", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^8 GiB/ })).toBeChecked();
  await button(page, "Prepare the trial").click();
}

async function expectPlan(folder: string) {
  const plan = JSON.parse(await readFile(join(folder, "plan.json"), "utf8"));
  expect(plan.size).toBe(gib8);
  expect(plan.target).toEqual({ segment: 0, bus: 1, device: 0, function: 0 });
  expect(plan.handoff.path).toBe("\\EFI\\Microsoft\\Boot\\bootmgfw.efi");
  return plan;
}

test("external route tried from a USB drive", async ({ app }) => {
  let usb = "";
  let variables: Record<string, string> = {};
  await app.step("Start the real application with a FAT32 USB drive and no Secure Boot", async () => {
    await app.initialize(identity);
    ({ usb } = await addExternalBoot(app.machineFile, app.temporaryDirectory, { bitLocker: "off" }));
    variables = structuredClone((await readExternal(app.machineFile)).externalBoot.variables);
    await app.launch();
    await openPage(app);
  });

  await app.step("Write the check program to the USB drive and nothing to the PC", async () => {
    const page = app.page;
    await expect(page.getByRole("radio", { name: /^Try from a USB drive/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^U: NVSTRAPS/ })).toBeChecked();
    await button(page, "Prepare the check").click();
    await expect(heading(page, "Start once from the USB drive")).toBeVisible();
    await expect(page.getByText("As the PC restarts, press F11", { exact: false })).toBeVisible();
    expect(sha256(await readFile(join(usb, "EFI/BOOT/BOOTX64.EFI")))).toBe(sha256(await readFile(join(efiRelease, "NvStrapsDiagnostic.efi"))));
    expect(JSON.parse(await readFile(join(usb, "EFI/NvStraps/owner.json"), "utf8")).stage).toBe("diagnostic");
    expect((await readExternal(app.machineFile)).externalBoot.variables).toEqual(variables);
  });

  await app.step("Boot the USB drive's check and come back to the GPU choice", async () => {
    await confirmRestart(app.page, "Save your work in other open programs first.");
    await app.restartThrough(1, () => bootThroughRoute(app.machineFile, "usb", "diagnostic"));
    await chooseRecommendedSize(app.page);
    await expect(heading(app.page, "Start from the USB drive once more")).toBeVisible();
    expect(sha256(await readFile(join(usb, "EFI/BOOT/BOOTX64.EFI")))).toBe(sha256(await readFile(join(efiRelease, "NvStrapsLoader.efi"))));
    await expectPlan(join(usb, "EFI/NvStraps"));
  });

  await app.step("Boot the loader from the USB drive and see Windows get 8 GiB", async () => {
    await confirmRestart(app.page, "Save your work in other open programs first.");
    await app.restartThrough(2, () => bootThroughRoute(app.machineFile, "usb", "loader"));
    await expect(heading(app.page, "The BAR is now 8 GiB")).toBeVisible();
    await expect(button(app.page, "Install on this PC")).toBeEnabled();
  });

  await app.step("Remove only the app's files from the USB drive", async () => {
    const page = app.page;
    await button(page, "Remove from USB").click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(heading(page, pageTitle)).toBeVisible();
    expect(await exists(join(usb, "EFI/BOOT/BOOTX64.EFI"))).toBe(false);
    expect(await exists(join(usb, "EFI/NvStraps"))).toBe(false);
    expect(await readdir(usb)).toContain("README.txt");
    const machine = await readExternal(app.machineFile);
    expect(machine.externalBoot.variables).toEqual(variables);
    expect(machine.externalBoot.bitLockerSuspensions).toBe(0);
  });
});

test("external route installed on this PC with BitLocker on", async ({ app }) => {
  let esp = "";
  let variables: Record<string, string> = {};
  const ours = async () => {
    const machine = await readExternal(app.machineFile);
    const entries = Object.entries(machine.externalBoot.variables).filter(([name]) => /^Boot[0-9A-F]{4}$/.test(name) && name !== "Boot0000");
    return { machine, order: decodeBootOrder(machine.externalBoot.variables.BootOrder), entries: entries.map(([name, value]) => [name, describe(value)]) };
  };

  await app.step("Start the real application with BitLocker protecting the system drive", async () => {
    await app.initialize(identity);
    ({ esp } = await addExternalBoot(app.machineFile, app.temporaryDirectory, { bitLocker: "on" }));
    variables = structuredClone((await readExternal(app.machineFile)).externalBoot.variables);
    await app.launch();
    await openPage(app);
  });

  await app.step("Install the check on the EFI system partition and schedule it once", async () => {
    const page = app.page;
    await page.getByRole("radio", { name: /^Install on this PC/ }).check();
    await button(page, "Prepare the check").click();
    await expect(heading(page, "The check runs at the next start")).toBeVisible();
    const { machine, order, entries } = await ours();
    expect(entries).toEqual([["Boot0001", "NvStrapsReBar diagnostic"]]);
    expect(order).toEqual([0, 1]);
    expect(machine.externalBoot.variables.BootNext).toBe(bootOrder([1]));
    expect(machine.externalBoot.variables.Boot0000).toBe(variables.Boot0000);
    expect(await exists(join(esp, "EFI/NvStraps/NvStrapsDiagnostic.efi"))).toBe(true);
  });

  await app.step("Pause BitLocker for the restart and run the check", async () => {
    await confirmRestart(app.page, "BitLocker protection pauses for this restart only");
    await app.restartThrough(1, () => bootThroughRoute(app.machineFile, "esp", "diagnostic"));
    expect((await readExternal(app.machineFile)).externalBoot.bitLockerSuspensions).toBe(1);
    await chooseRecommendedSize(app.page);
    await expect(heading(app.page, "Try it at the next start")).toBeVisible();
    const { machine, entries } = await ours();
    const loader = entries.find(([, description]) => description === "NvStrapsReBar")?.[0];
    expect(loader).toBeDefined();
    expect(machine.externalBoot.variables.BootNext).toBe(bootOrder([Number.parseInt(loader!.slice(4), 16)]));
    expect(await exists(join(esp, "EFI/NvStraps/NvStrapsLoader.efi"))).toBe(true);
    const plan = await expectPlan(join(esp, "EFI/NvStraps"));
    expect(Buffer.from(plan.handoff.sha256).toString("hex")).toBe(sha256(await readFile(join(esp, "EFI/Microsoft/Boot/bootmgfw.efi"))));
  });

  await app.step("Try the loader once, then run it on every start", async () => {
    await confirmRestart(app.page, "BitLocker protection pauses for this restart only");
    await app.restartThrough(2, () => bootThroughRoute(app.machineFile, "esp", "loader"));
    expect((await readExternal(app.machineFile)).externalBoot.bitLockerSuspensions).toBe(2);
    await expect(heading(app.page, "The BAR is now 8 GiB")).toBeVisible();
    await button(app.page, "Run on every start").click();
    await expect(heading(app.page, "The BAR size increases on every start")).toBeVisible();
    const { machine, order, entries } = await ours();
    expect(entries.map(([, description]) => description)).toEqual(["NvStrapsReBar"]);
    expect(order[0]).toBe(Number.parseInt(entries[0]![0]!.slice(4), 16));
    expect(order.slice(1)).toEqual([0]);
    expect(machine.externalBoot.variables.BootNext).toBeUndefined();
  });

  await app.step("Remove the boot entry and the files from this PC", async () => {
    const page = app.page;
    await button(page, "Remove from this PC").click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(heading(page, pageTitle)).toBeVisible();
    expect((await readExternal(app.machineFile)).externalBoot.variables).toEqual(variables);
    expect(await exists(join(esp, "EFI/NvStraps"))).toBe(false);
    expect(await exists(join(esp, "EFI/Microsoft/Boot/bootmgfw.efi"))).toBe(true);
  });
});

test("external route with Secure Boot on after the certificate is enrolled", async ({ app }) => {
  let usb = "";
  await app.step("Start with Secure Boot on, signed programs and no project certificate in db", async () => {
    await app.initialize(identity);
    ({ usb } = await addExternalBoot(app.machineFile, app.temporaryDirectory, { bitLocker: "on", secureBoot: true, imagesSigned: true }));
    await app.launch();
    await openPage(app, "Add the certificate to BIOS once");
    await expect(button(app.page, "Prepare the check")).toHaveCount(0);
  });

  await app.step("Save the certificate to the USB drive", async () => {
    const page = app.page;
    await expect(page.getByRole("radio", { name: /^U: NVSTRAPS/ })).toBeChecked();
    await button(page, "Save to USB").click();
    await expect(page.getByText("Saved as U:\\NvStrapsReBar-db.cer.", { exact: true })).toBeVisible();
    expect((await readFile(join(usb, "NvStrapsReBar-db.cer"))).equals(await readFile(projectCertificate))).toBe(true);
  });

  await app.step("Restart into BIOS setup with BitLocker paused once, where the user appends the certificate", async () => {
    await button(app.page, "Restart into BIOS setup").click();
    await expect(app.page.getByRole("dialog")).toContainText("When BIOS setup opens");
    await expect(app.page.getByRole("dialog")).toContainText("BitLocker protection pauses for this restart only");
    await app.page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
    await app.restartThrough(1, async () => {
      const machine = await readExternal(app.machineFile);
      machine.boot.bootTimeUnixMs = machine.rebootRequests.at(-1)!.requestedAtUnixMs + 1;
      machine.externalBoot.db = x509SignatureList(await readFile(projectCertificate)).toString("base64");
      await writeMachine(app.machineFile, machine);
    }, "firmwareSetup");
    expect((await readExternal(app.machineFile)).externalBoot.bitLockerSuspensions).toBe(1);
  });

  await app.step("The route starts with Secure Boot on", async () => {
    const page = app.page;
    await openPage(app);
    await expect(page.locator(".nv-check").filter({ hasText: "Secure Boot" })).toContainText("On · certificate added");
    await button(page, "Prepare the check").click();
    await expect(heading(page, "Start once from the USB drive")).toBeVisible();
    expect((await readMachine(app.machineFile)).rebootRequests.map(request => request.kind)).toEqual(["firmwareSetup"]);
  });
});
