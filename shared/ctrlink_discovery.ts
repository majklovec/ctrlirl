/*
 * CtrLink discovery + control-channel protocol (spec 100-ctrlink §5 and
 * TODO/protocol.md). Two complementary discovery paths, both without a
 * control server:
 *
 * 1. Relay announce (relay → encoder, v1): the `ctrlink_relay` device PUSHES
 *    its shared tunnel interfaces to every encoder on the LAN by broadcasting
 *    a small JSON `CtrlinkAnnounce` over UDP to the limited-broadcast address
 *    on a fixed well-known port. The `ctrlink_streamer` (encoder) listens on
 *    that port, keeps a TTL'd registry of the relays it hears, and opens one
 *    TUN per shared interface (spec §6.3 multi-relay extension).
 *
 * 2. Encoder announce (encoder → relay, protocol.md §2): the encoder
 *    broadcasts a JSON `CtrlinkEncoderAnnounce` on the same well-known port
 *    carrying its id, IP, WebSocket port and optional auth token. The relay
 *    listens on that port, keeps a TTL'd registry of the encoders it hears,
 *    and dials each one's WebSocket.
 *
 * 3. Relay → encoder control channel (protocol.md §3–§5): the ENCODER runs a
 *    WebSocket server; the RELAY connects to it as a client and sends its
 *    identity, protocol version and the full list of uplink interfaces with
 *    their UDP ports. Interface changes are propagated as events
 *    (`interface_added` / `interface_removed` / `interface_up` /
 *    `interface_down`); after every reconnect the relay re-sends a full
 *    snapshot. The encoder dials `interface_ip:udp_port` (protocol.md §5).
 *
 * The ports and message bodies are shared here so both sides can never drift
 * apart.
 */

/** Fixed UDP port encoders listen on / relays broadcast to. */
export const CTRLINK_DISCOVERY_PORT = 10_333;

/** Relay re-broadcast interval — frequent enough that a relay appearing/moving
 * converges quickly; cheap enough to send every few seconds. */
export const CTRLINK_ANNOUNCE_INTERVAL_MS = 5_000;

/** Drop a registered relay not re-announced within this window (~3× interval). */
export const CTRLINK_ANNOUNCE_TTL_MS = 15_000;

/** Limited-broadcast destination for the announce datagrams. */
export const CTRLINK_BROADCAST_ADDR = "255.255.255.255";

/**
 * Name pattern of an ENCODER-side CtrLink tunnel interface (the
 * `ctrlink_streamer` names them `m${slot}_${relayIface}`, e.g. `m0_wg0`).
 * Pre-GRETAP these were TUNs (`relay0_wg0`, 15-char limit); after the cutover
 * the kernel device is `gretap<name>` (e.g. `gretapm0_wg0`). Both shapes are
 * tunnels to a relay's shared uplink, not the machine's own interfaces, so any
 * interface listing that means "the device's real interfaces" (the network
 * card's "Own interfaces" group, relay eligibility) must exclude them. This is
 * the single source of truth shared by the `network` backend
 * (`listNetworkInterfaces`) and the network card.
 */
export const CTRLINK_TUN_NAME_RE =
	/^(?:relay|gretapm)\d+_[a-z0-9]+$/u;

/** True when `name` is an encoder-side CtrLink tunnel TUN (see the RE above). */
export const isCtrlinkTun = (name: string): boolean =>
	CTRLINK_TUN_NAME_RE.test(name);

/** One tunnel interface the relay offers to encoders. */
export interface CtrlinkSharedEndpoint {
	/** The relay-side TUN name (e.g. `ctrlink0`). */
	name: string;
	/** The relay's advertise IP (relayHost) the encoder dials for this tunnel
	 * (the advertise IP override if set, else the auto-detected LAN address) —
	 * not necessarily the IP of the interface the relay binds to. */
	address: string;
	/** The UDP relay port for this interface. */
	listenPort: number;
	/** Path state (protocol.md §4/§5): `down` = the encoder must stop using
	 * this path (the port mapping is kept on the relay); `up`/absent = usable. */
	state?: "up" | "down";
	/**
	 * The relay's ON-PATH IP the encoder must address GRETAP outer headers at
	 * for a frame on this interface (GRETAP exposure, `GRETAP-RESEARCH.md`).
	 * Absent when the encoder reaches this interface directly on-link — then
	 * it is a plain uplink, not a tunnel.
	 */
	outer_ip?: string;
	/** The exposed subnet's prefix length (GRETAP exposure); default /24. */
	prefix?: number;
}

/** The discoverable payload a relay broadcasts. */
export interface CtrlinkAnnounce {
	/** Protocol version — receivers ignore unknown versions. */
	v: 1;
	/** The relay's primary LAN address (stable identity + dial host). */
	host: string;
	/** The relay's hostname, for display. */
	hostname?: string;
	/** The shared tunnel interfaces this relay offers. */
	interfaces: CtrlinkSharedEndpoint[];
	/** Epoch ms the relay sent this. */
	ts: number;
}

/** A relay entry in the encoder's registry (an announce we've seen, TTL'd). */
export interface CtrlinkDiscoveredRelay {
	/** The relay address — registry key. */
	host: string;
	hostname?: string;
	interfaces: CtrlinkSharedEndpoint[];
	/** Epoch ms we last heard from this relay. */
	lastSeen: number;
}

/**
 * Type-guard for an announce parsed out of a UDP datagram. Filters out random
 * traffic on the discovery port (anything that isn't our `{v:1, host,
 * interfaces: [...]}` shape).
 */
export function isCtrlinkAnnounce(x: unknown): x is CtrlinkAnnounce {
	if (!x || typeof x !== "object") return false;
	const o = x as Record<string, unknown>;
	if (o.v !== 1) return false;
	if (typeof o.host !== "string" || o.host.length === 0) return false;
	if (!Array.isArray(o.interfaces)) return false;
	return (o.interfaces as unknown[]).every((e) => {
		if (!e || typeof e !== "object") return false;
		const ep = e as Record<string, unknown>;
		return (
			typeof ep.name === "string" &&
			typeof ep.address === "string" &&
			typeof ep.listenPort === "number"
		);
	});
}

// ----------------------------------------------------------------------
// Encoder announce (encoder → relay, protocol.md §2)
// ----------------------------------------------------------------------

/** The encoder announce protocol version (receivers ignore unknown versions). */
export const CTRLINK_ENCODER_ANNOUNCE_VERSION = 1;

/**
 * The discoverable payload an encoder broadcasts on the discovery port so
 * relays learn its WebSocket endpoint (protocol.md §2).
 */
export interface CtrlinkEncoderAnnounce {
	/** Protocol version — receivers ignore unknown versions. */
	v: typeof CTRLINK_ENCODER_ANNOUNCE_VERSION;
	/** Stable encoder identity (e.g. the hostname). */
	encoder_id: string;
	/** The encoder IP address (reachable across the LAN). */
	ip: string;
	/** The encoder's WebSocket server port. */
	ws_port: number;
	/** Protocol version (the relay sends the same in its WS hello). */
	proto: number;
	/** Optional auth token the relay must echo in the WS handshake. */
	token?: string;
	/** Epoch ms the encoder sent this. */
	ts: number;
}

/** A discovery path by which the relay learned an encoder (protocol.md
 * §2): the UDP-announce listener on the well-known port, the mDNS
 * encoder-service browser, or the control-server lookup. Not sent on the
 * wire — the relay derives it locally from which listener recorded the
 * entry. */
export type CtrlinkDiscoveryMethod = "udp" | "mdns" | "control-server";

/** An encoder entry in the relay's TTL'd registry (an announce we've seen). */
export interface CtrlinkDiscoveredEncoder {
	encoderId: string;
	ip: string;
	wsPort: number;
	proto: number;
	token?: string;
	/** Last observation per discovery path (epoch ms). The card renders a
	 * per-protocol "discovered … ago" line from these stamps. The WS
	 * keepalive does NOT add to this map (it only refreshes `lastSeen`),
	 * so the line stays honest about which path (re)announced the encoder
	 * and when — even when only the live channel keeps the entry alive. */
	discoveredAt: Partial<Record<CtrlinkDiscoveryMethod, number>>;
	/** Epoch ms we last heard from this encoder. */
	lastSeen: number;
}

/**
 * Type-guard for an encoder announce parsed out of a UDP datagram. Filters
 * out random traffic on the discovery port (anything that is not our
 * `{v:1, encoder_id, ip, ws_port, proto}` shape). Relay announces
 * (`{v:1, host, interfaces}`) are rejected: they have no `encoder_id`.
 */
export function isCtrlinkEncoderAnnounce(
	x: unknown,
): x is CtrlinkEncoderAnnounce {
	if (!x || typeof x !== "object") return false;
	const o = x as Record<string, unknown>;
	if (o.v !== CTRLINK_ENCODER_ANNOUNCE_VERSION) return false;
	if (typeof o.encoder_id !== "string" || o.encoder_id.length === 0)
		return false;
	if (typeof o.ip !== "string" || o.ip.length === 0) return false;
	if (typeof o.ws_port !== "number") return false;
	if (typeof o.proto !== "number") return false;
	if (o.token !== undefined && typeof o.token !== "string") return false;
	return true;
}

// ----------------------------------------------------------------------
// Relay → encoder control channel (protocol.md §3–§5)
// ----------------------------------------------------------------------

/** The relay → encoder control-channel protocol version (the WS hello). */
export const CTRLINK_RELAY_WS_PROTOCOL = 1;

/**
 * The Layer-3 WireGuard spec for ONE relay uplink, carried to the encoder so
 * it can build the matching `wg-<if>` virtual interface (spec TODO/wireguard.md
 * §4/§5/§8/§16). Present on `CtrlinkRelayIface.wg` when the relay is offering
 * its uplinks as WireGuard tunnels; absent in the legacy GRETAP mode.
 *
 * Addressing is a per-tunnel /30: the relay owns `<localAddr>` and the encoder
 * is told its `<peerAddr>` (e.g. relay `10.200.1.1/30`, encoder `10.200.1.2/30`).
 * The relay's AllowedIPs on this side is ONLY its tunnel peer (the /30) — it
 * never installs a default route via the WG netdev (egress is policy+routed
 * on the relay). The encoder's AllowedIPs is `0.0.0.0/0` so Internet exits the
 * tunnel.
 */
export interface CtrlinkRelayWgSpec {
	/** The virtual interface name the encoder must create (e.g. `wg-eth0`). */
	virtualInterface: string;
	/** The relay's WireGuard PUBLIC key for this tunnel — the encoder adds it
	 * as the peer on its matching netdev. (Private keys never leave the host.) */
	publicKey: string;
	/** The relay's outer endpoint on the dedicated relay↔encoder link
	 * (e.g. `192.168.10.100`) the encoder sends WG UDP to. */
	endpoint: string;
	/** The relay's WG UDP listen port for THIS tunnel (distinct per uplink). */
	udpPort: number;
	/** The relay's tunnel IP, e.g. `10.200.1.1`. */
	localAddr: string;
	/** The encoder's tunnel IP, e.g. `10.200.1.2`. */
	peerAddr: string;
	/** The /30 prefix length (default `30`). */
	prefix: number;
	/** 0-based stable uplink index (relay-assigned) the encoder uses to pick
	 * its per-vif routing table number (spec §8: table `100 + index + 1`). */
	uplinkIndex: number;
	/** Netdev MTU (cellular-friendly `1360`). */
	mtu: number;
	/** Persistent keepalive in seconds (cellular NAT pin; `25`). */
	keepaliveSec: number;
}

/** One relay uplink interface as the relay reports it to an encoder. */
export interface CtrlinkRelayIface {
	/** Relay interface name, e.g. `eth0`. */
	iface_name: string;
	/** The IP of the relay interface the encoder should use to reach it. */
	ip: string;
	/** The UDP relay port for this interface. */
	udp_port: number;
	/** `up` = usable path; `down` = marked down (port mapping kept). */
	state: "up" | "down";
	uplink: true;
	/**
	 * The relay's **on-path** source IP for THIS encoder — the address of the
	 * relay interface the kernel uses to reach the encoder (`ip route get
	 * <enc.ip>`). The encoder's GRETAP `remote` MUST be this; the advertised
	 * `ip` above is the pass-through-LAN identity (GRE key material), which
	 * the encoder's kernel usually cannot route to. Absent for direct on-link
	 * paths and legacy relays.
	 */
	outer_ip?: string;
	/** Prefix length of this relay interface's subnet (e.g. `24`). */
	prefix?: number;
	/**
	 * Layer-3 WireGuard offer for this uplink (spec TODO/wireguard.md). When
	 * present the encoder builds a `wg-<if>` virtual interface from it instead
	 * of a GRETAP L2 bridge. Absent in GRETAP mode / for legacy relays.
	 */
	wg?: CtrlinkRelayWgSpec;
}

/** A relay → encoder control-channel message (protocol.md §3–§4). */
export type CtrlinkRelayWsMessage =
	/** Relay identity + protocol version + full interface list. Sent on
	 * connect AND after every reconnect (the "full snapshot"). */
	| {
			type: "hello";
			relay_id: string;
			proto: number;
			interfaces: CtrlinkRelayIface[];
	  }
	| { type: "interface_added"; iface: CtrlinkRelayIface }
	| { type: "interface_removed"; iface: CtrlinkRelayIface }
	| { type: "interface_up"; iface: CtrlinkRelayIface }
	| { type: "interface_down"; iface: CtrlinkRelayIface }
	/** ENCODER → RELAY (spec TODO/wireguard.md): the encoder's WireGuard
	 * PUBLIC key, sent on (re)connect after the relay's `hello`. The relay
	 * needs it to add the encoder as the peer on the RELAY side of each
	 * `wg-<if>` tunnel (the relay already knows the encoder's on-path end-
	 * point from discovery, so no endpoint is needed here). Private keys
	 * never cross the wire. */
	| {
			type: "encoder_wg_key";
			encoder_id: string;
			/** One entry per uplink the encoder has a WireGuard netdev
			 * (`wg-<uplink>`) for: the encoder's public key and the UDP port
			 * that netdev listens on. The relay dials `<encoder link ip>:
			 * <listen_port>` for each. */
			public_keys: {
				uplink: string;
				public_key: string;
				listen_port: number;
			}[];
	  }
	/** WS keepalive (protocol.md §3): relay → encoder every 5 s while the
	 * channel is open; the encoder replies `pong`. Every message in both
	 * directions refreshes the peer's discovery-registry TTL, so a live
	 * channel is self-sustaining and discovery is only needed for the
	 * initial dial. */
	| { type: "ping" }
	| { type: "pong" };

/** The event types that apply to a single interface (no hello/keepalive). */
export type CtrlinkRelayIfaceEventType = Exclude<
	CtrlinkRelayWsMessage["type"],
	"hello" | "ping" | "pong"
>;

/** Type-guard for a parsed relay → encoder control-channel message. */
export function isCtrlinkRelayWsMessage(
	x: unknown,
): x is CtrlinkRelayWsMessage {
	if (!x || typeof x !== "object") return false;
	const o = x as Record<string, unknown>;
	const okWg = (w: unknown): boolean => {
		if (!w || typeof w !== "object") return false;
		const g = w as Record<string, unknown>;
		return (
			typeof g.virtualInterface === "string" &&
			g.virtualInterface.length > 0 &&
			typeof g.publicKey === "string" &&
			g.publicKey.length > 0 &&
			typeof g.endpoint === "string" &&
			typeof g.udpPort === "number" &&
			typeof g.localAddr === "string" &&
			typeof g.peerAddr === "string" &&
			typeof g.prefix === "number" &&
			typeof g.mtu === "number" &&
			typeof g.keepaliveSec === "number" &&
			typeof g.uplinkIndex === "number"
		);
	};
	const okIface = (i: unknown): boolean => {
		if (!i || typeof i !== "object") return false;
		const f = i as Record<string, unknown>;
		return (
			typeof f.iface_name === "string" &&
			f.iface_name.length > 0 &&
			typeof f.ip === "string" &&
			typeof f.udp_port === "number" &&
			(f.state === "up" || f.state === "down") &&
			f.uplink === true &&
			(f.wg === undefined || okWg(f.wg))
		);
	};
	switch (o.type) {
		case "hello":
			return (
				typeof o.relay_id === "string" &&
				o.relay_id.length > 0 &&
				typeof o.proto === "number" &&
				Array.isArray(o.interfaces) &&
				(o.interfaces as unknown[]).every(okIface)
			);
		case "interface_added":
		case "interface_removed":
		case "interface_up":
		case "interface_down":
			return okIface(o.iface);
		case "encoder_wg_key":
			return (
				typeof o.encoder_id === "string" &&
				o.encoder_id.length > 0 &&
				typeof o.public_keys === "object" &&
				o.public_keys !== null &&
				Array.isArray(o.public_keys) &&
				o.public_keys.every(
					(k: unknown) =>
						typeof k === "object" &&
						k !== null &&
						typeof (k as Record<string, unknown>).uplink === "string" &&
						typeof (k as Record<string, unknown>).public_key === "string" &&
						typeof (k as Record<string, unknown>).listen_port === "number",
				)
			);
		case "ping":
		case "pong":
			return true;
		default:
			return false;
	}
}
