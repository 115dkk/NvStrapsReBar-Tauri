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

const createProfile = async (
        firmwareTargetPolicy: "requireUnique" | "patchEveryDxeDomain" =
                "requireUnique",
) => {
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
                firmwareTargetPolicy,
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
                const preparation =
                        await previewDeploymentAdapter.prepareFirmwareArtifact(
                                bundle.profile.profileId,
                        );
                expect(preparation.injection).toMatchObject({
                        firmwareTargetPolicy: "requireUnique",
                        patchedTargetCount: 1,
                        grewFirmwareVolume: false,
                        firmwareVolumeGrowthBytes: 0,
                        targets: [
                                expect.objectContaining({
                                        targetContainerFileOffsets: [],
                                        grewFirmwareVolume: false,
                                }),
                        ],
                });
                expect(preparation.firmwareInjectionReceipt).toMatchObject({
                        kind: "firmwareInjectionReceipt",
                        sha256: "85".repeat(32),
                });
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

        it("preserves the all-domain policy in the profile and durable injection receipt", async () => {
                const unique = await createProfile();
                const bundle = await createProfile("patchEveryDxeDomain");
                const preparation =
                        await previewDeploymentAdapter.prepareFirmwareArtifact(
                                bundle.profile.profileId,
                        );

                expect(bundle.profile.firmwareTargetPolicy).toBe(
                        "patchEveryDxeDomain",
                );
                expect(bundle.profile.profileId).not.toBe(
                        unique.profile.profileId,
                );
                expect(preparation.injection).toMatchObject({
                        firmwareTargetPolicy: "patchEveryDxeDomain",
                        policyVersion: 1,
                        sourceSha256: bundle.profile.originalFirmware.sha256,
                        driverSha256: "72".repeat(32),
                        patchedFirmwareSha256: "83".repeat(32),
                        censusSha256: "84".repeat(32),
                        patchedTargetCount: 1,
                });
        });

        it("loads older preview profiles with the require-unique default", async () => {
                await createProfile();
                const stored = JSON.parse(
                        sessionStorage.getItem("nvstraps-preview-profiles")!,
                ) as Record<string, unknown>[];
                delete stored[0]!.firmwareTargetPolicy;
                sessionStorage.setItem(
                        "nvstraps-preview-profiles",
                        JSON.stringify(stored),
                );

                const [restored] =
                        await previewDeploymentAdapter.listMachineProfiles();
                expect(restored?.firmwareTargetPolicy).toBe("requireUnique");
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
