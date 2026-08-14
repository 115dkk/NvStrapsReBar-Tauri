import type { ResizableBarInspection } from "./types";

export type ResizableBarInspectionLoadState =
        | { status: "loading" }
        | { status: "ready"; inspection: ResizableBarInspection }
        | { status: "error" };

export type ResizableBarStatusPresentation = {
        tone: "loading" | "expanded" | "legacy" | "unavailable";
        heading:
                | "Checking Resizable BAR…"
                | "Resizable BAR active"
                | "BAR1 is using the 256 MiB aperture"
                | "Resizable BAR status unavailable";
        driverVersion: string | null;
        gpus: ResizableBarInspection["gpus"];
};

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
                        heading: "Checking Resizable BAR…",
                        driverVersion: null,
                        gpus: [],
                };
        if (state.status === "error" || state.inspection.state === "indeterminate")
                return {
                        tone: "unavailable",
                        heading: "Resizable BAR status unavailable",
                        driverVersion: null,
                        gpus: [],
                };
        if (
                state.inspection.gpus.length === 0 ||
                state.inspection.gpus.some(
                        (gpu) => gpu.bar1TotalBytes === null,
                )
        )
                return {
                        tone: "unavailable",
                        heading: "Resizable BAR status unavailable",
                        driverVersion: null,
                        gpus: [],
                };
        if (state.inspection.state === "legacy256MiB")
                return {
                        tone: "legacy",
                        heading: "BAR1 is using the 256 MiB aperture",
                        driverVersion: state.inspection.driverVersion,
                        gpus: state.inspection.gpus.filter(
                                (gpu) => gpu.state === "legacy256MiB",
                        ),
                };
        return {
                tone: "expanded",
                heading: "Resizable BAR active",
                driverVersion: state.inspection.driverVersion,
                gpus: state.inspection.gpus,
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
