/* Shared types for @irlctrl/udp-relay.
 *
 * The library is a transport primitive: it moves UDP payloads between a TUN on
 * one host and a bound UDP socket on another. It knows nothing about SRTLA,
 * Moblink, auth, discovery, or configuration.
 */

/** Shell command runner (Bun.$ in production, fakes in tests). */
export type CommandRunner = (
    cmd: string,
    ...args: string[]
) => { stdout: string; exitCode: number };

/** A network endpoint: a host (IP or resolvable name) and a UDP port. */
export interface Endpoint {
    host: string;
    port: number;
}

/** Stats of a virtual interface (encoder side). */
export interface VifStats {
    /** Packets forwarded out of the TUN toward the relay. */
    txPackets: number;
    txBytes: number;
    /** Packets written into the TUN from relay replies. */
    rxPackets: number;
    rxBytes: number;
    /** Packets dropped on the way out (non-IPv4, oversized, not running). */
    txDropped: number;
    /** Packets dropped on the way in (wrong source, malformed). */
    rxDropped: number;
    lastError?: { at: number; message: string };
    startedAt?: number;
}

/** Stats of a transparent L3 relay (relay-box side). */
export interface RelayStats {
    /** IP packets received from the encoder (over the wire-protocol UDP socket). */
    encRxPackets: number;
    encRxBytes: number;
    /** IP packets written into the relay TUN (toward the kernel/uplink). */
    vifTxPackets: number;
    vifTxBytes: number;
    /** IP packets delivered out of the relay TUN (replies from the uplink). */
    vifRxPackets: number;
    vifRxBytes: number;
    /** IP packets sent back toward the encoder (addressed to the vif IP). */
    encTxPackets: number;
    encTxBytes: number;
    /** Packets dropped (malformed frame, not addressed to the vif, oversized). */
    drops: number;
    lastError?: { at: number; message: string };
    /** Last time a frame from the encoder was seen (epoch ms). */
    lastEncoderSeen?: number;
    /** Source address of the most recent encoder frame. */
    lastEncoder?: string;
    startedAt?: number;
}

/** A network interface and its IPv4 addresses (for tests / diagnostics). */
export interface InterfaceInfo {
    name: string;
    addresses: string[];
}
