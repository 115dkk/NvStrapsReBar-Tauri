import { message, type MessageDescriptor } from "../i18n-catalog";
import type { ApiError, FirmwareInjectionDiagnostic } from "../types";

const errorText = (error: unknown) => {
        if (typeof error === "object" && error !== null) {
                const detail = (error as { message?: unknown }).message;
                if (typeof detail === "string" && detail) return detail;
        }
        return String(error);
};

const firmwareInjectionDiagnostic = (
        error: unknown,
): FirmwareInjectionDiagnostic | null => {
        if (typeof error !== "object" || error === null) return null;
        const candidate = error as Partial<ApiError>;
        if (
                candidate.code !== "firmware_injection_failed" ||
                typeof candidate.firmwareInjection !== "object" ||
                candidate.firmwareInjection === null
        )
                return null;
        return candidate.firmwareInjection as FirmwareInjectionDiagnostic;
};

const hasCapacityValues = (
        diagnostic:
                | Extract<
                          FirmwareInjectionDiagnostic,
                          { kind: "insufficientDxeSpace" }
                  >
                | Extract<
                          FirmwareInjectionDiagnostic,
                          { kind: "recompressedContainerTooLarge" }
                  >,
) =>
        typeof diagnostic.availableBytes === "number" &&
        Number.isFinite(diagnostic.availableBytes) &&
        typeof diagnostic.requiredBytes === "number" &&
        Number.isFinite(diagnostic.requiredBytes);

export const formatDeploymentError = (error: unknown): MessageDescriptor => {
        const fallback = () =>
                message("ui.deploymentOperationFailed", {
                        detail: errorText(error),
                });
        const diagnostic = firmwareInjectionDiagnostic(error);
        if (!diagnostic) return fallback();

        switch (diagnostic.kind) {
                case "invalidDriverFfs":
                        return message("ui.firmwareInjectionInvalidDriverFfs");
                case "invalidFirmware":
                        return message("ui.firmwareInjectionInvalidFirmware");
                case "driverAlreadyPresent":
                        return message(
                                "ui.firmwareInjectionDriverAlreadyPresent",
                        );
                case "compressionFailure":
                        return message(
                                "ui.firmwareInjectionCompressionFailure",
                        );
                case "unsupportedCapsule":
                        return message(
                                "ui.firmwareInjectionUnsupportedCapsule",
                        );
                case "malformedCapsule":
                        return message(
                                "ui.firmwareInjectionMalformedCapsule",
                        );
                case "ambiguousDxeTargets":
                        return message(
                                "ui.firmwareInjectionAmbiguousDxeTargets",
                        );
                case "incompleteDxeTargetCensus":
                        return message(
                                "ui.firmwareInjectionIncompleteDxeTargetCensus",
                        );
                case "unsupportedDxeTarget":
                        return message(
                                "ui.firmwareInjectionUnsupportedDxeTarget",
                        );
                case "noDxeVolume":
                        return message("ui.firmwareInjectionNoDxeVolume");
                case "insufficientDxeSpace":
                        return hasCapacityValues(diagnostic)
                                ? message(
                                          "ui.firmwareInjectionInsufficientDxeSpace",
                                          {
                                                  availableBytes:
                                                          diagnostic.availableBytes,
                                                  requiredBytes:
                                                          diagnostic.requiredBytes,
                                          },
                                  )
                                : fallback();
                case "recompressedContainerTooLarge":
                        return hasCapacityValues(diagnostic)
                                ? message(
                                          "ui.firmwareInjectionRecompressedContainerTooLarge",
                                          {
                                                  availableBytes:
                                                          diagnostic.availableBytes,
                                                  requiredBytes:
                                                          diagnostic.requiredBytes,
                                          },
                                  )
                                : fallback();
                default:
                        return fallback();
        }
};
