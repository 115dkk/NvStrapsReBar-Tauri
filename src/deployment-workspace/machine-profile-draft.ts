import type {
        CreateProfileRequest,
        RecoveryMethod,
} from "./contract";
import type { DeploymentWorkspaceView } from "./session-contract";

const fileName = (path: string) => path.split(/[\\/]/).at(-1) || "firmware.bin";

export const isBootIndependentRecoveryMethod = (method: RecoveryMethod) =>
        method === "usbFlashback" || method === "externalSpiProgrammer";

export const buildMachineProfileRequest = (
        view: DeploymentWorkspaceView,
): CreateProfileRequest => {
        if (!view.firmware) {
                throw new Error(
                        "A firmware fingerprint is required to create a profile.",
                );
        }
        if (
                view.firmwareTargetPolicy === "patchEveryDxeDomain" &&
                (!view.routeConfirmed ||
                        !isBootIndependentRecoveryMethod(view.recoveryMethod))
        ) {
                throw new Error(
                        "Patching every DXE firmware domain requires a tested or documented USB Flashback or external SPI recovery route.",
                );
        }

        return {
                displayName: view.displayName,
                boardPath: view.boardPath,
                firmwarePath: view.firmwarePath,
                expectedFirmware: structuredClone(view.firmware),
                recovery: {
                        method: view.recoveryMethod,
                        testedOrDocumented: view.routeConfirmed,
                        note: view.recoveryNote,
                },
                firmwareTargetPolicy: view.firmwareTargetPolicy,
                firmwareInstall: {
                        method: view.installMethod,
                        artifactFileName: fileName(view.firmwarePath),
                        testedOrDocumented: view.routeConfirmed,
                        officialInstructionsUrl: view.instructionsUrl,
                        note: view.installNote,
                },
                legacyPatches:
                        view.boardPath === "legacyAbove4g" &&
                        view.legacyAnalysis &&
                        view.legacyAnalysisValid
                                ? {
                                          upstreamCommit:
                                                  view.legacyAnalysis.value
                                                          .upstreamCommit,
                                          catalogs: view.legacyAnalysis.value.catalogs
                                                  .filter((catalog) =>
                                                          view.selectedLegacyEntries.some(
                                                                  (entry) =>
                                                                          entry
                                                                                  .catalog
                                                                                  .catalog ===
                                                                          catalog.catalog,
                                                          ),
                                                  )
                                                  .map((catalog) => ({
                                                          catalog: catalog.catalog,
                                                          sourceSha256:
                                                                  catalog.sourceSha256,
                                                  })),
                                          selections: view.selectedLegacyEntries.map(
                                                  ({ catalog, rule }) => ({
                                                          catalog: catalog.catalog,
                                                          ruleId: rule.ruleId,
                                                          expectedMatches:
                                                                  rule.expectedMatches!,
                                                          requiredRisks:
                                                                  rule.requiredRisks,
                                                  }),
                                          ),
                                          acknowledgements:
                                                  view.selectedLegacyRisks.map(
                                                          (risk) => ({
                                                                  risk,
                                                                  note: `${risk} reviewed against ${view.firmware!.fileName} · SHA-256 ${view.firmware!.sha256}`,
                                                          }),
                                                  ),
                                  }
                                : undefined,
        };
};
