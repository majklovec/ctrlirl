/*
 * @ctrlirl/udp-relay — the CtrLink relay's data-path surface.
 *
 * Re-homed from the former `@ctrlirl/gretap-relay` when the GRETAP L2 tunnel
 * was retired in favour of per-uplink WireGuard netdevs. What remains is the
 * transport-agnostic surface the relay module still uses: the per-uplink relay
 * handle, the raw-socket seam (test), IP framing helpers, and the stat/endpoint
 * types. There is no longer any GRETAP/GRE code here.
 */
import { networkInterfaces } from "node:os";

// --- Relay handle ------------------------------------------------------------
export { createUdpRelay } from "./relay";
export type { UdpRelay, UdpRelayOptions } from "./relay";

// --- Raw interface socket seam ------------------------------------------------
export { makeMockIfaceRawSocket } from "./net_linux";
export type { IfaceRawSocket, OpenIfaceRawSocketOptions } from "./net_linux";

// --- Interface helpers --------------------------------------------------------
export { IFACE_NAME_RE, resolveInterfaceAddress } from "./ifaces";

// --- IPv4 / UDP framing helpers ----------------------------------------------
export {
    buildUdpIpPacket,
    internetChecksum,
    ipToBytes,
    bytesToIp,
    ipDST,
    parseUdpPacket,
    udpChecksum,
    isValid,
    natPacketSource,
    natPacketDestination,
} from "./ip";
export type { BuildUdpIpPacketOptions, ParsedUdpPacket } from "./ip";

// --- Stat helpers -------------------------------------------------------------
export {
    newRelayStats,
    newVifStats,
    newStats,
    noteError,
} from "./stats";

// --- Types --------------------------------------------------------------------
export type {
    Endpoint,
    InterfaceInfo,
    Stats,
    RelayStats,
    VifStats,
} from "./types";

/**
 * List the machine's network interfaces with their IPv4 addresses
 * (diagnostics / tests).
 */
export function listInterfaces(): Array<{
    name: string;
    addresses: string[];
}> {
    const out: Array<{ name: string; addresses: string[] }> = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
        const ipv4 = (addrs ?? []).filter((a) => a.family === "IPv4")
            .map((a) => a.address);
        if (name) out.push({ name, addresses: [...ipv4].sort() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
