import type { ConfigDraft, GpuDevice, GpuRule } from "../types";

export const hasOperationalConfiguration = (draft: ConfigDraft) =>
        draft.globalMode !== 0 ||
        draft.targetPciBarSize !== 0 ||
        draft.rules.length > 0;

export const pciTargetSizes = [
        "64 MiB",
        "128 MiB",
        "256 MiB",
        "512 MiB",
        "1 GiB",
        "2 GiB",
        "4 GiB",
        "8 GiB",
        "16 GiB",
        "32 GiB",
        "64 GiB",
];

export const hex = (value: number) =>
        value.toString(16).toUpperCase().padStart(4, "0");

export const formatBytes = (value: string) => {
        const bytes = Number(value);
        return bytes >= 1073741824
                ? `${(bytes / 1073741824).toFixed(bytes % 1073741824 ? 1 : 0)} GiB`
                : `${Math.round(bytes / 1048576)} MiB`;
};

export const ruleForGpu = (gpu: GpuDevice): GpuRule => ({
        matchScope: "location",
        deviceId: gpu.deviceId,
        subsystemVendorId: gpu.subsystemVendorId,
        subsystemDeviceId: gpu.subsystemDeviceId,
        bus: gpu.bus,
        device: gpu.device,
        function: gpu.function,
        barSizeSelector: gpu.recommendedBarSizeSelector,
        overrideBarSizeMask: null,
});

export const ruleMatchesGpu = (rule: GpuRule, gpu: GpuDevice) =>
        rule.deviceId === gpu.deviceId &&
        (rule.matchScope === "device" ||
                (rule.subsystemVendorId === gpu.subsystemVendorId &&
                        rule.subsystemDeviceId === gpu.subsystemDeviceId &&
                        (rule.matchScope === "subsystem" ||
                                (rule.bus === gpu.bus &&
                                        rule.device === gpu.device &&
                                        rule.function === gpu.function))));

export const formatPciSelector = (selector: number) => {
        const unit =
                selector < 10
                        ? "MiB"
                        : selector < 20
                          ? "GiB"
                          : selector < 30
                            ? "TiB"
                            : "PiB";
        return `${2 ** (selector % 10)} ${unit}`;
};
