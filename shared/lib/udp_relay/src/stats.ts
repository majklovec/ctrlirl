/* Small stat-container helpers shared by both sides. */
import type { RelayStats, VifStats } from "./types";

export function newVifStats(): VifStats {
    return { txPackets: 0, txBytes: 0, rxPackets: 0, rxBytes: 0, txDropped: 0, rxDropped: 0 };
}

export function newRelayStats(): RelayStats {
    return {
        encRxPackets: 0,
        encRxBytes: 0,
        vifTxPackets: 0,
        vifTxBytes: 0,
        vifRxPackets: 0,
        vifRxBytes: 0,
        encTxPackets: 0,
        encTxBytes: 0,
        drops: 0,
    };
}

/** Record a non-fatal runtime error on a stats object (keeps the last one). */
export function noteError(
    stats: { lastError?: { at: number; message: string } },
    message: string,
): void {
    stats.lastError = { at: Date.now(), message };
}
