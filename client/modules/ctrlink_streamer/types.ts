/** CtrLink encoder-side (streamer) module types. Spec doc: TODO/100-ctrlink.md
 * §6, extended for the multi-relay / one-TUN-per-interface design (§6.3
 * extension).
 */
import type { CtrlinkDiscoveredRelay } from "../../../shared/ctrlink_discovery";

/** The module's persisted config (`state.data.ctrlinkStreamer`). The module
 * runs permanently on encoders (no `enabled` toggle). */
export interface CtrlinkStreamerConfig {
	/**
	 * Each TUN `relay{X}link{Y}` gets the local IP `10.{90+X}.{Y}.1` — derived
	 * from the relay ordinal X and the interface ordinal Y within that relay,
	 * so it is never a hand-typed base address.
	 */
	prefixLength: number;
	mtu: number;
	keepaliveIntervalMs: number;
	/** Register each TUN IP as a network uplink so srtla_send picks it up. */
	autoRegisterUplink: boolean;
	/**
	 * Build Layer-3 WireGuard virtual uplinks from the relay's `wg` offers
	 * (spec `TODO/wireguard.md`) — default **true**. When true each offered
	 * uplink becomes a `wg-<if>` vif with a per-vif routing table (SRTLA-ready).
	 * Endpoints with NO `wg` offer still use the legacy TUN path.
	 */
	wireGuard: boolean;
	runtimeStatusFile: string;
	logLevel: CtrlinkLogLevel;
	/**
	 * The encoder's WebSocket SERVER port (protocol.md §3: the encoder is the
	 * WS server, the relay dials in). Advertised to relays in the encoder
	 * announce as `ws_port`.
	 */
	wsPort: number;
	/**
	 * Optional auth token the relay must echo in the WS handshake
	 * (`?token=...`). Empty = open (LAN-internal; the relay learns it from
	 * the encoder announce).
	 */
	announceToken: string;
}

export type CtrlinkLogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** One TUN (one shared relay interface) in the runtime status. */
export interface CtrlinkStreamerTunnelStatus {
	interfaceName: string;
	interfaceAddress: string;
	relayHost: string;
	relayPort: number;
	uplinkRegistered: boolean;
	stats: { txPackets: number; rxPackets: number };
	lastError?: string;
}

/** One relay entry in the runtime status file (§9.1). */
export type CtrlinkStreamerRelayStatus = CtrlinkStreamerTunnelStatus;

/** The runtime status file's shape (output only, never a config store). */
export interface CtrlinkStreamerStatusFile {
	connected: boolean;
	relays: CtrlinkStreamerRelayStatus[];
}

/** Live status pushed to the card + returned by `ctrlink_streamer.status`. */
export interface CtrlinkStreamerRuntimeStatus {
	state: "idle" | "starting" | "running" | "error";
	running: boolean;
	/** The active TUNs (one per registered shared relay interface). */
	tunnels: CtrlinkStreamerTunnelStatus[];
	txPackets: number;
	rxPackets: number;
	txBytes: number;
	rxBytes: number;
	lastError?: string;
	/** How recently this encoder announced ITSELF so relays keep finding it
	 * (epoch ms; `undefined` when that path isn't running). Shown on the
	 * Network card, mirroring the relay card's self-announce line. */
	lastMdnsAnnounceAt?: number;
	lastUdpAnnounceAt?: number;
}

/** The device `status` view contribution for `modules["ctrlink_streamer"]`. */
export interface CtrlinkStreamerView {
	running: boolean;
	state: CtrlinkStreamerRuntimeStatus["state"];
	config: CtrlinkStreamerConfig;
	runtime: CtrlinkStreamerRuntimeStatus;
	/** Relays learned via UDP announce (their shared interfaces). */
	discoveredRelays: CtrlinkDiscoveredRelay[];
}
