import type { CreateProfileRequest } from "./contract";
import type { DeploymentWorkspaceView } from "./session-contract";

const fileName = (path: string) => path.split(/[\\/]/).at(-1) || "firmware.bin";

export const buildMachineProfileRequest = (
        view: DeploymentWorkspaceView,
): CreateProfileRequest => {
        if (!view.firmware) {
                throw new Error(
                        "A firmware fingerprint is required to create a profile.",
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
                                                                  note: view.legacyAcknowledgements[
                                                                          risk
                                                                  ]!.note.trim(),
                                                          }),
                                                  ),
                                  }
                                : undefined,
        };
};
