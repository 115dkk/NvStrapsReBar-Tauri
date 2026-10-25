import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { button, heading, repository, runFile, test, type RealApp } from "./harness";
import { readMachine, type VendorImage } from "./machine";

const loaderUrl = pathToFileURL(join(repository, "tools/fetch-vendor-firmware.mjs")).href;
const { loadVendorImages }: { loadVendorImages: (options?: { dir?: string }) => VendorImage[] } = await import(loaderUrl);
// This API only reads the manifest. Missing or corrupt cached images fail; never download here.
const images = loadVendorImages({ dir: process.env.NVSTRAPS_VENDOR_FIRMWARE_DIR });
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const recoveryHeading = "Choose how to recover if the BIOS install fails";
const ambiguousMessage = "This BIOS has multiple boot or recovery areas. To change all of them, choose USB Flashback or External SPI programmer as the recovery method, confirm the instructions, select “Add the driver to all boot and recovery areas,” then create the profile again.";
const capsuleMessage = "This BIOS update file cannot be used here. Use a full BIOS backup read from the motherboard, or a BIOS-region backup with a verified region map. Do not extract and reuse part of this update file.";

async function verifyPackage(app: RealApp, image: VendorImage) {
  const directories = (await readdir(app.exportFolder, { withFileTypes: true })).filter(entry => entry.isDirectory());
  expect(directories).toHaveLength(1);
  expect(directories[0].name).toMatch(/^NvStrapsReBar-/);
  const packagePath = join(app.exportFolder, directories[0].name);
  const exported = join(packagePath, "flash", basename(image.imagePath));
  expect((await stat(exported)).size).toBe(image.imageBytes);
  const actual = await readFile(exported);
  expect(sha256(actual)).not.toBe(image.imageSha256);
  const reference = join(app.temporaryDirectory, "reference.bin");
  await runFile(join(repository, "target/debug/nvstraps-ffs.exe"), [
    image.outcome === "preparedEveryDomain" ? "inject-all" : "inject",
    image.imagePath,
    join(repository, "target/x86_64-unknown-uefi/release/NvStrapsReBar.ffs"),
    reference,
  ], { cwd: repository, timeout: 240_000, maxBuffer: 1024 * 1024 });
  // Avoid including firmware bytes in a failed assertion's output.
  expect(actual.equals(await readFile(reference)), "export equals the reference injector byte for byte").toBe(true);
  for (const file of [
    "recovery/original-firmware.bin",
    "receipts/machine-profile.json",
    "receipts/deployment-plan.json",
    "receipts/firmware-injection-receipt.json",
    "DEPLOYMENT.txt",
    "DEPLOYMENT.ko.txt",
    "deployment-manifest.json",
    "SHA256SUMS.txt",
  ]) {
    expect((await stat(join(packagePath, file))).isFile(), file).toBe(true);
  }
  // Only an exact catalog board's USB flashback route gets a vendor-named recovery copy.
  expect(await readdir(app.exportFolder)).toEqual([directories[0].name]);
}

for (const image of images) {
  test(`${image.id} (${image.outcome})`, async ({ app }) => {
    await app.step("Start the real Tauri application with the pinned vendor image", async () => {
      const source = await readFile(image.imagePath);
      expect(source.length).toBe(image.imageBytes);
      expect(sha256(source)).toBe(image.imageSha256);
      await app.initialize(image.identity);
      await app.launch();
      await expect(heading(app.page, "You can turn on Resizable BAR")).toBeVisible();
      await expect(app.page.getByText("This PC · RTX 2080 SUPER · this boot")).toBeVisible();
      await expect(app.page.getByRole("img", { name: "Now 256 MiB, 8 GiB when on" })).toBeVisible();
    });

    await app.step("Read the BIOS image through the manual path field", async () => {
      const page = app.page;
      await button(page, "Get started").click();
      await expect(heading(page, "Choose the motherboard BIOS file")).toBeVisible();
      await expect(page.locator("[data-screen]")).toHaveAttribute("data-screen", "pickFirmware");
      await expect(page.getByText(`This PC's motherboard is ${image.identity.boardManufacturer} ${image.identity.boardProduct}.`, { exact: false })).toBeVisible();
      await page.getByText("Type the file location instead", { exact: true }).click();
      await page.getByPlaceholder("Choose a vendor BIOS image or enter an absolute path").fill(image.imagePath);
      await button(page, "Read file").click();
      await expect(heading(page, "Choose whether BIOS setup has a Re-Size BAR item")).toBeVisible();
      await expect(page.getByText(basename(image.imagePath), { exact: true })).toBeVisible();
      await expect(page.getByText(`${Math.round(image.imageBytes / 1048576)} MiB · read`, { exact: true })).toBeVisible();
      await page.getByRole("radio", { name: /^Has Re-Size BAR/ }).check();
      await button(page, "Next").click();
      await expect(heading(page, "Choose how to install the BIOS")).toBeVisible();
      await page.getByRole("textbox", { name: /^Manual address \(https:\/\/\)/ }).fill(image.url);
      await button(page, "Next").click();
      await expect(heading(page, recoveryHeading)).toBeVisible();
      await expect(page.getByRole("radio", { name: /^Maker's recovery feature/ })).toBeChecked();
      await button(page, "Checked · make the file").click();
    });

    if (image.outcome === "refusedSignedCapsule") {
      await app.step("Refuse the signed capsule without leaving the recovery question", async () => {
        await expect(app.page.getByRole("alert")).toContainText(capsuleMessage);
        await expect(heading(app.page, recoveryHeading)).toBeVisible();
        await expect(button(app.page, "Checked · make the file")).toBeEnabled();
        await expect(button(app.page, "Save to USB")).toHaveCount(0);
        expect(await readdir(app.exportFolder)).toEqual([]);
        expect((await readMachine(app.machineFile)).rebootRequests).toEqual([]);
        app.assertHealthy();
      });
      return;
    }

    if (image.outcome === "preparedEveryDomain") {
      await app.step("Refuse ambiguous targets, then explicitly select every domain with Flashback recovery", async () => {
        const page = app.page;
        await expect(page.getByRole("alert")).toContainText(ambiguousMessage);
        await expect(heading(page, recoveryHeading)).toBeVisible();
        expect(await readdir(app.exportFolder)).toEqual([]);
        await page.getByRole("radio", { name: /^USB Flashback button/ }).check();
        await page.getByText("Advanced options", { exact: true }).click();
        await page.getByRole("checkbox", { name: /^Add the driver to all boot and recovery areas/ }).check();
        await button(page, "Checked · make the file").click();
      });
    }

    await app.step("Make and export the install BIOS, then compare against the reference injector", async () => {
      const page = app.page;
      await expect(heading(page, "Making the install BIOS file")).toBeVisible();
      await expect(heading(page, "Save to USB")).toBeVisible({ timeout: 180_000 });
      await expect(page.getByText("The install BIOS file is ready", { exact: true })).toBeVisible();
      await expect(page.getByText(`NvStrapsReBar was added to ${basename(image.imagePath)} and the file passed the check.`, { exact: true })).toBeVisible();
      app.queueFolder(app.exportFolder);
      await button(page, "Save to USB").click();
      await expect(heading(page, "Install it in BIOS setup")).toBeVisible();
      await expect(page.getByText(basename(image.imagePath), { exact: false }).first()).toBeVisible();
      await verifyPackage(app, image);
    });

    await app.step("Request BIOS setup and reopen after the unconfigured driver ran", async () => {
      await button(app.page, "Restart into BIOS setup").click();
      await expect(app.page.getByRole("dialog")).toContainText("Save your work in other open programs first.");
      await app.page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
      await app.reboot("firmwareSetup");
      await expect(heading(app.page, "Record what you did in BIOS setup")).toBeVisible();
      await expect(app.page.getByText("NvStrapsReBar in the BIOS ran", { exact: true })).toBeVisible();
    });

    await app.step("Record installation and save the backend's 8 GiB recommendation", async () => {
      const page = app.page;
      await button(page, "Record install and settings").click();
      await expect(heading(page, "Ready to turn on Resizable BAR")).toBeVisible();
      await expect(page.getByText("NvStrapsReBar is running", { exact: true })).toBeVisible();
      await expect(page.locator(".nv-gpu .nv-size.target")).toHaveText("8 GiB");
      await button(page, "Save these settings").click();
      await expect(heading(page, "Restart to turn it on")).toBeVisible();
      await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
      expect((await readMachine(app.machineFile)).firmwareVariables.NvStrapsReBar).not.toBeNull();
    });

    await app.step("Request configuration reboot and verify the measured before/after sizes", async () => {
      await button(app.page, "Restart").click();
      await expect(app.page.getByRole("dialog")).toContainText("The new size is checked automatically.");
      await app.page.getByRole("dialog").getByRole("button", { name: "Restart", exact: true }).click();
      await app.reboot("configuration");
      await expect(heading(app.page, "Resizable BAR is on")).toBeVisible();
      await expect(app.page.getByRole("img", { name: "Before 256 MiB, now 8 GiB" })).toBeVisible();
      await expect(app.page.getByText("Size reported by NVIDIA driver 596.36 after the restart.", { exact: true })).toBeVisible();
      await button(app.page, "Done").click();
      await expect(heading(app.page, "Resizable BAR is on")).toBeVisible();
      await expect(app.page.getByTestId("home")).toBeVisible();
    });
  });
}
