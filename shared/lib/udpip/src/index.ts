/*
 * @ctrlirl/udpip — Plain-UDP ↔ TUN IP-pump transport primitive (L3).
 *
 * One independent tunnel per relay uplink, each with its own /30 addressing,
 * so an encoder gets a `utn-<if>` virtual interface that provides full
 * Internet egress through that relay uplink. A small static Go binary
 * (`udpip`) owns the TUN data path; this module spawns / supervises that child
 * and programs the kernel around it (`ip`, `iptables`, `sysctl`) through the
 * `command.ts` runner seam so unit tests record the exact argv with no live
 * kernel. No crypto, no kernel module — acceptable on the trusted
 * relay↔encoder link (the relay pins a single peer).
 *
 * This is the sole transport primitive.
 */

// --- Command runner seam (`ip` / `iptables` / `sysctl`) ----------------------
export { runCommand, execCmd, setCmdRunner } from "./command";

// --- Tunnel / pump primitives ------------------------------------------------
export {
	tunSetupCommands,
	tunTeardownCommands,
	pumpArgs,
	setupTunnelVif,
	removeTunnelVif,
	setPumpSpawner,
	setPumpKiller,
	pumpPidForTest,
	firePumpExitForTest,
	adoptPumpsFromPidFiles,
	clearPumpRegistry,
	tunnelAddress,
	tunnelListenPort,
	tunnelRouteTable,
	ensureIpForward,
	ensureTunnelRelayEgress,
	revokeTunnelRelayEgress,
	ensureTunnelEncoderRouting,
	revokeTunnelEncoderRouting,
	IFACE_NAME_RE,
	DEFAULT_TUN_MTU,
	TUN_LISTEN_PORT_BASE,
	IPTABLES_BIN,
	SYSCTL_BIN,
	UDPIP_BIN,
	TUN_PID_FILE,
	TUN_LOG_FILE,
} from "./udpip";

export type {
	PumpOptions,
	PumpSpawner,
	PumpKiller,
	TunnelPumpHandle,
	TunnelVifSetupOpts,
} from "./udpip";
