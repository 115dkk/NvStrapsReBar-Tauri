import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDropEvent } from "./adapter";
import { useFirmwareDrop } from "./use-firmware-drop";

// Exercise subscription callbacks and cleanup without a browser or native webview.
const harness = vi.hoisted(() => ({
        effect: undefined as (() => void | (() => void)) | undefined,
        listener: undefined as ((event: FileDropEvent) => void) | undefined,
        over: false,
        busyAction: "",
        setOver: vi.fn(),
        unsubscribe: vi.fn(),
        setFirmwarePath: vi.fn(),
        inspectManualPath: vi.fn(),
        watchFileDrops: vi.fn(),
}));

vi.mock("react", () => ({
        useState: () => [harness.over, harness.setOver],
        useEffect: (effect: () => void | (() => void)) => { harness.effect = effect; },
        useEffectEvent: (callback: unknown) => callback,
}));
vi.mock("./context", () => ({
        useDeploymentWorkspaceController: () => ({
                getView: () => ({ busyAction: harness.busyAction }),
                watchFileDrops: harness.watchFileDrops,
                commands: {
                        setFirmwarePath: harness.setFirmwarePath,
                        inspectManualPath: harness.inspectManualPath,
                },
        }),
}));

const subscribe = () => {
        useFirmwareDrop(true);
        return harness.effect!();
};

describe("firmware drop subscription", () => {
        beforeEach(() => {
                vi.clearAllMocks();
                harness.over = false;
                harness.busyAction = "";
                harness.listener = undefined;
                harness.watchFileDrops.mockImplementation((listener: (event: FileDropEvent) => void) => {
                        harness.listener = listener;
                        return harness.unsubscribe;
                });
        });

        it("marks hover until leave or drop and reads exactly one dropped file", () => {
                subscribe();
                harness.listener!({ kind: "over" });
                expect(harness.setOver).toHaveBeenLastCalledWith(true);
                harness.listener!({ kind: "leave" });
                expect(harness.setOver).toHaveBeenLastCalledWith(false);
                harness.listener!({ kind: "drop", paths: ["/home/user/bios.bin"] });
                expect(harness.setOver).toHaveBeenLastCalledWith(false);
                expect(harness.setFirmwarePath).toHaveBeenCalledWith("/home/user/bios.bin");
                expect(harness.inspectManualPath).toHaveBeenCalledOnce();
                expect(harness.setFirmwarePath.mock.invocationCallOrder[0])
                        .toBeLessThan(harness.inspectManualPath.mock.invocationCallOrder[0]!);
        });

        it("ignores no paths, several paths, and a busy session", () => {
                subscribe();
                harness.listener!({ kind: "drop", paths: [] });
                harness.listener!({ kind: "drop", paths: ["/one.bin", "/two.bin"] });
                // Busy state is read at delivery, not captured when subscribing.
                harness.busyAction = "firmware";
                harness.listener!({ kind: "drop", paths: ["/one.bin"] });
                expect(harness.setFirmwarePath).not.toHaveBeenCalled();
                expect(harness.inspectManualPath).not.toHaveBeenCalled();
        });

        it("unsubscribes on cleanup and ignores late events", () => {
                const cleanup = subscribe();
                expect(cleanup).toBeTypeOf("function");
                cleanup!();
                harness.listener!({ kind: "drop", paths: ["/late.bin"] });
                expect(harness.unsubscribe).toHaveBeenCalledOnce();
                expect(harness.setFirmwarePath).not.toHaveBeenCalled();
        });

        it("does not subscribe or report hover while inactive", () => {
                harness.over = true;
                expect(useFirmwareDrop(false)).toEqual({ over: false });
                expect(harness.effect!()).toBeUndefined();
                expect(harness.watchFileDrops).not.toHaveBeenCalled();
                expect(harness.setOver).toHaveBeenCalledWith(false);
        });
});
