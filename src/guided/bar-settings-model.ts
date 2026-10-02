import { pciTargetSizes, ruleForGpu, ruleMatchesGpu } from "../configuration-workspace/model";
import type { ConfigDraft, GpuDevice, GpuRule } from "../types";

/**
 * Pure helpers for the BAR settings screen. They mirror the lookup order in
 * nvstraps-core (`lookup_bar_size`): a sized location rule wins, then the last
 * sized subsystem rule, then the last sized device rule, then the global mode.
 * Validation and the actual write stay with Rust.
 */

/** Selector value nvstraps-core treats as "leave this GPU alone". */
export const EXCLUDED_SELECTOR = 254;

/** What the size select shows for one GPU: no explicit rule, excluded, or a size selector. */
export type GpuChoice = "auto" | "exclude" | number;

const sized = (rule: GpuRule) => rule.barSizeSelector !== null;
const isLocation = (rule: GpuRule) => rule.matchScope === "location";
const isSubsystem = (rule: GpuRule) => rule.matchScope === "subsystem";

/** The sized rule that decides this GPU's size, following the core's precedence. */
export const decidingRule = (draft: ConfigDraft, gpu: GpuDevice): GpuRule | null => {
        const matching = draft.rules.filter((rule) => sized(rule) && ruleMatchesGpu(rule, gpu));
        return (
                matching.find(isLocation) ??
                matching.filter(isSubsystem).at(-1) ??
                matching.filter((rule) => rule.matchScope === "device").at(-1) ??
                null
        );
};

export const gpuChoice = (draft: ConfigDraft, gpu: GpuDevice): GpuChoice => {
        const selector = decidingRule(draft, gpu)?.barSizeSelector ?? null;
        if (selector === null) return "auto";
        return selector >= EXCLUDED_SELECTOR ? "exclude" : selector;
};

/**
 * Sets one GPU's choice. A size or exclusion is written as a location rule for
 * that slot, which outranks broader rules. "auto" clears every sized rule that
 * matches the GPU, so the global mode decides again; a rule that also carries a
 * mask override keeps that override and loses only its size.
 */
export const applyGpuChoice = (draft: ConfigDraft, gpu: GpuDevice, choice: GpuChoice): ConfigDraft => {
        if (choice === "auto") {
                const rules = draft.rules.flatMap((rule) => {
                        if (!sized(rule) || !ruleMatchesGpu(rule, gpu)) return [rule];
                        return rule.overrideBarSizeMask === null ? [] : [{ ...rule, barSizeSelector: null }];
                });
                return { ...draft, rules };
        }
        const selector = choice === "exclude" ? EXCLUDED_SELECTOR : choice;
        const index = draft.rules.findIndex((rule) => isLocation(rule) && ruleMatchesGpu(rule, gpu));
        const rules =
                index >= 0
                        ? draft.rules.map((rule, current) => (current === index ? { ...rule, barSizeSelector: selector } : rule))
                        : [...draft.rules, { ...ruleForGpu(gpu), barSizeSelector: selector }];
        return { ...draft, rules };
};

/** Expansion is on when the global mode expands GPUs or any rule sets a size. */
export const expansionOn = (draft: ConfigDraft) =>
        draft.globalMode !== 0 || draft.rules.some((rule) => rule.barSizeSelector !== null && rule.barSizeSelector < EXCLUDED_SELECTOR);

/** Turning expansion off removes every rule; turning it on restores what was there, or the recommended mode. */
export const withExpansion = (draft: ConfigDraft, on: boolean, restore: Pick<ConfigDraft, "globalMode" | "rules"> | null): ConfigDraft => {
        if (!on) return { ...draft, globalMode: 0, rules: [] };
        if (restore && expansionOn({ ...draft, ...restore })) return { ...draft, ...restore };
        return { ...draft, globalMode: 2 };
};

/** Size text for a selector; values outside the table keep their number. */
export const sizeText = (selector: number) => pciTargetSizes[selector] ?? `#${selector}`;

/**
 * Selector the global mode gives this GPU when no rule decides, as the core
 * computes it: the listed size, then 2 GiB for other Turing GPUs in mode 2.
 * Null or the excluded value means the GPU is left alone.
 */
export const automaticSelector = (draft: ConfigDraft, gpu: GpuDevice): number | null => {
        if (draft.globalMode === 0) return null;
        if (gpu.registryBarSizeSelector !== null) return gpu.registryBarSizeSelector;
        return draft.globalMode === 2 && gpu.isTuring ? 5 : null;
};

/** True when the selector leaves the GPU at its default size. */
export const leavesAlone = (selector: number | null) => selector === null || selector >= EXCLUDED_SELECTOR;

/** Rules that match no GPU in this PC (kept from another configuration or an earlier GPU). */
export const otherRules = (draft: ConfigDraft, devices: GpuDevice[]) =>
        draft.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => !devices.some((gpu) => ruleMatchesGpu(rule, gpu)));

export const pciLocation = (value: Pick<GpuRule, "bus" | "device" | "function">) =>
        `${value.bus.toString(16).padStart(2, "0")}:${value.device.toString(16).padStart(2, "0")}.${value.function}`.toUpperCase();

export const shortGpuName = (name: string) => name.replace(/^NVIDIA (GeForce )?/, "");

export type ChangeItem =
        | { kind: "expansion"; on: boolean }
        | { kind: "gpu"; gpu: GpuDevice; from: GpuChoice; to: GpuChoice; fromDraft: ConfigDraft; toDraft: ConfigDraft }
        | { kind: "advanced" }
        | { kind: "otherRules" }
        | { kind: "settings" };

const advancedKeys = ["targetPciBarSize", "skipS3Resume", "overrideBarSizeMask", "guardSetupChanges"] as const;

/** What differs between the saved settings and the draft, in the order the screen lists it. */
export const changeItems = (baseline: ConfigDraft, draft: ConfigDraft, devices: GpuDevice[]): ChangeItem[] => {
        if (JSON.stringify(baseline) === JSON.stringify(draft)) return [];
        const items: ChangeItem[] = [];
        const before = expansionOn(baseline);
        const after = expansionOn(draft);
        if (before !== after) items.push({ kind: "expansion", on: after });
        if (after) {
                for (const gpu of devices.filter((device) => device.isTuring)) {
                        const from = gpuChoice(baseline, gpu);
                        const to = gpuChoice(draft, gpu);
                        const fromAuto = from === "auto" ? automaticSelector(baseline, gpu) : null;
                        const toAuto = to === "auto" ? automaticSelector(draft, gpu) : null;
                        if (from !== to || fromAuto !== toAuto) items.push({ kind: "gpu", gpu, from, to, fromDraft: baseline, toDraft: draft });
                }
        }
        const modeFlip = before && after && baseline.globalMode !== draft.globalMode;
        if (modeFlip || advancedKeys.some((key) => baseline[key] !== draft[key])) items.push({ kind: "advanced" });
        if (JSON.stringify(otherRules(baseline, devices).map(({ rule }) => rule)) !== JSON.stringify(otherRules(draft, devices).map(({ rule }) => rule)))
                items.push({ kind: "otherRules" });
        if (!items.length) items.push({ kind: "settings" });
        return items;
};
