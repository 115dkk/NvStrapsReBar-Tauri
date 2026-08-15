import type { DeploymentAdapter } from "./adapter";
import type { FirmwareFingerprint } from "./contract";
import { firmwareFingerprintsMatch, legacyRuleKey } from "./session-projection";

export const selectAndInspectFirmware = async (adapter: DeploymentAdapter) => {
        const path = await adapter.selectFirmwareImage();
        if (!path) throw new Error("Firmware selection was cancelled.");
        return { path, firmware: await adapter.inspectFirmwareImage(path) };
};

export const inspectFirmware = async (
        adapter: DeploymentAdapter,
        path: string,
) => ({ path, firmware: await adapter.inspectFirmwareImage(path) });

export const analyzeLegacyFirmware = async (
        adapter: DeploymentAdapter,
        path: string,
        expectedFirmware: FirmwareFingerprint,
) => {
        const value = await adapter.analyzeLegacyFirmware(path);
        if (!firmwareFingerprintsMatch(value.firmware, expectedFirmware))
                throw new Error(
                        "The firmware fingerprint changed between inspection and analysis.",
                );
        return {
                value,
                selectedLegacyRules: value.catalogs.flatMap((catalog) =>
                        catalog.rules
                                .filter(
                                        (rule) =>
                                                rule.status === "applicable" &&
                                                rule.recommended,
                                )
                                .map((rule) =>
                                        legacyRuleKey(
                                                catalog.catalog,
                                                rule.ruleId,
                                        ),
                                ),
                ),
        };
};
