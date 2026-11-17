/* Shared stat/endpoint types for @ctrlirl/udp-relay.
 *
 * The library exposes the data-path surface (per-uplink relay handle, raw
 * socket seam, IP framing helpers, stat counters). It knows nothing about
 * SRTLA, Ctrlink, auth, discovery, or configuration.
 */

/**
 * Statistics counter bag. `drops` is the dropped-packets counter plus any
 * local drops the caller notes.
 */
export interface Stats {
    rxBytes: number;
    rxPackets: number;
    txBytes: number;
    txPackets: number;
    drops: number;
}

/** A network endpoint: a host (IP or resolvable name) and a UDP port. */
export interface Endpoint {
    host: string;
    port: number;
}

/**
 * Stats of a virtual interface (both tunnel sides).
 */
export interface VifStats {
    txPackets: number;
    txBytes: number;
    rxPackets: number;
    rxBytes: number;
    txDropped: number;
    rxDropped: number;
    drops: number;
    lastError?: { at: number; message: string };
    startedAt?: number;
}

/**
 * Stats of the relay-box side. The per-plane counters stay zero (the transport
 * is owned by the WireGuard netdevs); traffic shows on the tunnel counters
 * below.
 */
export interface RelayStats {
    encRxPackets: number;
    encRxBytes: number;
    ifaceTxPackets: number;
    ifaceTxBytes: number;
    ifaceRxPackets: number;
    ifaceRxBytes: number;
    encTxPackets: number;
    encTxBytes: number;
    drops: number;
    /** Tunnel counters (kernel) for the box's own tunnel side. */
    rxPackets: number;
    rxBytes: number;
    txPackets: number;
    txBytes: number;
    lastError?: { at: number; message: string };
    lastEncoderSeen?: number;
    startedAt?: number;
}

/** A network interface and its IPv4 addresses (for tests / diagnostics). */
export interface InterfaceInfo {
    name: string;
    addresses: string[];
}
