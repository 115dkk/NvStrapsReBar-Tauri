import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewDeploymentAdapter } from "./preview-adapter";

class MemoryStorage {
        private values = new Map<string, string>();
        getItem(key: string) {
                return this.values.get(key) ?? null;
        }
        setItem(key: string, value: string) {
                this.values.set(key, value);
        }
        removeItem(key: string) {
                this.values.delete(key);
        }
        clear() {
                this.values.clear();
        }
}

const createProfile = async () => {
        const expectedFirmware =
                await previewDeploymentAdapter.inspectFirmwareImage(
                        "C:\\Firmware\\E7D25IMS.1N0",
                );
        return previewDeploymentAdapter.createMachineProfile({
                displayName: "Fixture profile",
                boardPath: "nativeResizableBar",
                firmwarePath: "C:\\Firmware\\E7D25IMS.1N0",
                expectedFirmware,
                recovery: {
                        method: "usbFlashback",
                        testedOrDocumented: true,
                        note: "fixture",
                },
                firmwareInstall: {
                        method: "firmwareSetupUtility",
                        artifactFileName: "E7D25IMS.1N0",
                        testedOrDocumented: true,
                        officialInstructionsUrl: "https://example.test/manual",
                        note: "fixture",
                },
        });
};

describe("browser preview deployment fixture ledger", () => {
        beforeEach(() => {
                vi.stubGlobal("sessionStorage", new MemoryStorage());
        });

        it("restores the canned receipt cursor after a client reload", async () => {
                const bundle = await createProfile();
                await previewDeploymentAdapter.prepareFirmwareArtifact(
                        bundle.profile.profileId,
                );
                const restored =
                        await previewDeploymentAdapter.getDeploymentPlan(
                                bundle.profile.profileId,
                        );
                expect(restored.revision).toBe(6);
                expect(
                        restored.steps.find((step) => step.state === "ready")
                                ?.id,
                ).toBe("flashWithVendorRoute");
        });

        it("injects malformed receipt faults without persisting the bad cursor", async () => {
                const bundle = await createProfile();
                await previewDeploymentAdapter.prepareFirmwareArtifact(
                        bundle.profile.profileId,
                );
                const flash =
                        await previewDeploymentAdapter.previewManualDeploymentStep(
                                bundle.profile.profileId,
                        );
                await previewDeploymentAdapter.confirmManualDeploymentStep(
                        flash,
                );
                const setup =
                        await previewDeploymentAdapter.previewManualDeploymentStep(
                                bundle.profile.profileId,
                        );
                await previewDeploymentAdapter.confirmManualDeploymentStep(
                        setup,
                );
                await previewDeploymentAdapter.verifyDeploymentDriver(
                        bundle.profile.profileId,
                );
                const recommendation =
                        await previewDeploymentAdapter.getRecommendedDeploymentConfig(
                                bundle.profile.profileId,
                        );
                sessionStorage.setItem(
                        "nvstraps-preview-malformed-receipt",
                        "profile",
                );
                const receipt =
                        await previewDeploymentAdapter.saveDeploymentConfig(
                                bundle.profile.profileId,
                                recommendation.draft,
                        );
                expect(receipt.plan.profileId).not.toBe(
                        bundle.profile.profileId,
                );
                const restored =
                        await previewDeploymentAdapter.getDeploymentPlan(
                                bundle.profile.profileId,
                        );
                expect(restored.revision).toBe(10);
                expect(
                        restored.steps.find((step) => step.state === "ready")
                                ?.id,
                ).toBe("writeNvstrapsConfiguration");
        });

        it("rejects a manual token that is not bound to the fixture revision", async () => {
                const bundle = await createProfile();
                await previewDeploymentAdapter.prepareFirmwareArtifact(
                        bundle.profile.profileId,
                );
                const preview =
                        await previewDeploymentAdapter.previewManualDeploymentStep(
                                bundle.profile.profileId,
                        );
                await expect(
                        previewDeploymentAdapter.confirmManualDeploymentStep({
                                ...preview,
                                confirmationToken: `${preview.confirmationToken}-STALE`,
                        }),
                ).rejects.toThrow(
                        "does not match this profile, step, and plan revision",
                );
        });
});
