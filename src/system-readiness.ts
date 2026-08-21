import type { SystemSnapshot } from "./types";

const FOUR_GIB = 4294967296n;

const parseAddress = (value: string): bigint | null => {
        try {
                return BigInt(value);
        } catch {
                return null;
        }
};

/**
 * Whether a GPU memory BAR is observed at or above the 4 GiB boundary. Windows
 * cannot read the BIOS "Above 4G Decoding" switch itself, but a BAR mapped
 * above 4 GiB is positive proof the decode window is open. The reverse is not
 * provable: small BARs fit below 4 GiB even with the switch on.
 */
export const above4gDecodingConfirmed = (snapshot: SystemSnapshot): boolean =>
        snapshot.devices.some((device) => {
                const top = parseAddress(device.bar0Top);
                return top !== null && top >= FOUR_GIB;
        });
