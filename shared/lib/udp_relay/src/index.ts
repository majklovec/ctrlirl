/* @irlctrl/udp-relay - transport primitive public API (grows as modules land). */
import { networkInterfaces } from "node:os";

export type { DecodedFrame } from "./frame_types";
export type { BuildUdpIpPacketOptions, ParsedUdpPacket } from "./ip";
export {
    buildUdpIpPacket,
    bytesToIp,
    bytesToU32,
    internetChecksum,
    ipDST,
    ipToBytes,
    ipToU32,
    isIpv4,
    parseUdpPacket,
    u32ToIp,
    udpChecksum,
} from "./ip";
export type { LegPlan } from "./nat_rules";
export {
    applyLegPlan,
    applyVifPlan,
    LEG_TUN_NAME_RE,
    legTable,
    planLegBaseCommands,
    planLegCommands,
    planLegRemoval,
    planVifCommands,
    planVifRemoval,
    relayTunName,
    removeLegPlan,
    removeVifPlan,
    sweepStaleLegTuns,
} from "./nat_rules";
export {
    DATA_FRAME_TYPE,
    DATA_HEADER_LEN,
    decodeFrame,
    encodeDataFrame,
    encodeKeepaliveFrame,
    KEEPALIVE_FRAME_TYPE,
    sniffFrameKind,
    writeDataHeader,
} from "./protocol";
export type { VifSourceRoute } from "./vif_source_route";
export {
    applyVifSourceRoute,
    planVifSourceRoute,
    planVifSourceRouteRemoval,
    removeVifSourceRoute,
    VIF_SOURCE_RULE_PRIORITY,
    VIF_SOURCE_TABLE_BASE,
    VIF_SOURCE_TABLE_MAX_ORDINAL,
    vifSourceTable,
} from "./vif_source_route";
export type {
    EncoderDecision,
    RelaySocket,
    RelaySocketFactory,
    SocketEvent,
    UdpRelay,
    UdpRelayOptions,
} from "./relay";
export {
    bunRelaySocketFactory,
    createUdpRelay,
    decideEncoderFrame,
    resolveInterfaceAddress,
} from "./relay";
export type { TunDevice, TunFactory } from "./tun_linux";
export {
    configureTun,
    deleteTun,
    IFF_NO_PI,
    IFF_TUN,
    openTun,
    TUNSETIFF,
} from "./tun_linux";
export type {
    VirtualInterface,
    VirtualInterfaceOptions,
} from "./virtual_interface";
export { createVirtualInterface, makeMockTunDevice } from "./virtual_interface";
/**
 * List the machine's network interfaces with their IPv4 addresses. Library
 * tests use this; production callers use the `network` module's capability.
 */
export function listInterfaces(): Array<{
    name: string;
    addresses: string[];
}> {
    const out: Array<{ name: string; addresses: string[] }> = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
        const ipv4 = (addrs ?? [])
            .filter((a) => a.family === "IPv4")
            .map((a) => a.address);
        if (name) out.push({ name, addresses: [...ipv4].sort() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}
export type {
    CommandRunner,
    Endpoint,
    InterfaceInfo,
    RelayStats,
    VifStats,
} from "./types";
