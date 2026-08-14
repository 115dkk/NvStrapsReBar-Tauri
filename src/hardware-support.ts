import type { SystemSnapshot } from "./types";

export const MSI_PRO_Z690_A_DDR4_CATALOG_ID =
        "msi-pro-z690-a-ddr4-ms-7d25";

export const usesMsiProZ690Route = (snapshot: SystemSnapshot) =>
        snapshot.hardwareSupport.motherboardNativeResizableBar.catalogId ===
        MSI_PRO_Z690_A_DDR4_CATALOG_ID;

export type MotherboardSupportPresentation = {
        label:
                | "Supported"
                | "Unsupported"
                | "Not in current support list"
                | "Motherboard identity unavailable";
        tone: "supported" | "unsupported" | "unknown";
        boardProduct: string | null;
};

export function presentMotherboardSupport(
        snapshot: SystemSnapshot,
): MotherboardSupportPresentation {
        const finding = snapshot.hardwareSupport.motherboardNativeResizableBar;
        const boardProduct = snapshot.machineIdentity?.boardProduct ?? null;
        if (finding.state === "supported")
                return { label: "Supported", tone: "supported", boardProduct };
        if (finding.state === "unsupported")
                return { label: "Unsupported", tone: "unsupported", boardProduct };
        if (finding.reasonCode === "motherboardNotInCatalog")
                return {
                        label: "Not in current support list",
                        tone: "unknown",
                        boardProduct,
                };
        return {
                label: "Motherboard identity unavailable",
                tone: "unknown",
                boardProduct: null,
        };
}
