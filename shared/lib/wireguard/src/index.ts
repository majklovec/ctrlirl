/*
 * @ctrlirl/wireguard — Layer-3 WireGuard transport primitive.
 *
 * One independent WireGuard tunnel per relay uplink, each with its own /30
 * addressing, so an encoder gets a `wg-<if>` virtual interface that provides
 * full Internet egress through that relay uplink. The kernel WireGuard module
 * owns the data path; this module only programs the kernel (`ip`, `wg`,
 * `modprobe`, `iptables`) through the `command.ts` runner seam so unit tests
 * record the exact argv with no live kernel.
 *
 * This is the sole transport primitive. The legacy L2 GRETAP / userspace-UDP
 * transports have been removed.
 */

// --- Command runner seam (`ip` / `wg` / `modprobe` / `iptables` / `sysctl`) ---
export { runCommand, execCmd, setCmdRunner } from "./command";

// --- WireGuard L3 tunnel primitives ------------------------------------------
export {
    wireGuardSetupCommands,
    wireGuardPeerCommand,
    wireGuardListenPortCommand,
    wireGuardTeardownCommands,
    ensureWireGuardModule,
    setupWireGuardInterface,
    setWireGuardListenPort,
    addWireGuardPeer,
    removeWireGuardPeer,
    removeWireGuard,
    wireGuardTunnelAddress,
    wgListenPort,
    wgRouteTable,
    ensureIpForward,
    ensureWireGuardRelayEgress,
    revokeWireGuardRelayEgress,
    ensureWireGuardEncoderRouting,
    revokeWireGuardEncoderRouting,
    generateWireGuardKeyPair,
    IFACE_NAME_RE,
    DEFAULT_WG_MTU,
    DEFAULT_WG_KEEPALIVE_SEC,
    WG_LISTEN_PORT_BASE,
    IPTABLES_BIN,
    SYSCTL_BIN,
} from "./wireguard";
