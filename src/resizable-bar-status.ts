import type {
        ResizableBarApertureState,
        ResizableBarInspection,
        ResizableBarPatchConfiguration,
} from "./types";
import type { StaticMessageId } from "./i18n-catalog";

export type ResizableBarInspectionLoadState =
        | { status: "loading" }
        | { status: "ready"; inspection: ResizableBarInspection }
        | { status: "error" };

export type ResizableBarStatusPresentation = {
        tone: "loading" | "expanded" | "legacy" | "mixed" | "unavailable";
        headingId: StaticMessageId;
        aggregateSymbol: "MIX" | null;
        driverVersion: string | null;
        gpus: ResizableBarGpuPresentation[];
};

export type ResizableBarGpuPresentation = {
        gpu: ResizableBarInspection["gpus"][number];
        apertureId: StaticMessageId;
        patchStateId: StaticMessageId;
        patchTone: "available" | "unavailable" | "indeterminate" | "not-needed";
};

const apertureIds: Record<ResizableBarApertureState, StaticMessageId> = {
        expanded: "ui.apertureExpanded",
        legacy256MiB: "ui.apertureLegacy256Mib",
        indeterminate: "ui.apertureIndeterminate",
};

const patchPresentation: Record<
        ResizableBarPatchConfiguration["state"],
        Pick<ResizableBarGpuPresentation, "patchStateId" | "patchTone">
> = {
        notNeeded: {
                patchStateId: "ui.configurationNotNeeded",
                patchTone: "not-needed",
        },
        available: {
                patchStateId: "ui.patchConfigurationAvailable",
                patchTone: "available",
        },
        unavailable: {
                patchStateId: "ui.patchConfigurationUnavailable",
                patchTone: "unavailable",
        },
        indeterminate: {
                patchStateId: "ui.patchConfigurationIndeterminate",
                patchTone: "indeterminate",
        },
};

const presentGpu = (
        gpu: ResizableBarInspection["gpus"][number],
): ResizableBarGpuPresentation => ({
        gpu,
        apertureId: apertureIds[gpu.state],
        ...patchPresentation[gpu.patchConfiguration.state],
        ...(gpu.patchConfiguration.reasonCode === "registryExcluded" && {
                patchStateId: "ui.patchConfigurationRegistryExcluded" as const,
        }),
});

export function createRequestGenerationGuard() {
        let generation = 0;
        return {
                begin: () => ++generation,
                isCurrent: (candidate: number) => candidate === generation,
        };
}

export function presentResizableBarStatus(
        state: ResizableBarInspectionLoadState,
): ResizableBarStatusPresentation {
        if (state.status === "loading")
                return {
                        tone: "loading",
                        headingId: "ui.checkingResizableBar",
                        aggregateSymbol: null,
                        driverVersion: null,
                        gpus: [],
                };
        if (state.status === "error" || state.inspection.state === "indeterminate")
                return {
                        tone: "unavailable",
                        headingId: "ui.resizableBarStatusUnavailable",
                        aggregateSymbol: null,
                        driverVersion: null,
                        gpus:
                                state.status === "ready"
                                        ? state.inspection.gpus.map(presentGpu)
                                        : [],
                };
        if (
                state.inspection.gpus.length === 0 ||
                state.inspection.gpus.some(
                        (gpu) => gpu.bar1TotalBytes === null,
                )
        )
                return {
                        tone: "unavailable",
                        headingId: "ui.resizableBarStatusUnavailable",
                        aggregateSymbol: null,
                        driverVersion: null,
                        gpus: state.inspection.gpus.map(presentGpu),
                };
        if (state.inspection.state === "mixed")
                return {
                        tone: "mixed",
                        headingId: "ui.mixedResizableBarApertures",
                        aggregateSymbol: "MIX",
                        driverVersion: state.inspection.driverVersion,
                        gpus: state.inspection.gpus.map(presentGpu),
                };
        if (state.inspection.state === "legacy256MiB")
                return {
                        tone: "legacy",
                        headingId: "ui.bar1IsUsingThe256MibAperture",
                        aggregateSymbol: null,
                        driverVersion: state.inspection.driverVersion,
                        gpus: state.inspection.gpus.filter(
                                (gpu) => gpu.state === "legacy256MiB",
                        ).map(presentGpu),
                };
        return {
                tone: "expanded",
                headingId: "ui.resizableBarActive",
                aggregateSymbol: null,
                driverVersion: state.inspection.driverVersion,
                gpus: state.inspection.gpus.map(presentGpu),
        };
}

export function createResizableBarInspectionCoordinator(
        commit: (state: ResizableBarInspectionLoadState) => void,
) {
        const guard = createRequestGenerationGuard();
        return {
                async run(request: () => Promise<ResizableBarInspection>) {
                        const current = guard.begin();
                        commit({ status: "loading" });
                        try {
                                const inspection = await request();
                                if (guard.isCurrent(current))
                                        commit({ status: "ready", inspection });
                        } catch {
                                if (guard.isCurrent(current))
                                        commit({ status: "error" });
                        }
                },
        };
}
